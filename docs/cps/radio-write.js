'use strict';

// ClearDMR Web CPS — Write to Radio via USB CDC (normal operating mode)
//
// The firmware exposes a proprietary CDC protocol when running normally.
// USB VID/PID: 0x1FC9 / 0x0094 (usbd_desc.c)
//
// This file exposes the stable full-codeplug write path used by the production
// CPS UI, plus a separate boot-text-only experimental helper:
//
//   0x57 0x04 addr_be32 len_be16 payload...
//
// The radio acknowledges that path with a reply beginning `57 04`.
// Boot text lives at 0x7540 and is exactly 32 bytes:
//   - line 1 = 16 bytes
//   - line 2 = 16 bytes
//   - ASCII text, padded with 0xFF
//
// Production full-codeplug protocol: command 'X' (0x58), three sub-commands per
// 4 KB SPI Flash sector:
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
// Decompiled OpenGD77 CPS source is the reference model here.
// For STM32-based radios (MD-UV380 / RT84 / DM-1701 class), the CPS does not
// write a flat "EEPROM half + flash half" image. It writes five disjoint file
// segments, all via flash-sector overlay writes:
//
//   file 0x00080..0x05FFF -> radio 0x00080..0x05FFF
//   file 0x06000..0x06049 -> radio 0x06000..0x06049   (LUCZ block)
//   file 0x07500..0x0AFFF -> radio 0x07500..0x0AFFF
//   file 0x0B000..0x1EE5F -> radio 0x9B000..0xAEE5F
//   file 0x1EE60..0x1FFFF -> radio 0x20000..0x2119F   (OpenGD77 custom data)
//
// That behavior comes directly from OpenGD77Form.worker_DoWork(),
// WriteFlash(), and the STM32 flash-address offset handling in the
// decompiled OpenGD77 CPS.

const CPWR_SERIAL_FILTERS = [{ usbVendorId: 0x1FC9, usbProductId: 0x0094 }];

const CPWR_CMD_BYTE_X  = 0x58;  // 'X'
const CPWR_CMD_BYTE_W  = 0x57;  // 'W'
const CPWR_SUB_PREPARE = 0x01;
const CPWR_SUB_SEND    = 0x02;
const CPWR_SUB_WRITE   = 0x03;
const CPWR_SUB_BOOT_TEXT = 0x04;
const CPWR_SECTOR_SIZE = 4096;
const CPWR_CHUNK       = 1024;  // modern OpenGD77 CPS uses 1024-byte USB buffers
const CPWR_FILE_SIZE   = 0x20000;
const CPWR_BOOT_TEXT_OFFSET = 0x7540;
const CPWR_BOOT_TEXT_LENGTH = 32;
const CPWR_BOOT_TEXT_LINE_LENGTH = 16;
const CPWR_BOOT_TEXT_WRITE_SECTOR = 128;
const CPWR_CODEPLUG_SEGMENTS = [
  { fileStart: 0x00080, fileEnd: 0x06000, radioStart: 0x00080, label: 'Codeplug block 1' },
  { fileStart: 0x06000, fileEnd: 0x0604A, radioStart: 0x06000, label: 'Last used channels' },
  { fileStart: 0x07500, fileEnd: 0x0B000, radioStart: 0x07500, label: 'Codeplug block 2' },
  { fileStart: 0x0B000, fileEnd: 0x1EE60, radioStart: 0x9B000, label: 'Extended codeplug' },
  { fileStart: 0x1EE60, fileEnd: 0x20000, radioStart: 0x20000, label: 'OpenGD77 custom data' },
];

// SerialAccumulator is defined in radio-read.js (loaded first); shared via global scope.

