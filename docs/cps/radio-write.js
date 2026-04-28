'use strict';

// ClearDMR Web CPS — Write to Radio via USB CDC (normal operating mode)
//
// The firmware exposes a proprietary CDC protocol when running normally.
// USB VID/PID: 0x1FC9 / 0x0094 (usbd_desc.c)
//
// Write protocol: command 'X' (0x58), three sub-commands per 4 KB SPI Flash sector:
//
//   Sub 1 — Prepare sector (radio reads existing 4 KB into its sector buffer):
//     Request: [0x58, 0x01, sector_hi, sector_mid, sector_lo]  (5 bytes)
//
//   Sub 2 — Send data (overlay bytes into the sector buffer):
//     Request: [0x58, 0x02, addr_hi3, addr_hi2, addr_hi1, addr_lo, len_hi, len_lo, data...]
//
//   Sub 3 — Write sector (erase 4 KB + program from sector buffer):
//     Request: [0x58, 0x03]  (2 bytes)
//
//   Response on success: [0x58, subcommand]
//   Response on error:   ['-']
//
// Codeplug file layout (128 KB):
//   file[0x00000..0x0FFFF]  → EEPROM region  (SPI Flash hw addr = file addr)
//   file[0x10000..0x1FFFF]  → SPI Flash region (hw addr = file addr + 0x90000)
//
// FLASH_ADDRESS_OFFSET = 0x20000 (codeplug.h, MDUV380/RT84/DM1701).
// SPI Flash hw addr for second region = file offset + FLASH_ADDRESS_OFFSET + 0x70000
//   = file offset + 0x90000
//
// Entirely-0xFF sectors are skipped to avoid overwriting radio settings or
// calibration data that live in the same SPI Flash address space.

const CPWR_SERIAL_FILTERS = [{ usbVendorId: 0x1FC9, usbProductId: 0x0094 }];

const CPWR_CMD_BYTE    = 0x58;  // 'X'
const CPWR_SUB_PREPARE = 0x01;
const CPWR_SUB_SEND    = 0x02;
const CPWR_SUB_WRITE   = 0x03;
const CPWR_SECTOR_SIZE = 4096;
const CPWR_CHUNK       = 1024;  // data bytes per Send Data request (max 2040)
const CPWR_FILE_SIZE   = 0x20000;
const CPWR_HALF        = CPWR_FILE_SIZE >>> 1;   // 64 KB per region

// SPI Flash hw base for the second (SPI Flash) region:
//   file 0x10000 + FLASH_ADDRESS_OFFSET(0x20000) + 0x70000 = 0xA0000
const CPWR_FLASH_HW_BASE = 0xA0000;

// SerialAccumulator is defined in radio-read.js (loaded first); shared via global scope.

// Send a write request and verify the 2-byte success response [0x58, subCmd].
async function cpwrRequest(writer, acc, bytes, context) {
  await writer.write(bytes);
  const r = await acc.readExact(1);
  if (r[0] !== CPWR_CMD_BYTE) {
    const where = context ? ` (${context})` : '';
    throw new Error(
      `Radio returned an error during write${where}. ` +
      `Ensure the radio is powered on normally (not in DFU mode) and ` +
      `the port is not in use by another application. ` +
      `If the error persists, power-cycle the radio and try again.`
    );
  }
  await acc.readExact(1);  // subcommand echo
}

// Write one 4 KB sector to SPI Flash via Prepare → Send data → Write.
async function cpwrFlashSector(writer, acc, spiAddr, sectorData) {
  const sector  = Math.floor(spiAddr / CPWR_SECTOR_SIZE);
  const addrHex = '0x' + spiAddr.toString(16).toUpperCase().padStart(5, '0');

  // 1. Prepare: radio reads the current sector into its internal buffer.
  await cpwrRequest(writer, acc, new Uint8Array([
    CPWR_CMD_BYTE, CPWR_SUB_PREPARE,
    (sector >>> 16) & 0xFF,
    (sector >>>  8) & 0xFF,
     sector         & 0xFF,
  ]), `prepare sector ${addrHex}`);

  // 2. Send data in chunks, overlaying our bytes into the buffer.
  for (let i = 0; i < CPWR_SECTOR_SIZE; i += CPWR_CHUNK) {
    const len  = Math.min(CPWR_CHUNK, CPWR_SECTOR_SIZE - i);
    const addr = spiAddr + i;
    const req  = new Uint8Array(8 + len);
    req[0] = CPWR_CMD_BYTE; req[1] = CPWR_SUB_SEND;
    req[2] = (addr >>> 24) & 0xFF;
    req[3] = (addr >>> 16) & 0xFF;
    req[4] = (addr >>>  8) & 0xFF;
    req[5] =  addr         & 0xFF;
    req[6] = (len  >>>  8) & 0xFF;
    req[7] =  len          & 0xFF;
    req.set(sectorData.subarray(i, i + len), 8);
    await cpwrRequest(writer, acc, req, `send data ${addrHex}+${i}`);
  }

  // 3. Write: erase the 4 KB sector then program from the buffer.
  await cpwrRequest(writer, acc, new Uint8Array([CPWR_CMD_BYTE, CPWR_SUB_WRITE]),
    `erase/write sector ${addrHex}`);
}

