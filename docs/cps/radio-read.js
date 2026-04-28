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
//                             area=2 (EEPROM) correctly covers this 32 KB range.
//
//   file[0x08000..0x0FFFF]  → EEPROM upper half  (CPS_ACCESS_FLASH, hw addr = file addr)
//                             Zone bitmap and zone list live here.
//                             area=2 returns errors above 0x7FFF on radios where the
//                             EEPROM area aliases only the lower 32 KB of SPI Flash.
//                             Must be read via area=1 (SPI Flash) at the same hw addr —
//                             the write command ('X') places this data at SPI Flash 0x8000+.
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

// SPI Flash hw base address for the third (SPI Flash) region.
// = file offset 0x10000 + FLASH_ADDRESS_OFFSET(0x20000) + 0x70000 = 0xA0000
const CPRD_FLASH_HW_BASE  = 0xA0000;

const CPRD_ZONE_BITMAP_OFFSET = 0x8010;
const CPRD_ZONE_LIST_OFFSET   = 0x8030;
const CPRD_ZONE_FMT_OFFSET    = 0x806F;

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

function cprdLogZoneDebug(fileBuf, chunkFailures) {
  console.debug('[cpwrReadCodeplug] zone debug', {
    bitmap_0x8010: cprdHexSlice(fileBuf, CPRD_ZONE_BITMAP_OFFSET, 32),
    zone0_0x8030:  cprdHexSlice(fileBuf, CPRD_ZONE_LIST_OFFSET, 32),
    probe_0x806F:  cprdHexSlice(fileBuf, CPRD_ZONE_FMT_OFFSET, 1),
    failedChunks:  chunkFailures.map(f => ({
      label:      f.label,
      area:       f.areaType,
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

    // Three logical regions; total chunks stays 128 (same time budget as before).
    const totalChunks = Math.ceil(CPRD_QUARTER / CPRD_CHUNK) * 2 +
                        Math.ceil(CPRD_HALF    / CPRD_CHUNK);
    let chunksDone = 0;
    const chunkFailures = [];

    const readRegion = async (areaType, hwBase, fileBase, regionLen, label) => {
      for (let i = 0; i < regionLen; i += CPRD_CHUNK) {
        const len  = Math.min(CPRD_CHUNK, regionLen - i);
        const hwAddr = hwBase + i;
        let data = null;
        for (let attempt = 0; attempt <= CPRD_MAX_RETRIES; attempt++) {
          data = await cprdRequest(writer, acc, areaType, hwAddr, len);
          if (data) break;
          console.debug('[cpwrReadCodeplug] chunk read failed', {
            label,
            area: areaType,
            attempt: attempt + 1,
            hwAddr: '0x' + hwAddr.toString(16).toUpperCase().padStart(5, '0'),
            fileOffset: '0x' + (fileBase + i).toString(16).toUpperCase().padStart(5, '0'),
            length: len,
          });
        }
        if (data) {
          fileBuf.set(data.subarray(0, len), fileBase + i);
        } else {
          chunkFailures.push({ label, areaType, fileOffset: fileBase + i, hwAddr, length: len });
        }
        chunksDone++;
        const pct = Math.round((chunksDone / totalChunks) * 100);
        onProgress({ phase: 'read', pct, msg: `Reading ${label}… ${pct}%` });
      }
    };

    // Lower EEPROM (channels, settings) — area=2 works here.
    onProgress({ phase: 'read', pct: 0, msg: 'Reading EEPROM region…' });
    await readRegion(CPRD_AREA_EEPROM, 0x00000, 0x00000, CPRD_QUARTER, 'EEPROM');

    // Upper EEPROM (zones) — area=2 errors above 0x7FFF; read via SPI Flash instead.
    onProgress({ phase: 'read', pct: 25, msg: 'Reading zone region…' });
    await readRegion(CPRD_AREA_FLASH, 0x08000, 0x08000, CPRD_QUARTER, 'zones');

    // SPI Flash region (contacts, RX groups).
    onProgress({ phase: 'read', pct: 50, msg: 'Reading SPI Flash region…' });
    await readRegion(CPRD_AREA_FLASH, CPRD_FLASH_HW_BASE, CPRD_HALF, CPRD_HALF, 'SPI Flash');

    cprdLogZoneDebug(fileBuf, chunkFailures);

    if (chunkFailures.length > 0) {
      const sample = chunkFailures.slice(0, 4).map(f =>
        `${f.label} file 0x${f.fileOffset.toString(16).toUpperCase().padStart(5, '0')} ` +
        `(area=${f.areaType}, hw=0x${f.hwAddr.toString(16).toUpperCase().padStart(5, '0')})`
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
