'use strict';

// ClearDMR Web CPS — Raw codeplug memory dump via USB CDC
//
// Produces a 128 KB buffer with the same layout as .g77 / .cdmr files:
//   File 0x00000–0x0FFFF  EEPROM region   hw 0x00000–0x0FFFF  (area=2)
//   File 0x10000–0x1FFFF  SPI flash region hw 0x80000–0x8FFFF  (area=1)
//
// Every byte is read raw — no parsing, no interpretation.
// Failed chunks are filled with 0xFF and reported; the dump continues.
// Use index.html#debug to reveal the button.

const DUMP_SERIAL_FILTERS = [{ usbVendorId: 0x1FC9, usbProductId: 0x0094 }];

const DUMP_AREA_FLASH     = 1;
const DUMP_AREA_EEPROM    = 2;

const DUMP_CHUNK          = 256;      // bytes per read; firmware cap is ~1533
const DUMP_INTER_READ_MS  = 50;       // same guard as radio-read.js

const DUMP_EEPROM_HW_BASE = 0x00000;
const DUMP_EEPROM_SIZE    = 0x10000;  // 64 KB
const DUMP_FLASH_HW_BASE  = 0x80000;  // hw = file_offset + 0x70000
const DUMP_FLASH_SIZE     = 0x10000;  // 64 KB
const DUMP_FILE_SIZE      = DUMP_EEPROM_SIZE + DUMP_FLASH_SIZE;  // 128 KB

async function cpwrDumpCodeplug(onProgress) {
  if (!navigator.serial) throw new Error('Web Serial API not available. Use Chrome or Edge 89+.');

  const fileBuf      = new Uint8Array(DUMP_FILE_SIZE);
  fileBuf.fill(0xFF);
  const failedChunks = [];

  let port   = null;
  let writer = null;
  let acc    = null;

  const totalChunks =
    Math.ceil(DUMP_EEPROM_SIZE / DUMP_CHUNK) +
    Math.ceil(DUMP_FLASH_SIZE  / DUMP_CHUNK);
  let done = 0;

  async function readChunk(areaType, hwAddr, length) {
    await new Promise(r => setTimeout(r, DUMP_INTER_READ_MS));
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
    const lenHdr  = await acc.readExact(2);
    const respLen = (lenHdr[0] << 8) | lenHdr[1];
    const data    = await acc.readExact(respLen);
    return data.subarray(0, Math.min(length, respLen));
  }

  function hex5(n) { return '0x' + n.toString(16).toUpperCase().padStart(5, '0'); }

  try {
    port = await navigator.serial.requestPort({ filters: DUMP_SERIAL_FILTERS });
    await port.open({ baudRate: 115200 });
    writer = port.writable.getWriter();
    acc    = new SerialAccumulator(port.readable.getReader());

    // ── EEPROM region  (file 0x00000–0x0FFFF) ────────────────────────────────
    for (let off = 0; off < DUMP_EEPROM_SIZE; off += DUMP_CHUNK) {
      const hwAddr = DUMP_EEPROM_HW_BASE + off;
      const len    = Math.min(DUMP_CHUNK, DUMP_EEPROM_SIZE - off);
      const data   = await readChunk(DUMP_AREA_EEPROM, hwAddr, len);
      if (data) {
        fileBuf.set(data, off);
      } else {
        failedChunks.push(`EEPROM ${hex5(hwAddr)}`);
      }
      done++;
      onProgress({ pct: Math.round(100 * done / totalChunks), msg: `EEPROM ${hex5(hwAddr)}` });
    }

    // ── SPI Flash region  (file 0x10000–0x1FFFF) ─────────────────────────────
    for (let off = 0; off < DUMP_FLASH_SIZE; off += DUMP_CHUNK) {
      const hwAddr   = DUMP_FLASH_HW_BASE + off;
      const fileOff  = DUMP_EEPROM_SIZE + off;
      const len      = Math.min(DUMP_CHUNK, DUMP_FLASH_SIZE - off);
      const data     = await readChunk(DUMP_AREA_FLASH, hwAddr, len);
      if (data) {
        fileBuf.set(data, fileOff);
      } else {
        failedChunks.push(`FLASH  ${hex5(hwAddr)}`);
      }
      done++;
      onProgress({ pct: Math.round(100 * done / totalChunks), msg: `Flash  ${hex5(hwAddr)}` });
    }

    onProgress({
      pct: 100,
      msg: failedChunks.length
        ? `Done — ${failedChunks.length} chunk(s) unreadable (filled 0xFF)`
        : 'Done — all chunks read successfully',
    });
    return { buffer: fileBuf.buffer, failedChunks };

  } finally {
    if (acc)    { try { acc.releaseLock();    } catch (_) {} }
    if (writer) { try { writer.releaseLock(); } catch (_) {} }
    if (port)   { try { await port.close();   } catch (_) {} }
  }
}
