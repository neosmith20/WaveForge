'use strict';

// ClearDMR Web CPS — Read from Radio via USB CDC (normal operating mode)
//
// The firmware exposes a proprietary CDC protocol when running normally.
// USB VID/PID: 0x1FC9 / 0x0094 (set in usbd_desc.c)
//
// Request packet (8 bytes):
//   [0]    'R' (0x52)
//   [1]    area: 1=SPI Flash, 2=EEPROM (EEPROM is aliased to SPI Flash at offset 0)
//   [2..5] address (big-endian uint32)
//   [6..7] length  (big-endian uint16, max 2045)
//
// Response on success: ['R', len_hi, len_lo, data...]
// Response on error:   ['-']
//
// Codeplug file layout (128 KB):
//   file[0x00000..0x0FFFF]  → EEPROM via CPS_ACCESS_EEPROM (hw addr = file addr)
//   file[0x10000..0x1FFFF]  → SPI Flash via CPS_ACCESS_FLASH (hw addr = file addr + 0x70000)

const CPRD_SERIAL_FILTERS = [{ usbVendorId: 0x1FC9, usbProductId: 0x0094 }];

const CPRD_AREA_EEPROM    = 2;
const CPRD_AREA_FLASH     = 1;
const CPRD_CHUNK          = 1024;      // bytes per request  (firmware cap: 2045)
const CPRD_FILE_SIZE      = 0x20000;   // 128 KB total
const CPRD_HALF           = CPRD_FILE_SIZE >>> 1;  // 64 KB per region
const CPRD_FLASH_HW_BASE  = 0x80000;  // SPI Flash hw address of the second region

// Accumulate bytes from the serial readable stream, keeping a leftover buffer
// so that chunk-boundary splits never lose data.
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

// Send one CPS 'R' request and return the data bytes, or null on device error.
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
  if (status[0] !== 0x52) return null;           // '-' = device error
  const lenBytes = await acc.readExact(2);
  const respLen  = (lenBytes[0] << 8) | lenBytes[1];
  return acc.readExact(respLen);
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

    const totalChunks = Math.ceil(CPRD_HALF / CPRD_CHUNK) * 2;
    let done = 0;

    const readRegion = async (areaType, hwBase, fileBase, label) => {
      for (let i = 0; i < CPRD_HALF; i += CPRD_CHUNK) {
        const len    = Math.min(CPRD_CHUNK, CPRD_HALF - i);
        const data   = await cprdRequest(writer, acc, areaType, hwBase + i, len);
        if (data) fileBuf.set(data.subarray(0, len), fileBase + i);
        done++;
        const pct = Math.round((done / totalChunks) * 100);
        onProgress({ phase: 'read', pct, msg: `Reading ${label}… ${pct}%` });
      }
    };

    onProgress({ phase: 'read', pct: 0, msg: 'Reading EEPROM region…' });
    await readRegion(CPRD_AREA_EEPROM, 0x0000, 0x00000, 'EEPROM');

    onProgress({ phase: 'read', pct: 50, msg: 'Reading SPI Flash region…' });
    await readRegion(CPRD_AREA_FLASH, CPRD_FLASH_HW_BASE, CPRD_HALF, 'SPI Flash');

    // Sanity check — GENERAL_SETTINGS at 0x00E0 should not be blank flash
    if (fileBuf.slice(0x00E0, 0x00EC).every(b => b === 0xFF)) {
      throw new Error('Codeplug area is blank or unreadable. Is the radio powered on normally (not in DFU mode)?');
    }

    return fileBuf.buffer;

  } finally {
    if (acc)    { try { acc.releaseLock();      } catch (_) {} }
    if (writer) { try { writer.releaseLock();   } catch (_) {} }
    if (port)   { try { await port.close();     } catch (_) {} }
  }
}
