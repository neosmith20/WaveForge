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
// Codeplug file layout (128 KB) and sparse-read strategy:
//
//   The Web CPS parser (`cps.js`) only touches a handful of exact address ranges.
//   Some radios return errors or even soft-lock when large contiguous reads cross
//   sparse / unmapped gaps, so we do not read 32 KB / 64 KB synthetic regions.
//
//   Instead we:
//     1. Probe the zone area with both access modes using small reads.
//     2. Build the exact set of file ranges that `cps.js` actually uses.
//     3. Merge only adjacent/overlapping ranges that share the same access policy.
//     4. Read each merged range in conservative chunks clipped to that range only.
//
//   For file offsets >= 0x10000, SPI Flash hardware address = file offset + 0x90000.
//   CONTACTS example: file 0x17620 → hw 0xA7620.

const CPRD_SERIAL_FILTERS = [{ usbVendorId: 0x1FC9, usbProductId: 0x0094 }];

const CPRD_AREA_EEPROM    = 2;
const CPRD_AREA_FLASH     = 1;
const CPRD_FILE_SIZE      = 0x20000;    // 128 KB
const CPRD_MAX_RETRIES    = 2;          // retry transient chunk failures before giving up
const CPRD_PROBE_LEN      = 32;
const CPRD_CHUNK_SMALL    = 128;
const CPRD_CHUNK_MEDIUM   = 256;

// SPI Flash hw base address for the third (SPI Flash) region.
// = file offset 0x10000 + FLASH_ADDRESS_OFFSET(0x20000) + 0x70000 = 0xA0000
const CPRD_FLASH_HW_BASE  = 0xA0000;
const CPRD_FLASH_FILE_BASE = 0x10000;

const CPRD_DEVICE_INFO_OFFSET  = 0x0080;
const CPRD_DEVICE_INFO_SIZE    = 8;     // band limits used by cps.js
const CPRD_GENERAL_SETTINGS_OFFSET = 0x00E0;
const CPRD_GENERAL_SETTINGS_SIZE   = 12;
const CPRD_CHAN_BITMAP_OFFSET  = 0x3780;
const CPRD_CHAN_BITMAP_SIZE    = 16;
const CPRD_CHANNELS_OFFSET     = 0x3790;
const CPRD_CHANNELS_SIZE       = 128 * 56;
const CPRD_BOOT_IMAGE_OFFSET   = 0x6B40;
const CPRD_BOOT_IMAGE_SIZE     = 160 * 128 / 8;
const CPRD_BOOT_TUNE_OFFSET    = 0x7518;
const CPRD_BOOT_TUNE_SIZE      = 10 * 4;
const CPRD_BOOT_LINE1_OFFSET   = 0x7540;
const CPRD_BOOT_LINE_SIZE      = 16;
const CPRD_ZONE_BITMAP_OFFSET = 0x8010;
const CPRD_ZONE_BITMAP_SIZE   = 32;
const CPRD_ZONE_LIST_OFFSET   = 0x8030;
const CPRD_ZONE_FMT_OFFSET    = 0x806F;
const CPRD_ZONE_LIST_MAX_SIZE = 68 * (16 + 80 * 2); // max 80-ch OpenGD77 layout
const CPRD_CONTACTS_OFFSET    = 0x17620;
const CPRD_CONTACTS_SIZE      = 1024 * 24;
const CPRD_RXG_LEN_OFFSET     = 0x1D620;
const CPRD_RXG_LEN_SIZE       = 76;     // firmware CODEPLUG_RX_GROUPLIST_MAX
const CPRD_RXG_DATA_OFFSET    = 0x1D6A0;
const CPRD_RXG_DATA_SIZE      = 76 * 82;

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

function cprdSparseRange(start, end, label, primaryArea, secondaryArea, chunkSize) {
  return { start, end, label, primaryArea, secondaryArea, chunkSize };
}

function cprdMergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged = [];
  for (const range of sorted) {
    const prev = merged[merged.length - 1];
    if (prev &&
        range.start <= prev.end &&
        range.primaryArea === prev.primaryArea &&
        range.secondaryArea === prev.secondaryArea &&
        range.chunkSize === prev.chunkSize) {
      prev.end = Math.max(prev.end, range.end);
      prev.labels.push(range.label);
    } else {
      merged.push({ ...range, labels: [range.label] });
    }
  }
  return merged;
}

function cprdBuildReadRanges(zonePreferredArea) {
  const zoneFallbackArea = zonePreferredArea === CPRD_AREA_EEPROM ? CPRD_AREA_FLASH : CPRD_AREA_EEPROM;
  const ranges = [
    cprdSparseRange(
      CPRD_DEVICE_INFO_OFFSET,
      CPRD_DEVICE_INFO_OFFSET + CPRD_DEVICE_INFO_SIZE,
      'device-info',
      CPRD_AREA_EEPROM, CPRD_AREA_FLASH, CPRD_CHUNK_SMALL
    ),
    cprdSparseRange(
      CPRD_GENERAL_SETTINGS_OFFSET,
      CPRD_GENERAL_SETTINGS_OFFSET + CPRD_GENERAL_SETTINGS_SIZE,
      'general-settings',
      CPRD_AREA_EEPROM, CPRD_AREA_FLASH, CPRD_CHUNK_SMALL
    ),
    cprdSparseRange(
      CPRD_CHAN_BITMAP_OFFSET,
      CPRD_CHANNELS_OFFSET + CPRD_CHANNELS_SIZE,
      'channels',
      CPRD_AREA_EEPROM, CPRD_AREA_FLASH, CPRD_CHUNK_SMALL
    ),
    cprdSparseRange(
      CPRD_BOOT_IMAGE_OFFSET,
      CPRD_BOOT_IMAGE_OFFSET + CPRD_BOOT_IMAGE_SIZE,
      'boot-image',
      CPRD_AREA_EEPROM, CPRD_AREA_FLASH, CPRD_CHUNK_SMALL
    ),
    cprdSparseRange(
      CPRD_BOOT_TUNE_OFFSET,
      CPRD_BOOT_TUNE_OFFSET + CPRD_BOOT_TUNE_SIZE,
      'boot-tune',
      CPRD_AREA_EEPROM, CPRD_AREA_FLASH, CPRD_CHUNK_SMALL
    ),
    cprdSparseRange(
      CPRD_BOOT_LINE1_OFFSET,
      CPRD_BOOT_LINE1_OFFSET + CPRD_BOOT_LINE_SIZE,
      'boot-line1',
      CPRD_AREA_EEPROM, CPRD_AREA_FLASH, CPRD_CHUNK_SMALL
    ),
    cprdSparseRange(
      CPRD_BOOT_LINE1_OFFSET + CPRD_BOOT_LINE_SIZE,
      CPRD_BOOT_LINE1_OFFSET + CPRD_BOOT_LINE_SIZE * 2,
      'boot-line2',
      CPRD_AREA_EEPROM, CPRD_AREA_FLASH, CPRD_CHUNK_SMALL
    ),
    cprdSparseRange(
      CPRD_ZONE_BITMAP_OFFSET,
      CPRD_ZONE_LIST_OFFSET + CPRD_ZONE_LIST_MAX_SIZE,
      'zones',
      zonePreferredArea, zoneFallbackArea, CPRD_CHUNK_SMALL
    ),
    cprdSparseRange(
      CPRD_CONTACTS_OFFSET,
      CPRD_CONTACTS_OFFSET + CPRD_CONTACTS_SIZE,
      'contacts',
      CPRD_AREA_FLASH, null, CPRD_CHUNK_MEDIUM
    ),
    cprdSparseRange(
      CPRD_RXG_LEN_OFFSET,
      CPRD_RXG_LEN_OFFSET + CPRD_RXG_LEN_SIZE,
      'rxg-lengths',
      CPRD_AREA_FLASH, null, CPRD_CHUNK_MEDIUM
    ),
    cprdSparseRange(
      CPRD_RXG_DATA_OFFSET,
      CPRD_RXG_DATA_OFFSET + CPRD_RXG_DATA_SIZE,
      'rxg-data',
      CPRD_AREA_FLASH, null, CPRD_CHUNK_MEDIUM
    ),
  ];
  return cprdMergeRanges(ranges);
}