// Drain any bytes left in the OS serial receive buffer from a previous session
// (e.g., a read session whose port was closed without consuming all bytes).
// Returns once no data arrives for DRAIN_MS consecutive milliseconds.
async function cpwrDrainBuffer(port) {
  const DRAIN_MS = 200;

  // Helper: read one chunk from the stream with a timeout.
  // Returns the data chunk, or null if the timeout fires first.
  async function readWithTimeout(reader, ms) {
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve(null), ms);
      reader.read().then(
        ({ value, done }) => { clearTimeout(timer); resolve(done ? null : (value ?? null)); },
        ()                => { clearTimeout(timer); resolve(null); }
      );
    });
  }

  const reader = port.readable.getReader();
  try {
    // Keep draining until DRAIN_MS elapses with no data.
    while (await readWithTimeout(reader, DRAIN_MS) !== null) { /* discard */ }
  } finally {
    try { reader.releaseLock(); } catch (_) {}
  }
}

// Write an ArrayBuffer codeplug to the radio via USB CDC.
// onProgress({ phase: 'write', pct: 0-100, msg: string })
async function cpwrWriteCodeplug(arrayBuffer, onProgress) {
  if (!navigator.serial) {
    throw new Error('Web Serial API not available. Use Chrome or Edge 89+.');
  }

  const src = new Uint8Array(arrayBuffer);

  let port = null, writer = null, acc = null;

  try {
    port = await navigator.serial.requestPort({ filters: CPWR_SERIAL_FILTERS });
    await port.open({ baudRate: 115200 });
    // Drain any stale bytes from the OS buffer before starting write commands.
    await cpwrDrainBuffer(port);
    writer = port.writable.getWriter();
    acc    = new SerialAccumulator(port.readable.getReader());

    // Collect all non-blank sectors. Skipping entirely-0xFF sectors preserves
    // radio settings / calibration data stored elsewhere in the same SPI Flash.
    const regions = [
      { fileBase: 0x00000,   hwBase: 0x00000,          label: 'EEPROM' },
      { fileBase: CPWR_HALF, hwBase: CPWR_FLASH_HW_BASE, label: 'SPI Flash' },
    ];
    const queue = [];
    for (const { fileBase, hwBase, label } of regions) {
      for (let i = 0; i < CPWR_HALF; i += CPWR_SECTOR_SIZE) {
        const data = src.subarray(fileBase + i, fileBase + i + CPWR_SECTOR_SIZE);
        if (!data.every(b => b === 0xFF)) {
          queue.push({ spiAddr: hwBase + i, data, label });
        }
      }
    }

    const total = queue.length;
    if (total === 0) throw new Error('Codeplug is blank — nothing to write.');

    onProgress({ phase: 'write', pct: 0, msg: `Writing ${total} sectors…` });

    for (let i = 0; i < total; i++) {
      const { spiAddr, data, label } = queue[i];
      await cpwrFlashSector(writer, acc, spiAddr, data);
      const pct = Math.round(((i + 1) / total) * 100);
      onProgress({ phase: 'write', pct, msg: `Writing ${label} sector ${i + 1} of ${total}…` });
    }

    return { ok: true };

  } finally {
    if (acc)    { try { acc.releaseLock();    } catch (_) {} }
    if (writer) { try { writer.releaseLock(); } catch (_) {} }
    if (port)   { try { await port.close();   } catch (_) {} }
  }
}
