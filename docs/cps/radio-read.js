'use strict';

// ClearDMR Web CPS — Read from Radio via USB CDC (normal operating mode)
//
// The firmware exposes a proprietary CDC protocol when running normally.
// USB VID/PID: 0x1FC9 / 0x0094 (set in usbd_desc.c)
//
// Request packet (8 bytes):
//   [0]    'R' (0x52)
//   [1]    area: 1=SPI Flash, 2=EEPROM
//   [2..5] address (big-endian uint32)
//   [6..7] length  (big-endian uint16)
//
// Response on success: ['R', len_hi, len_lo, data...]
// Response on error:   ['-']
//
// This reader intentionally does NOT attempt to dump broad contiguous regions.
// The radio's CPS-accessible memory appears sparse / fragile: small targeted
// reads succeed, while bulk/range-style reads can fail and eventually soft-lock
// the radio. To keep "Read from Radio" usable, we only fetch the exact
// structures the Web CPS requires for channels, zones, and contacts.

const CPRD_SERIAL_FILTERS = [{ usbVendorId: 0x1FC9, usbProductId: 0x0094 }];

const CPRD_AREA_FLASH  = 1;
const CPRD_AREA_EEPROM = 2;

const CPRD_FILE_SIZE         = 0x20000;
const CPRD_FLASH_FILE_BASE   = 0x10000;
const CPRD_FLASH_HW_BASE     = 0xA0000;
const CPRD_INTER_REQUEST_MS  = 50;  // minimum gap before every USB read, success or failure
const CPRD_ERROR_BACKOFF_MS  = 150; // additional wait before each retry on a failed chunk
const CPRD_MAX_RETRIES       = 1;   // hard cap: 1 original + 1 retry = 2 total attempts per chunk
const CPRD_ZONE_PROBE_LEN    = 32;

const CPRD_DEVICE_INFO_OFFSET      = 0x0080;
const CPRD_DEVICE_INFO_SIZE        = 8;
const CPRD_GENERAL_SETTINGS_OFFSET = 0x00E0;
const CPRD_GENERAL_SETTINGS_SIZE   = 12;

const CPRD_CHAN_BITMAP_OFFSET = 0x3780;
const CPRD_CHAN_BITMAP_SIZE   = 16;
const CPRD_CHANNELS_OFFSET    = 0x3790;
const CPRD_CHANNEL_SIZE       = 56;
const CPRD_CHANNELS_MAX       = 128;

const CPRD_ZONE_BITMAP_OFFSET = 0x8010;
const CPRD_ZONE_BITMAP_SIZE   = 32;
const CPRD_ZONE_LIST_OFFSET   = 0x8030;
const CPRD_ZONE_FMT_OFFSET    = 0x806F;
const CPRD_ZONES_MAX          = 68;
const CPRD_ZONE_NAME_SIZE     = 16;

const CPRD_CONTACTS_OFFSET = 0x17620;
const CPRD_CONTACT_SIZE    = 24;
const CPRD_CONTACTS_MAX    = 1024;

// Optional sections intentionally skipped during live radio reads for safety:
// boot image, boot tune, boot screen text, VFO data, RX groups.

const CPRD_REF_ZONE_BITMAP_PREFIX = new Uint8Array([0x3F, 0x00]);
const CPRD_REF_ZONE0_NAME         = new Uint8Array([0x41, 0x6E, 0x61, 0x6C, 0x6F, 0x67]); // "Analog"
const CPRD_REF_ZONE0_REFS_PREFIX  = new Uint8Array([0x01, 0x00, 0x35, 0x00, 0x02, 0x00, 0x03, 0x00]);
const CPRD_REF_ZONE_PROBE         = 0x00;

function cprdDelay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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

function cprdFileOffsetToHwAddr(fileOffset) {
  return (fileOffset < CPRD_FLASH_FILE_BASE)
    ? fileOffset
    : (CPRD_FLASH_HW_BASE + (fileOffset - CPRD_FLASH_FILE_BASE));
}

async function cprdRequest(writer, acc, areaType, hwAddr, length) {
  await cprdDelay(CPRD_INTER_REQUEST_MS);

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
  if (status[0] !== 0x52) return null;
  const lenBytes = await acc.readExact(2);
  const respLen  = (lenBytes[0] << 8) | lenBytes[1];
  return acc.readExact(respLen);
}

