'use strict';

// ClearDMR Web CPS — Read from Radio via USB CDC (normal operating mode)
//
// The firmware exposes a proprietary CDC protocol when running normally.
// USB VID/PID: 0x1FC9 / 0x0094 (set in usbd_desc.c)
//
// Request packet (8 bytes):
//   [0]    'R' (0x52)
//   [1]    area: 1=SPI Flash, 2=EEPROM (EEPROM aliases to SPI Flash at offset 0 for MDUV380)
//   [2..5] address (big-endian uint32)
//   [6..7] length  (big-endian uint16, max 2045)
//
// Response on success: ['R', len_hi, len_lo, data...]
// Response on error:   ['-']
//
// Codeplug file layout (128 KB) and read strategy:
//
//   file[0x00000..0x07FFF]  → EEPROM lower half  (CPS_ACCESS_EEPROM, hw addr = file addr)
//                             Channels, general settings, channel bitmap live here.
//                             Most radios expose this via area=2, but some boundary
//                             chunks may need area=1 fallback.
//
//   file[0x08000..0x0FFFF]  → EEPROM upper half  (hw addr = file addr)
//                             Zone bitmap and zone list live here.
//                             Access mode varies by radio, so we probe both area=2
//                             and area=1 at the known zone offsets and use whichever
//                             mode succeeds for this radio, with per-chunk fallback.
//
//   file[0x10000..0x1FFFF]  → SPI Flash region (CPS_ACCESS_FLASH, hw addr = file addr + 0x90000)
//                             Contacts, RX groups live here.
//                             0x90000 = FLASH_ADDRESS_OFFSET(0x20000) + 0x70000 (codeplug.h)
//                             CONTACTS: hw 0x20000 + 0x87620 = 0xA7620 → file 0x17620  ✓

const CPRD_SERIAL_FILTERS = [{ usbVendorId: 0x1FC9, usbProductId: 0x0094 }];

const CPRD_AREA_EEPROM    = 2;
const CPRD_AREA_FLASH     = 1;
const CPRD_CHUNK          = 1024;       // bytes per request (firmware cap: 2045)
const CPRD_FILE_SIZE      = 0x20000;    // 128 KB
const CPRD_HALF           = CPRD_FILE_SIZE >>> 1;   // 64 KB per region
const CPRD_QUARTER        = CPRD_HALF  >>> 1;       // 32 KB — EEPROM alias boundary
const CPRD_MAX_RETRIES    = 2;          // retry transient chunk failures before giving up
const CPRD_PROBE_LEN      = 32;

// SPI Flash hw base address for the third (SPI Flash) region.
// = file offset 0x10000 + FLASH_ADDRESS_OFFSET(0x20000) + 0x70000 = 0xA0000
const CPRD_FLASH_HW_BASE  = 0xA0000;

const CPRD_LOWER_BOUNDARY_OFFSET = 0x07C00;
const CPRD_ZONE_BITMAP_OFFSET = 0x8010;
const CPRD_ZONE_LIST_OFFSET   = 0x8030;
const CPRD_ZONE_FMT_OFFSET    = 0x806F;
const CPRD_REF_ZONE_BITMAP_PREFIX = new Uint8Array([0x3F, 0x00]);
const CPRD_REF_ZONE0_NAME         = new Uint8Array([0x41, 0x6E, 0x61, 0x6C, 0x6F, 0x67]); // "Analog"
const CPRD_REF_ZONE0_REFS_PREFIX  = new Uint8Array([0x01, 0x00, 0x35, 0x00, 0x02, 0x00, 0x03, 0x00]);
const CPRD_REF_ZONE_PROBE         = 0x00;

// Accumulate bytes from the Web Serial readable stream, preserving leftover bytes
// across reads so USB packet boundaries never split a logical response.
class SerialAccumulator {
  constructor(reader) {
    this._reader  = reader;
    this._pending = new Uint8Array(0);
  }

  async readExact(n) {
    while (this._pending.length < n) {
      const { value, done } = await this._reader.read();
      if (done) throw new Error('Serial port closed unexpectedly.');
      const chunk = value instanceof Uint8Array
        ? value
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      const merged = new Uint8Array(this._pending.length + chunk.length);
      merged.set(this._pending, 0);
      merged.set(chunk, this._pending.length);
      this._pending = merged;
    }
    const out      = this._pending.slice(0, n);
    this._pending  = this._pending.slice(n);
    return out;
  }