function cprdFileOffsetToHwAddr(fileOffset) {
  return (fileOffset < CPRD_FLASH_FILE_BASE)
    ? fileOffset
    : (CPRD_FLASH_HW_BASE + (fileOffset - CPRD_FLASH_FILE_BASE));
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

function cprdLogReadDebug(fileBuf, chunkFailures, ranges) {
  const zoneBitmap = fileBuf.subarray(CPRD_ZONE_BITMAP_OFFSET, CPRD_ZONE_BITMAP_OFFSET + 32);
  const zone0      = fileBuf.subarray(CPRD_ZONE_LIST_OFFSET, CPRD_ZONE_LIST_OFFSET + 32);
  const zoneProbe  = fileBuf.subarray(CPRD_ZONE_FMT_OFFSET, CPRD_ZONE_FMT_OFFSET + 1);
  console.debug('[cpwrReadCodeplug] read debug', {
    sparseRanges: ranges.map(r => ({
      label: r.labels.join(','),
      fileStart: '0x' + r.start.toString(16).toUpperCase().padStart(5, '0'),
      fileEnd: '0x' + r.end.toString(16).toUpperCase().padStart(5, '0'),
      primaryArea: r.primaryArea,
      secondaryArea: r.secondaryArea,
      chunkSize: r.chunkSize,
    })),
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
    const zonePreferredArea = await cprdChooseZoneArea(writer, acc);
    const ranges = cprdBuildReadRanges(zonePreferredArea);

    const totalChunks = ranges.reduce((sum, range) =>
      sum + Math.ceil((range.end - range.start) / range.chunkSize), 0);
    let chunksDone = 0;
    const chunkFailures = [];

    const readRange = async (range) => {
      for (let fileOffset = range.start; fileOffset < range.end; fileOffset += range.chunkSize) {
        const len = Math.min(range.chunkSize, range.end - fileOffset);
        const hwAddr = cprdFileOffsetToHwAddr(fileOffset);
        const triedAreas = [];
        let data = await cprdTryRead(writer, acc, range.primaryArea, hwAddr, len, `${range.label} primary`);
        triedAreas.push(range.primaryArea);
        if (!data && range.secondaryArea !== null && range.secondaryArea !== range.primaryArea) {
          console.debug('[cpwrReadCodeplug] retrying chunk with alternate area', {
            label: range.label,
            fileOffset: '0x' + fileOffset.toString(16).toUpperCase().padStart(5, '0'),
            hwAddr: '0x' + hwAddr.toString(16).toUpperCase().padStart(5, '0'),
            primaryArea: range.primaryArea,
            secondaryArea: range.secondaryArea,
          });
          data = await cprdTryRead(writer, acc, range.secondaryArea, hwAddr, len, `${range.label} fallback`);
          triedAreas.push(range.secondaryArea);
        }
        if (data) {
          fileBuf.set(data.subarray(0, len), fileOffset);
        } else {
          chunkFailures.push({ label: range.label, triedAreas, fileOffset, hwAddr, length: len });
        }
        chunksDone++;
        const pct = Math.round((chunksDone / totalChunks) * 100);
        onProgress({ phase: 'read', pct, msg: `Reading ${range.labels.join(', ')}… ${pct}%` });
      }
    };

    for (const range of ranges) {
      await readRange(range);
    }

    cprdLogReadDebug(fileBuf, chunkFailures, ranges);

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