function cprdHexData(data, maxLen) {
  if (!data) return null;
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return Array.from(bytes.subarray(0, maxLen), b =>
    b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

function cprdHexSlice(fileBuf, offset, length) {
  return cprdHexData(fileBuf.subarray(offset, offset + length), length);
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
    const anyNonFF = data.some(b => b !== 0xFF);
    return {
      score: allFF ? 0 : (anyNonFF ? 2 : 1),
      details: {
        ok: true,
        allFF,
        anyNonFF,
        live: cprdHexData(data, Math.min(data.length, 16)),
      },
    };
  }

  if (offset === CPRD_ZONE_LIST_OFFSET) {
    const nameBytes = data.subarray(0, 16);
    const namePlausible = cprdIsPrintableZoneName(nameBytes);
    let saneRefs = 0;
    let implausibleRefs = 0;
    for (let i = 16; i + 1 < data.length; i += 2) {
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
        liveRefs: cprdHexData(data.subarray(16), Math.min(8, data.length - 16)),
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
  if (!data) return { details: { ok: false } };

  if (offset === CPRD_ZONE_BITMAP_OFFSET) {
    return {
      details: {
        ok: true,
        bitmapPrefixMatches: cprdStartsWith(data, CPRD_REF_ZONE_BITMAP_PREFIX),
        live: cprdHexData(data, Math.min(data.length, 16)),
        reference: cprdHexData(CPRD_REF_ZONE_BITMAP_PREFIX, CPRD_REF_ZONE_BITMAP_PREFIX.length),
      },
    };
  }

  if (offset === CPRD_ZONE_LIST_OFFSET) {
    return {
      details: {
        ok: true,
        nameMatches: cprdStartsWith(data, CPRD_REF_ZONE0_NAME),
        refsMatch: cprdStartsWith(data, CPRD_REF_ZONE0_REFS_PREFIX, 16),
        liveNameHex: cprdHexData(data.subarray(0, 16), 16),
        liveNameAscii: cprdAsciiData(data.subarray(0, 16), 16),
        liveRefs: cprdHexData(data.subarray(16), Math.min(8, data.length - 16)),
        referenceNameAscii: 'Analog',
        referenceRefs: cprdHexData(CPRD_REF_ZONE0_REFS_PREFIX, CPRD_REF_ZONE0_REFS_PREFIX.length),
      },
    };
  }

  if (offset === CPRD_ZONE_FMT_OFFSET) {
    return {
      details: {
        ok: true,
        probeMatches: data.length > 0 && data[0] === CPRD_REF_ZONE_PROBE,
        live: cprdHexData(data, 1),
        reference: '00',
      },
    };
  }

  return { details: { ok: true } };
}

function cprdBitIndices(bitmap, maxBits) {
  const out = [];
  for (let i = 0; i < maxBits; i++) {
    const byteIdx = i >> 3;
    if (bitmap[byteIdx] & (1 << (i & 7))) out.push(i);
  }
  return out;
}

async function cprdReadOnce(writer, acc, areaType, fileOffset, length, context) {
  const hwAddr = cprdFileOffsetToHwAddr(fileOffset);
  const data = await cprdRequest(writer, acc, areaType, hwAddr, length);
  if (!data) {
    console.debug('[cpwrReadCodeplug] read failed', {
      context,
      area: areaType,
      fileOffset: '0x' + fileOffset.toString(16).toUpperCase().padStart(5, '0'),
      hwAddr: '0x' + hwAddr.toString(16).toUpperCase().padStart(5, '0'),
      length,
    });
    return { data: null, hwAddr };
  }
  return { data: data.subarray(0, length), hwAddr };
}

async function cprdReadWithFallback(writer, acc, fileOffset, length, primaryArea, secondaryArea, context) {
  const triedAreas = [];
  let { data, hwAddr } = await cprdReadOnce(writer, acc, primaryArea, fileOffset, length, context);
  triedAreas.push(primaryArea);
  if (data) return { data, hwAddr, triedAreas };

  if (secondaryArea !== null && secondaryArea !== primaryArea && CPRD_MAX_RETRIES > 0) {
    await cprdDelay(CPRD_ERROR_BACKOFF_MS);
    const retry = await cprdReadOnce(writer, acc, secondaryArea, fileOffset, length, `${context} fallback`);
    triedAreas.push(secondaryArea);
    if (retry.data) return { data: retry.data, hwAddr: retry.hwAddr, triedAreas };
    hwAddr = retry.hwAddr;
  }

  await cprdDelay(CPRD_ERROR_BACKOFF_MS);
  return { data: null, hwAddr, triedAreas };
}

function cprdWrite(fileBuf, fileOffset, data) {
  if (data) fileBuf.set(data, fileOffset);
}

async function cprdChooseZoneArea(writer, acc) {
  const probes = [
    { offset: CPRD_ZONE_BITMAP_OFFSET, length: CPRD_ZONE_PROBE_LEN, label: 'bitmap_0x8010' },
    { offset: CPRD_ZONE_LIST_OFFSET,   length: 24,                  label: 'zone0_0x8030'  },
    { offset: CPRD_ZONE_FMT_OFFSET,    length: 1,                   label: 'probe_0x806F'  },
  ];
  const results = { [CPRD_AREA_EEPROM]: [], [CPRD_AREA_FLASH]: [] };

  for (const areaType of [CPRD_AREA_EEPROM, CPRD_AREA_FLASH]) {
    for (const probe of probes) {
      const result = await cprdReadOnce(writer, acc, areaType, probe.offset, probe.length, `probe ${probe.label}`);
      const heuristic = cprdAssessZoneProbe(probe.offset, result.data);
      const compare   = cprdCompareZoneProbeToReference(probe.offset, result.data);
      results[areaType].push({
        label: probe.label,
        ok: !!result.data,
        data: cprdHexData(result.data, probe.length),
        heuristic: heuristic.details,
        compare: compare.details,
        score: heuristic.score,
      });
    }
  }

  const eepromScore = results[CPRD_AREA_EEPROM].reduce((sum, r) => sum + r.score, 0);
  const flashScore  = results[CPRD_AREA_FLASH].reduce((sum, r) => sum + r.score, 0);
  const preferredArea = (flashScore > eepromScore) ? CPRD_AREA_FLASH : CPRD_AREA_EEPROM;

  console.debug('[cpwrReadCodeplug] zone access probe', {
    preferredArea,
    eepromScore,
    flashScore,
    eeprom: results[CPRD_AREA_EEPROM],
    flash: results[CPRD_AREA_FLASH],
  });

  return preferredArea;
}

function cprdLogReadDebug(fileBuf, failures, stats) {
  const zoneBitmap = fileBuf.subarray(CPRD_ZONE_BITMAP_OFFSET, CPRD_ZONE_BITMAP_OFFSET + CPRD_ZONE_BITMAP_SIZE);
  const zone0      = fileBuf.subarray(CPRD_ZONE_LIST_OFFSET, CPRD_ZONE_LIST_OFFSET + 24);
  const zoneProbe  = fileBuf.subarray(CPRD_ZONE_FMT_OFFSET, CPRD_ZONE_FMT_OFFSET + 1);
  console.debug('[cpwrReadCodeplug] read debug', {
    stats,
    bitmap_0x8010: cprdHexData(zoneBitmap, 32),
    zone0_0x8030:  cprdHexData(zone0, 24),
    probe_0x806F:  cprdHexData(zoneProbe, 1),
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
    failures: failures.map(f => ({
      label: f.label,
      triedAreas: f.triedAreas,
      fileOffset: '0x' + f.fileOffset.toString(16).toUpperCase().padStart(5, '0'),
      hwAddr: '0x' + f.hwAddr.toString(16).toUpperCase().padStart(5, '0'),
      length: f.length,
    })),
  });
}

async function cpwrReadCodeplug(onProgress) {
  if (!navigator.serial) {
    throw new Error('Web Serial API not available. Use Chrome or Edge 89+.');
  }

  const fileBuf = new Uint8Array(CPRD_FILE_SIZE);
  fileBuf.fill(0xFF);

  let port   = null;
  let writer = null;
  let acc    = null;

  const failures = [];
  const stats = {
    zoneArea: null,
    channelsActive: 0,
    channelsRead: 0,
    zonesActive: 0,
    zonesRead: 0,
    contactsRead: 0,
    contactsStoppedAt: null,
    skippedOptional: ['boot-image', 'boot-tune', 'boot-screen', 'vfo', 'rx-groups'],
  };

  const reportFailure = (label, fileOffset, length, hwAddr, triedAreas) => {
    failures.push({ label, fileOffset, length, hwAddr, triedAreas });
  };

  try {
    port = await navigator.serial.requestPort({ filters: CPRD_SERIAL_FILTERS });
    await port.open({ baudRate: 115200 });
    writer = port.writable.getWriter();
    acc    = new SerialAccumulator(port.readable.getReader());

    onProgress({ phase: 'read', pct: 0, msg: 'Probing zone access…' });
    const zoneArea = await cprdChooseZoneArea(writer, acc);
    stats.zoneArea = zoneArea;
    const zoneFallbackArea = zoneArea === CPRD_AREA_EEPROM ? CPRD_AREA_FLASH : CPRD_AREA_EEPROM;

    onProgress({ phase: 'read', pct: 5, msg: 'Reading settings…' });

    {
      const r = await cprdReadWithFallback(writer, acc,
        CPRD_DEVICE_INFO_OFFSET, CPRD_DEVICE_INFO_SIZE,
        CPRD_AREA_EEPROM, CPRD_AREA_FLASH, 'device-info');
      cprdWrite(fileBuf, CPRD_DEVICE_INFO_OFFSET, r.data);
      if (!r.data) reportFailure('device-info', CPRD_DEVICE_INFO_OFFSET, CPRD_DEVICE_INFO_SIZE, r.hwAddr, r.triedAreas);
    }

    {
      const r = await cprdReadWithFallback(writer, acc,
        CPRD_GENERAL_SETTINGS_OFFSET, CPRD_GENERAL_SETTINGS_SIZE,
        CPRD_AREA_EEPROM, CPRD_AREA_FLASH, 'general-settings');
      cprdWrite(fileBuf, CPRD_GENERAL_SETTINGS_OFFSET, r.data);
      if (!r.data) reportFailure('general-settings', CPRD_GENERAL_SETTINGS_OFFSET, CPRD_GENERAL_SETTINGS_SIZE, r.hwAddr, r.triedAreas);
    }

    let chanBitmap = null;
    {
      const r = await cprdReadWithFallback(writer, acc,
        CPRD_CHAN_BITMAP_OFFSET, CPRD_CHAN_BITMAP_SIZE,
        CPRD_AREA_EEPROM, CPRD_AREA_FLASH, 'channel-bitmap');
      cprdWrite(fileBuf, CPRD_CHAN_BITMAP_OFFSET, r.data);
      if (!r.data) {
        reportFailure('channel-bitmap', CPRD_CHAN_BITMAP_OFFSET, CPRD_CHAN_BITMAP_SIZE, r.hwAddr, r.triedAreas);
        chanBitmap = new Uint8Array(CPRD_CHAN_BITMAP_SIZE);
      } else {
        chanBitmap = r.data;
      }
    }

    const activeChannels = cprdBitIndices(chanBitmap, CPRD_CHANNELS_MAX);
    stats.channelsActive = activeChannels.length;

    for (let i = 0; i < activeChannels.length; i++) {
      const slot = activeChannels[i];
      const fileOffset = CPRD_CHANNELS_OFFSET + slot * CPRD_CHANNEL_SIZE;
      const r = await cprdReadWithFallback(writer, acc,
        fileOffset, CPRD_CHANNEL_SIZE,
        CPRD_AREA_EEPROM, CPRD_AREA_FLASH, `channel-${slot + 1}`);
      cprdWrite(fileBuf, fileOffset, r.data);
      if (!r.data) {
        reportFailure(`channel-${slot + 1}`, fileOffset, CPRD_CHANNEL_SIZE, r.hwAddr, r.triedAreas);
      } else {
        stats.channelsRead++;
      }
      const pct = activeChannels.length === 0
        ? 45
        : Math.round(10 + (35 * (i + 1) / activeChannels.length));
      onProgress({ phase: 'read', pct, msg: `Reading channels… ${i + 1}/${activeChannels.length}` });
    }

    let zoneBitmap = null;
    {
      const r = await cprdReadWithFallback(writer, acc,
        CPRD_ZONE_BITMAP_OFFSET, CPRD_ZONE_BITMAP_SIZE,
        zoneArea, zoneFallbackArea, 'zone-bitmap');
      cprdWrite(fileBuf, CPRD_ZONE_BITMAP_OFFSET, r.data);
      if (!r.data) {
        reportFailure('zone-bitmap', CPRD_ZONE_BITMAP_OFFSET, CPRD_ZONE_BITMAP_SIZE, r.hwAddr, r.triedAreas);
        zoneBitmap = new Uint8Array(CPRD_ZONE_BITMAP_SIZE);
      } else {
        zoneBitmap = r.data;
      }
    }

    let zoneProbeByte = 0xFF;
    {
      const r = await cprdReadWithFallback(writer, acc,
        CPRD_ZONE_FMT_OFFSET, 1,
        zoneArea, zoneFallbackArea, 'zone-format-probe');
      cprdWrite(fileBuf, CPRD_ZONE_FMT_OFFSET, r.data);
      if (!r.data) {
        reportFailure('zone-format-probe', CPRD_ZONE_FMT_OFFSET, 1, r.hwAddr, r.triedAreas);
      } else {
        zoneProbeByte = r.data[0];
      }
    }

    const channelsPerZone = (zoneProbeByte >= 0x05 && zoneProbeByte <= 0xFE) ? 16 : 80;
    const zoneRefsSize = channelsPerZone * 2;
    const activeZones = cprdBitIndices(zoneBitmap, CPRD_ZONES_MAX);
    stats.zonesActive = activeZones.length;

    for (let i = 0; i < activeZones.length; i++) {
      const slot = activeZones[i];
      const zoneBase = CPRD_ZONE_LIST_OFFSET + slot * (CPRD_ZONE_NAME_SIZE + zoneRefsSize);

      const nameRead = await cprdReadWithFallback(writer, acc,
        zoneBase, CPRD_ZONE_NAME_SIZE,
        zoneArea, zoneFallbackArea, `zone-${slot + 1}-name`);
      cprdWrite(fileBuf, zoneBase, nameRead.data);
      if (!nameRead.data) {
        reportFailure(`zone-${slot + 1}-name`, zoneBase, CPRD_ZONE_NAME_SIZE, nameRead.hwAddr, nameRead.triedAreas);
      }

      const refsRead = await cprdReadWithFallback(writer, acc,
        zoneBase + CPRD_ZONE_NAME_SIZE, zoneRefsSize,
        zoneArea, zoneFallbackArea, `zone-${slot + 1}-refs`);
      cprdWrite(fileBuf, zoneBase + CPRD_ZONE_NAME_SIZE, refsRead.data);
      if (!refsRead.data) {
        reportFailure(`zone-${slot + 1}-refs`, zoneBase + CPRD_ZONE_NAME_SIZE, zoneRefsSize, refsRead.hwAddr, refsRead.triedAreas);
      }

      if (nameRead.data || refsRead.data) stats.zonesRead++;
      const pct = activeZones.length === 0
        ? 70
        : Math.round(45 + (25 * (i + 1) / activeZones.length));
      onProgress({ phase: 'read', pct, msg: `Reading zones… ${i + 1}/${activeZones.length}` });
    }

    onProgress({ phase: 'read', pct: 70, msg: 'Reading contacts…' });

    for (let i = 0; i < CPRD_CONTACTS_MAX; i++) {
      const fileOffset = CPRD_CONTACTS_OFFSET + i * CPRD_CONTACT_SIZE;
      const r = await cprdReadWithFallback(writer, acc,
        fileOffset, CPRD_CONTACT_SIZE,
        CPRD_AREA_FLASH, null, `contact-${i + 1}`);

      if (!r.data) {
        reportFailure(`contact-${i + 1}`, fileOffset, CPRD_CONTACT_SIZE, r.hwAddr, r.triedAreas);
        stats.contactsStoppedAt = i + 1;
        break;
      }

      cprdWrite(fileBuf, fileOffset, r.data);
      if (r.data[0] === 0xFF) {
        stats.contactsStoppedAt = i + 1;
        break;
      }

      stats.contactsRead++;
      const pct = Math.round(70 + (25 * Math.min(i + 1, 128) / 128));
      onProgress({ phase: 'read', pct, msg: `Reading contacts… ${i + 1}` });
    }

    onProgress({ phase: 'read', pct: 100, msg: 'Finalising codeplug…' });
    cprdLogReadDebug(fileBuf, failures, stats);
    return fileBuf.buffer;

  } finally {
    if (acc)    { try { acc.releaseLock();    } catch (_) {} }
    if (writer) { try { writer.releaseLock(); } catch (_) {} }
    if (port)   { try { await port.close();   } catch (_) {} }
  }
}