// Send a write request and verify the expected acknowledgement prefix.
async function cpwrRequest(writer, acc, bytes, context, expectedPrefix = [bytes[0], bytes[1]]) {
  await writer.write(bytes);
  const first = await acc.readExact(1);
  if (first[0] !== expectedPrefix[0]) {
    const where = context ? ` (${context})` : '';
    throw new Error(
      `Radio returned an error during write${where}. ` +
      `Ensure the radio is powered on normally (not in DFU mode) and ` +
      `the port is not in use by another application. ` +
      `If the error persists, power-cycle the radio and try again.`
    );
  }
  if (expectedPrefix.length > 1) {
    const second = await acc.readExact(1);
    if (second[0] !== expectedPrefix[1]) {
      const where = context ? ` (${context})` : '';
      throw new Error(
        `Radio returned an unexpected acknowledgement during write${where}. ` +
        `Expected 0x${expectedPrefix[1].toString(16).toUpperCase().padStart(2, '0')}, ` +
        `received 0x${second[0].toString(16).toUpperCase().padStart(2, '0')}.`
      );
    }
  }
}

function cpwrNormalizeBootTextBytes(arrayBuffer) {
  const src = new Uint8Array(arrayBuffer);
  if (src.length < CPWR_FILE_SIZE) {
    throw new Error(`Codeplug is ${src.length} bytes — expected ${CPWR_FILE_SIZE}.`);
  }

  const out = new Uint8Array(CPWR_BOOT_TEXT_LENGTH);
  out.fill(0xFF);

  for (let line = 0; line < 2; line++) {
    const srcBase = CPWR_BOOT_TEXT_OFFSET + line * CPWR_BOOT_TEXT_LINE_LENGTH;
    const dstBase = line * CPWR_BOOT_TEXT_LINE_LENGTH;
    let dstPos = dstBase;
    for (let i = 0; i < CPWR_BOOT_TEXT_LINE_LENGTH; i++) {
      const b = src[srcBase + i];
      if (b === 0x00 || b === 0xFF) break;
      if (b < 0x20 || b > 0x7E) {
        throw new Error(
          `Boot text line ${line + 1} contains a non-ASCII byte 0x${b.toString(16).toUpperCase().padStart(2, '0')}.`
        );
      }
      out[dstPos++] = b;
    }
  }

  return out;
}

function cpwrEnsureSingleWriteSector(address, length, sectorSize) {
  const startSector = Math.floor(address / sectorSize);
  const endSector = Math.floor((address + length - 1) / sectorSize);
  if (startSector !== endSector) {
    throw new Error(
      `Refusing boot text write across ${sectorSize}-byte sector boundary ` +
      `(0x${address.toString(16).toUpperCase()} + 0x${length.toString(16).toUpperCase()}).`
    );
  }
}

async function cpwrWriteBootTextFrame(writer, acc, payload) {
  const req = new Uint8Array(8 + payload.length);
  req[0] = CPWR_CMD_BYTE_W;
  req[1] = CPWR_SUB_BOOT_TEXT;
  req[2] = (CPWR_BOOT_TEXT_OFFSET >>> 24) & 0xFF;
  req[3] = (CPWR_BOOT_TEXT_OFFSET >>> 16) & 0xFF;
  req[4] = (CPWR_BOOT_TEXT_OFFSET >>> 8) & 0xFF;
  req[5] = CPWR_BOOT_TEXT_OFFSET & 0xFF;
  req[6] = (payload.length >>> 8) & 0xFF;
  req[7] = payload.length & 0xFF;
  req.set(payload, 8);
  await cpwrRequest(writer, acc, req, 'write boot text', [CPWR_CMD_BYTE_W, CPWR_SUB_BOOT_TEXT]);
}

function cpwrVerifyBootTextExact(expected, actual) {
  if (actual.length !== expected.length) {
    throw new Error(`Boot text verify failed: expected ${expected.length} bytes, read ${actual.length}.`);
  }
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) {
      throw new Error(
        `Boot text verify mismatch at 0x${(CPWR_BOOT_TEXT_OFFSET + i).toString(16).toUpperCase()}: ` +
        `wrote 0x${expected[i].toString(16).toUpperCase().padStart(2, '0')}, ` +
        `read 0x${actual[i].toString(16).toUpperCase().padStart(2, '0')}.`
      );
    }
  }
}