  releaseLock() { this._reader.releaseLock(); }
}

// Send one CPS 'R' request; return the data bytes or null on a device error response.
async function cprdRequest(writer, acc, areaType, hwAddr, length) {
  const req = new Uint8Array(8);
  req[0] = 0x52; // 'R'
  req[1] = areaType;
  req[2] = (hwAddr >>> 24) & 0xFF;
  req[3] = (hwAddr >>> 16) & 0xFF;
  req[4] = (hwAddr >>>  8) & 0xFF;
  req[5] =  hwAddr         & 0xFF;
  req[6] = (length >>>  8) & 0xFF;
  req[7] =  length         & 0xFF;
  await writer.write(req);

  const status = await acc.readExact(1);
  if (status[0] !== 0x52) return null;  // '-' = device error for this chunk
  const lenBytes = await acc.readExact(2);
  const respLen  = (lenBytes[0] << 8) | lenBytes[1];
  return acc.readExact(respLen);
}

function cprdHexSlice(fileBuf, offset, length) {
  return Array.from(fileBuf.subarray(offset, offset + length), b =>
    b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

function cprdHexData(data, maxLen) {
  if (!data) return null;
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return Array.from(bytes.subarray(0, maxLen), b =>
    b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

function cprdAsciiData(data, maxLen) {
  if (!data) return null;
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return Array.from(bytes.subarray(0, maxLen), b =>
    (b >= 32 && b <= 126) ? String.fromCharCode(b) : '.').join('');
}

function cprdStartsWith(data, expected, offset = 0) {
  if (!data || data.length < offset + expected.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (data[offset + i] !== expected[i]) return false;
  }
  return true;
}

function cprdIsPrintableZoneName(nameBytes) {
  let seenPadding = false;
  let seenText = false;
  for (const b of nameBytes) {
    if (b === 0xFF || b === 0x00) {
      seenPadding = true;
      continue;
    }
    if (seenPadding) return false;
    if (b < 0x20 || b > 0x7E) return false;
    seenText = true;
  }
  return seenText;
}

function cprdIsPlausibleZoneProbeByte(byte) {
  return byte === 0xFF || byte <= 0x04 || (byte >= 0x20 && byte <= 0x7E);
}

function cprdAssessZoneProbe(offset, data) {
  if (!data) return { score: 0, details: { ok: false } };

  if (offset === CPRD_ZONE_BITMAP_OFFSET) {
    const allFF = data.every(b => b === 0xFF);
    const anySet = data.some(b => b !== 0x00 && b !== 0xFF);
    return {
      score: allFF ? 0 : (anySet ? 2 : 1),
      details: {
        ok: true,
        allFF,
        anySet,
        live: cprdHexData(data, Math.min(data.length, 16)),
      },
    };
  }

  if (offset === CPRD_ZONE_LIST_OFFSET) {
    const nameBytes = data.subarray(0, 16);
    const namePlausible = cprdIsPrintableZoneName(nameBytes);
    let saneRefs = 0;
    let implausibleRefs = 0;
    for (let i = 16; i + 1 < Math.min(data.length, 32); i += 2) {
      const ref = data[i] | (data[i + 1] << 8);
      if (ref === 0 || ref === 0xFFFF || (ref >= 1 && ref <= 1024)) saneRefs++;
      else implausibleRefs++;
    }
    return {
      score: (namePlausible ? 2 : 0) + Math.min(saneRefs, 2) - Math.min(implausibleRefs, 2),
      details: {
        ok: true,
        namePlausible,
        saneRefs,
        implausibleRefs,
        liveNameHex: cprdHexData(nameBytes, 16),
        liveNameAscii: cprdAsciiData(nameBytes, 16),
        liveRefs: cprdHexData(data.subarray(16, 24), 8),
      },
    };
  }

  if (offset === CPRD_ZONE_FMT_OFFSET) {
    const probePlausible = data.length > 0 && cprdIsPlausibleZoneProbeByte(data[0]);
    return {
      score: probePlausible ? 1 : 0,
      details: {
        ok: true,
        probePlausible,
        live: cprdHexData(data, 1),
      },
    };
  }

  return { score: 0, details: { ok: true } };
}

function cprdCompareZoneProbeToReference(offset, data) {
  if (!data) return { score: 0, details: { ok: false } };

  if (offset === CPRD_ZONE_BITMAP_OFFSET) {
    const bitmapPrefixMatches = cprdStartsWith(data, CPRD_REF_ZONE_BITMAP_PREFIX);
    return {
      score: bitmapPrefixMatches ? 2 : 0,
      details: {
        ok: true,
        bitmapPrefixMatches,
        live: cprdHexData(data, Math.min(data.length, 16)),
        reference: cprdHexData(CPRD_REF_ZONE_BITMAP_PREFIX, CPRD_REF_ZONE_BITMAP_PREFIX.length),
      },
    };
  }

  if (offset === CPRD_ZONE_LIST_OFFSET) {
    const nameMatches = cprdStartsWith(data, CPRD_REF_ZONE0_NAME);
    const refsMatch   = cprdStartsWith(data, CPRD_REF_ZONE0_REFS_PREFIX, 16);
    return {
      score: (nameMatches ? 2 : 0) + (refsMatch ? 2 : 0),
      details: {
        ok: true,
        nameMatches,
        refsMatch,
        liveNameHex: cprdHexData(data.subarray(0, 16), 16),
        liveNameAscii: cprdAsciiData(data.subarray(0, 16), 16),
        liveRefs: cprdHexData(data.subarray(16, 24), 8),
        referenceNameAscii: 'Analog',
        referenceRefs: cprdHexData(CPRD_REF_ZONE0_REFS_PREFIX, CPRD_REF_ZONE0_REFS_PREFIX.length),
      },
    };
  }

  if (offset === CPRD_ZONE_FMT_OFFSET) {
    const probeMatches = data.length > 0 && data[0] === CPRD_REF_ZONE_PROBE;
    return {
      score: probeMatches ? 1 : 0,
      details: {
        ok: true,
        probeMatches,
        live: cprdHexData(data, 1),
        reference: '00',
      },
    };
  }

  return { score: 0, details: { ok: true } };
}

async function cprdTryRead(writer, acc, areaType, hwAddr, length, context) {
  for (let attempt = 0; attempt <= CPRD_MAX_RETRIES; attempt++) {
    const data = await cprdRequest(writer, acc, areaType, hwAddr, length);
    if (data) return data.subarray(0, length);
    console.debug('[cpwrReadCodeplug] chunk read failed', {
      context,
      area: areaType,
      attempt: attempt + 1,
      hwAddr: '0x' + hwAddr.toString(16).toUpperCase().padStart(5, '0'),
      length,
    });
  }
  return null;
}

async function cprdProbeAccess(writer, acc, areaType, hwAddr, length, label) {
  const data = await cprdTryRead(writer, acc, areaType, hwAddr, length, `probe ${label}`);
  return { ok: !!data, data };
}

async function cprdChooseZoneArea(writer, acc) {
  const probes = [
    { offset: CPRD_ZONE_BITMAP_OFFSET, length: 32, label: 'bitmap_0x8010' },
    { offset: CPRD_ZONE_LIST_OFFSET,   length: 32, label: 'zone0_0x8030'  },
    { offset: CPRD_ZONE_FMT_OFFSET,    length: 1,  label: 'probe_0x806F'  },
  ];
  const results = {};

  for (const areaType of [CPRD_AREA_EEPROM, CPRD_AREA_FLASH]) {
    results[areaType] = [];
    for (const probe of probes) {
      const result = await cprdProbeAccess(writer, acc, areaType, probe.offset, probe.length, probe.label);
      const heuristic = cprdAssessZoneProbe(probe.offset, result.data);
      const compare = cprdCompareZoneProbeToReference(probe.offset, result.data);
      results[areaType].push({
        label: probe.label,
        ok: result.ok,
        data: cprdHexData(result.data, probe.length),
        heuristic: heuristic.details,
        compare: compare.details,
        score: heuristic.score,
      });
    }
  }

  const eepromScore = results[CPRD_AREA_EEPROM].filter(r => r.ok).length;
  const flashScore  = results[CPRD_AREA_FLASH].filter(r => r.ok).length;
  const eepromHeuristicScore = results[CPRD_AREA_EEPROM].reduce((sum, r) => sum + r.score, 0);
  const flashHeuristicScore  = results[CPRD_AREA_FLASH].reduce((sum, r) => sum + r.score, 0);
  const preferredArea =
    (flashHeuristicScore > eepromHeuristicScore) ? CPRD_AREA_FLASH :
    (eepromHeuristicScore > flashHeuristicScore) ? CPRD_AREA_EEPROM :
    (flashScore > eepromScore) ? CPRD_AREA_FLASH : CPRD_AREA_EEPROM;

  console.debug('[cpwrReadCodeplug] zone access probe', {
    preferredArea,
    eepromHeuristicScore,
    flashHeuristicScore,
    eeprom: results[CPRD_AREA_EEPROM],
    flash: results[CPRD_AREA_FLASH],
  });

  return preferredArea;
}

async function cprdProbeLowerBoundary(writer, acc) {
  const result = {};
  for (const areaType of [CPRD_AREA_EEPROM, CPRD_AREA_FLASH]) {
    const probe = await cprdProbeAccess(
      writer, acc, areaType, CPRD_LOWER_BOUNDARY_OFFSET, CPRD_PROBE_LEN, 'lower-boundary-0x07C00'
    );
    result[areaType] = {
      ok: probe.ok,
      data: cprdHexData(probe.data, CPRD_PROBE_LEN),
    };
  }
  console.debug('[cpwrReadCodeplug] lower boundary probe', {
    fileOffset: '0x07C00',
    eeprom: result[CPRD_AREA_EEPROM],
    flash: result[CPRD_AREA_FLASH],
  });
}

function cprdLogReadDebug(fileBuf, chunkFailures) {
  const zoneBitmap = fileBuf.subarray(CPRD_ZONE_BITMAP_OFFSET, CPRD_ZONE_BITMAP_OFFSET + 32);
  const zone0      = fileBuf.subarray(CPRD_ZONE_LIST_OFFSET, CPRD_ZONE_LIST_OFFSET + 32);
  const zoneProbe  = fileBuf.subarray(CPRD_ZONE_FMT_OFFSET, CPRD_ZONE_FMT_OFFSET + 1);
  console.debug('[cpwrReadCodeplug] read debug', {
    bitmap_0x8010: cprdHexSlice(fileBuf, CPRD_ZONE_BITMAP_OFFSET, 32),
    zone0_0x8030:  cprdHexSlice(fileBuf, CPRD_ZONE_LIST_OFFSET, 32),
    probe_0x806F:  cprdHexSlice(fileBuf, CPRD_ZONE_FMT_OFFSET, 1),
    heuristicCompare: {
      bitmap_0x8010: cprdAssessZoneProbe(CPRD_ZONE_BITMAP_OFFSET, zoneBitmap).details,
      zone0_0x8030:  cprdAssessZoneProbe(CPRD_ZONE_LIST_OFFSET, zone0).details,
      probe_0x806F:  cprdAssessZoneProbe(CPRD_ZONE_FMT_OFFSET, zoneProbe).details,
    },
    referenceCompare: {
      bitmap_0x8010: cprdCompareZoneProbeToReference(CPRD_ZONE_BITMAP_OFFSET, zoneBitmap).details,
      zone0_0x8030:  cprdCompareZoneProbeToReference(CPRD_ZONE_LIST_OFFSET, zone0).details,
      probe_0x806F:  cprdCompareZoneProbeToReference(CPRD_ZONE_FMT_OFFSET, zoneProbe).details,
    },
    failedChunks:  chunkFailures.map(f => ({
      label:      f.label,
      triedAreas: f.triedAreas,
      fileOffset: '0x' + f.fileOffset.toString(16).toUpperCase().padStart(5, '0'),
      hwAddr:     '0x' + f.hwAddr.toString(16).toUpperCase().padStart(5, '0'),
      length:     f.length,
    })),
  });
}

// Read the radio's full codeplug via USB CDC and return it as an ArrayBuffer.
// onProgress({ phase: 'read', pct: 0-100, msg: string })
async function cpwrReadCodeplug(onProgress) {
  if (!navigator.serial) {
    throw new Error('Web Serial API not available. Use Chrome or Edge 89+.');
  }

  const fileBuf = new Uint8Array(CPRD_FILE_SIZE);
  fileBuf.fill(0xFF);

  let port   = null;
  let writer = null;
  let acc    = null;

  try {
    port = await navigator.serial.requestPort({ filters: CPRD_SERIAL_FILTERS });
    await port.open({ baudRate: 115200 });
    writer = port.writable.getWriter();
    acc    = new SerialAccumulator(port.readable.getReader());

    onProgress({ phase: 'read', pct: 0, msg: 'Probing radio read access…' });
    await cprdProbeLowerBoundary(writer, acc);
    const zonePreferredArea = await cprdChooseZoneArea(writer, acc);

    // Three logical regions; total chunks stays 128 (same time budget as before).
    const totalChunks = Math.ceil(CPRD_QUARTER / CPRD_CHUNK) * 2 +
                        Math.ceil(CPRD_HALF    / CPRD_CHUNK);
    let chunksDone = 0;
    const chunkFailures = [];

    const readRegion = async (primaryArea, secondaryArea, hwBase, fileBase, regionLen, label) => {
      for (let i = 0; i < regionLen; i += CPRD_CHUNK) {
        const len  = Math.min(CPRD_CHUNK, regionLen - i);
        const hwAddr = hwBase + i;
        const triedAreas = [];
        let data = await cprdTryRead(writer, acc, primaryArea, hwAddr, len, `${label} primary`);
        triedAreas.push(primaryArea);
        if (!data && secondaryArea !== null && secondaryArea !== primaryArea) {
          console.debug('[cpwrReadCodeplug] retrying chunk with alternate area', {
            label,
            fileOffset: '0x' + (fileBase + i).toString(16).toUpperCase().padStart(5, '0'),
            hwAddr: '0x' + hwAddr.toString(16).toUpperCase().padStart(5, '0'),
            primaryArea,
            secondaryArea,
          });
          data = await cprdTryRead(writer, acc, secondaryArea, hwAddr, len, `${label} fallback`);
          triedAreas.push(secondaryArea);
        }
        if (data) {
          fileBuf.set(data.subarray(0, len), fileBase + i);
        } else {
          chunkFailures.push({ label, triedAreas, fileOffset: fileBase + i, hwAddr, length: len });
        }
        chunksDone++;
        const pct = Math.round((chunksDone / totalChunks) * 100);
        onProgress({ phase: 'read', pct, msg: `Reading ${label}… ${pct}%` });
      }
    };

    // Lower EEPROM (channels, settings) — prefer area=2, but boundary chunks may
    // need area=1 on some radios.
    onProgress({ phase: 'read', pct: 0, msg: 'Reading EEPROM region…' });
    await readRegion(CPRD_AREA_EEPROM, CPRD_AREA_FLASH, 0x00000, 0x00000, CPRD_QUARTER, 'EEPROM');

    // Zone block — choose the preferred area from live probes, but retry each
    // failed chunk via the other access mode.
    onProgress({ phase: 'read', pct: 25, msg: 'Reading zone region…' });
    await readRegion(
      zonePreferredArea,
      zonePreferredArea === CPRD_AREA_EEPROM ? CPRD_AREA_FLASH : CPRD_AREA_EEPROM,
      0x08000, 0x08000, CPRD_QUARTER, 'zones'
    );

    // SPI Flash region (contacts, RX groups).
    onProgress({ phase: 'read', pct: 50, msg: 'Reading SPI Flash region…' });
    await readRegion(CPRD_AREA_FLASH, null, CPRD_FLASH_HW_BASE, CPRD_HALF, CPRD_HALF, 'SPI Flash');

    cprdLogReadDebug(fileBuf, chunkFailures);

    if (chunkFailures.length > 0) {
      const sample = chunkFailures.slice(0, 4).map(f =>
        `${f.label} file 0x${f.fileOffset.toString(16).toUpperCase().padStart(5, '0')} ` +
        `(areas=${f.triedAreas.join('->')}, hw=0x${f.hwAddr.toString(16).toUpperCase().padStart(5, '0')})`
      ).join(', ');
      throw new Error(
        `Radio returned ${chunkFailures.length} failed codeplug read(s): ${sample}. ` +
        `Aborting instead of leaving 0xFF-filled gaps in the codeplug image.`
      );
    }

    return fileBuf.buffer;

  } finally {
    if (acc)    { try { acc.releaseLock();    } catch (_) {} }
    if (writer) { try { writer.releaseLock(); } catch (_) {} }
    if (port)   { try { await port.close();   } catch (_) {} }
  }
}