async function cpwrPrepareSector(writer, acc, address, writeByte) {
  const sector = Math.floor(address / CPWR_SECTOR_SIZE);
  await cpwrRequest(writer, acc, new Uint8Array([
    writeByte, CPWR_SUB_PREPARE,
    (sector >>> 16) & 0xFF,
    (sector >>>  8) & 0xFF,
     sector         & 0xFF,
  ]), `prepare sector 0x${address.toString(16).toUpperCase().padStart(5, '0')}`);
}

async function cpwrSendData(writer, acc, address, data, writeByte) {
  const req = new Uint8Array(8 + data.length);
  req[0] = writeByte;
  req[1] = CPWR_SUB_SEND;
  req[2] = (address >>> 24) & 0xFF;
  req[3] = (address >>> 16) & 0xFF;
  req[4] = (address >>>  8) & 0xFF;
  req[5] =  address         & 0xFF;
  req[6] = (data.length >>> 8) & 0xFF;
  req[7] =  data.length         & 0xFF;
  req.set(data, 8);
  await cpwrRequest(writer, acc, req, `send data 0x${address.toString(16).toUpperCase().padStart(5, '0')}`);
}

async function cpwrWriteSector(writer, acc, address, writeByte) {
  await cpwrRequest(
    writer,
    acc,
    new Uint8Array([writeByte, CPWR_SUB_WRITE]),
    `erase/write sector 0x${address.toString(16).toUpperCase().padStart(5, '0')}`
  );
}

async function cpwrWriteSegment(writer, acc, src, segment, progressState, onProgress, writeByte, chunkSize) {
  let radioAddr = segment.radioStart >>> 0;
  let filePos = segment.fileStart >>> 0;
  const totalLen = (segment.fileEnd - segment.fileStart) >>> 0;
  let sector = -1;

  while (filePos < segment.fileEnd) {
    if (sector === -1) {
      await cpwrPrepareSector(writer, acc, radioAddr, writeByte);
      sector = Math.floor(radioAddr / CPWR_SECTOR_SIZE);
    }

    const sectorRemaining = ((sector + 1) * CPWR_SECTOR_SIZE) - radioAddr;
    const len = Math.min(chunkSize, segment.fileEnd - filePos, sectorRemaining);
    await cpwrSendData(writer, acc, radioAddr, src.subarray(filePos, filePos + len), writeByte);

    radioAddr += len;
    filePos += len;
    progressState.bytesWritten += len;
    const pct = Math.round((progressState.bytesWritten / progressState.totalBytes) * 100);
    onProgress({
      phase: 'write',
      pct,
      msg: `Writing ${segment.label} (${filePos - segment.fileStart}/${totalLen} bytes)…`,
    });

    if (Math.floor(radioAddr / CPWR_SECTOR_SIZE) !== sector) {
      await cpwrWriteSector(writer, acc, radioAddr - 1, writeByte);
      sector = -1;
    }
  }

  if (sector !== -1) {
    await cpwrWriteSector(writer, acc, radioAddr - 1, writeByte);
  }
}

async function cpwrBeginCodeplugWriteTask(writer, acc) {
  await cprdSendPreambleCommand(writer, acc, 1, { context: 'begin write task 0x1' });
  await cprdSendPreambleCommand(writer, acc, 2, { y: 0,  size: 3, alignment: 1, message: 'CPS', context: 'begin write task line 1' });
  await cprdSendPreambleCommand(writer, acc, 2, { y: 16, size: 3, alignment: 1, message: 'Writing', context: 'begin write task line 2' });
  await cprdSendPreambleCommand(writer, acc, 2, { y: 32, size: 3, alignment: 1, message: 'Codeplug', context: 'begin write task line 3' });
  await cprdSendPreambleCommand(writer, acc, 3, { context: 'begin write task display refresh' });
  await cprdSendPreambleCommand(writer, acc, 6, { xOrOption: 4, context: 'begin write task status mode 4' });
  await cprdSendPreambleCommand(writer, acc, 6, { xOrOption: 2, context: 'begin write task status mode 2' });
}

async function cpwrEndCodeplugWriteTask(writer, acc) {
  await cprdSendPreambleCommand(writer, acc, 6, { xOrOption: 0, context: 'end write task status mode 0' });
}

async function cpwrVerifySegments(writer, acc, src, chunkSize, onProgress) {
  const totalBytes = CPWR_CODEPLUG_SEGMENTS.reduce((sum, segment) => sum + (segment.fileEnd - segment.fileStart), 0);
  let verified = 0;

  for (const segment of CPWR_CODEPLUG_SEGMENTS) {
    let filePos = segment.fileStart;
    let radioAddr = segment.radioStart;

    while (filePos < segment.fileEnd) {
      const len = Math.min(chunkSize, segment.fileEnd - filePos);
      const data = await cprdReadChunk(writer, acc, CPRD_MODE_READ_FLASH, radioAddr, len, 0);
      if (!data || data.length !== len) {
        throw new Error(`Verification read failed at 0x${radioAddr.toString(16).toUpperCase().padStart(5, '0')}.`);
      }
      const expected = src.subarray(filePos, filePos + len);
      for (let i = 0; i < len; i++) {
        if (data[i] !== expected[i]) {
          const fileAddr = filePos + i;
          const radioMismatch = radioAddr + i;
          throw new Error(
            `Verification mismatch at file 0x${fileAddr.toString(16).toUpperCase().padStart(5, '0')} ` +
            `(radio 0x${radioMismatch.toString(16).toUpperCase().padStart(5, '0')}): ` +
            `wrote 0x${expected[i].toString(16).toUpperCase().padStart(2, '0')}, ` +
            `read 0x${data[i].toString(16).toUpperCase().padStart(2, '0')}.`
          );
        }
      }

      filePos += len;
      radioAddr += len;
      verified += len;
      const pct = Math.round((verified / totalBytes) * 100);
      onProgress?.({
        phase: 'verify',
        pct,
        msg: `Verifying ${segment.label} (${filePos - segment.fileStart}/${segment.fileEnd - segment.fileStart} bytes)…`,
      });
    }
  }
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

async function cpwrWriteCodeplug(arrayBuffer, onProgress, options = {}) {
  if (!navigator.serial) {
    throw new Error('Web Serial API not available. Use Chrome or Edge 89+.');
  }

  const src = new Uint8Array(arrayBuffer);

  let session = null;
  let taskMode = null;

  try {
    session = await cprdOpenSerialSession(CPWR_SERIAL_FILTERS, 'cpwrWriteCodeplug', { claimIO: false });
    const { port } = session;
    await cpwrDrainBuffer(port);
    cprdClaimSerialSessionIO(session);
    session.writer.__cprdSession = session;
    const { writer, acc } = session;
    await cprdPrimeRadioConnection(writer, acc);
    const radioInfo = await cprdReadRadioInfo(writer, acc);
    if (!radioInfo.isSTM32) {
      throw new Error(`Unsupported radio type ${radioInfo.radioType}. This write path is hardened only for STM32-family radios.`);
    }
    await cpwrBeginCodeplugWriteTask(writer, acc);
    taskMode = 'write';
    const writeByte = radioInfo.isSTM32 ? CPWR_CMD_BYTE_X : CPWR_CMD_BYTE_W;
    const chunkSize = Math.min(CPWR_CHUNK, radioInfo.usbBufferSize);

    if (src.length < CPWR_FILE_SIZE) {
      throw new Error(`Codeplug is ${src.length} bytes — expected ${CPWR_FILE_SIZE}.`);
    }

    const progressState = {
      bytesWritten: 0,
      totalBytes: CPWR_CODEPLUG_SEGMENTS.reduce((sum, segment) => sum + (segment.fileEnd - segment.fileStart), 0),
    };
    onProgress({ phase: 'write', pct: 0, msg: 'Writing codeplug segments…' });

    for (const segment of CPWR_CODEPLUG_SEGMENTS) {
      await cpwrWriteSegment(writer, acc, src, segment, progressState, onProgress, writeByte, chunkSize);
    }

    if (options.verifyAfterWrite) {
      await cpwrEndCodeplugWriteTask(writer, acc);
      taskMode = null;
      await cprdBeginCodeplugReadTask(writer, acc);
      taskMode = 'read';
      await cpwrVerifySegments(writer, acc, src, chunkSize, onProgress);
      await cprdEndCodeplugReadTask(writer, acc);
      taskMode = null;
    } else {
      await cpwrEndCodeplugWriteTask(writer, acc);
      taskMode = null;
    }

    return { ok: true, radioInfo };

  } finally {
    if (taskMode === 'write' && session?.writer && session?.acc) {
      try { await cpwrEndCodeplugWriteTask(session.writer, session.acc); } catch (_) {}
    }
    if (taskMode === 'read' && session?.writer && session?.acc) {
      try { await cprdEndCodeplugReadTask(session.writer, session.acc); } catch (_) {}
    }
    await cprdCloseSerialSession(session, taskMode ? `write operation aborted during ${taskMode}` : 'write operation completed');
  }
}

// Write only the boot text block to the radio and verify it with an immediate
// exact readback.
async function cpwrWriteBootText(arrayBuffer, onProgress) {
  if (!navigator.serial) {
    throw new Error('Web Serial API not available. Use Chrome or Edge 89+.');
  }

  const bootTextBytes = cpwrNormalizeBootTextBytes(arrayBuffer);
  cpwrEnsureSingleWriteSector(
    CPWR_BOOT_TEXT_OFFSET,
    CPWR_BOOT_TEXT_LENGTH,
    CPWR_BOOT_TEXT_WRITE_SECTOR
  );

  let session = null;
  let readTaskStarted = false;

  try {
    onProgress?.({ phase: 'write', pct: 0, msg: 'Connecting…' });
    session = await cprdOpenSerialSession(CPWR_SERIAL_FILTERS, 'cpwrWriteBootText', { claimIO: false });
    const { port } = session;
    // Drain any stale bytes from the OS buffer before starting write commands.
    await cpwrDrainBuffer(port);
    cprdClaimSerialSessionIO(session);
    session.writer.__cprdSession = session;
    const { writer, acc } = session;
    await cprdPrimeRadioConnection(writer, acc);
    const radioInfo = await cprdReadRadioInfo(writer, acc);
    if (!radioInfo.isSTM32) {
      throw new Error(`Unsupported radio type ${radioInfo.radioType}. This boot-text write path is hardened only for STM32-family radios.`);
    }
    onProgress?.({ phase: 'write', pct: 35, msg: 'Writing boot text…' });
    await cpwrWriteBootTextFrame(writer, acc, bootTextBytes);
    await cprdBeginCodeplugReadTask(writer, acc);
    readTaskStarted = true;
    onProgress?.({ phase: 'verify', pct: 70, msg: 'Reading back boot text…' });
    const readBack = await cprdReadChunk(writer, acc, CPRD_MODE_READ_FLASH, CPWR_BOOT_TEXT_OFFSET, CPWR_BOOT_TEXT_LENGTH, 0);
    cpwrVerifyBootTextExact(bootTextBytes, readBack);
    await cprdEndCodeplugReadTask(writer, acc);
    readTaskStarted = false;

    return { ok: true, radioInfo, bytes: bootTextBytes.slice() };

  } finally {
    if (readTaskStarted && session?.writer && session?.acc) {
      try { await cprdEndCodeplugReadTask(session.writer, session.acc); } catch (_) {}
    }
    await cprdCloseSerialSession(session, readTaskStarted ? 'boot text write aborted during verify' : 'boot text write completed');
  }
}
