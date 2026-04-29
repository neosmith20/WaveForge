'use strict';

// ClearDMR Web CPS — Radio Read via USB CDC (normal operating mode)
//
// Source-backed OpenGD77 CPS map for STM32 radios (MD-UV380 / RT84 / DM-1701):
// - USB area 1 = direct SPI flash reads in usb_com.c
// - USB area 2 = direct EEPROM reads in usb_com.c
// - Decompiled OpenGD77 CPS readCodeplug() reads five disjoint segments and
//   reconstructs the 128 KB codeplug file in local memory.
// - For STM32 radios, all five segments are read from flash, not EEPROM:
//     file 0x00080..0x05FFF <- radio 0x00080..0x05FFF
//     file 0x06000..0x06049 <- radio 0x06000..0x06049
//     file 0x07500..0x0AFFF <- radio 0x07500..0x0AFFF
//     file 0x0B000..0x1EE5F <- radio 0x9B000..0xAEE5F
//     file 0x1EE60..0x1FFFF <- radio 0x20000..0x2119F
//
// Raw range dump is still available for targeted inspection, but the new
// cpreadReadCodeplug() path now mirrors the original OpenGD77 CPS segment map.

const CPRD_VERSION        = 'radio-read.js 2026-04-28 cps-map-v1';
const CPRD_SERIAL_FILTERS = [{ usbVendorId: 0x1FC9, usbProductId: 0x0094 }];
const CPRD_MAX_CHUNK      = 2045; // firmware-side request cap
const CPRD_MAX_RETRIES    = 0;    // keep pressure low; no hammering
const CPRD_CODEPLUG_SIZE  = 0x20000;
const CPRD_CODEPLUG_CHUNK = 1024;
const CPRD_CMD_BYTE       = 0x43; // 'C'
const CPRD_READ_BYTE      = 0x52; // 'R'
const CPRD_MODE_READ_FLASH      = 0x01;
const CPRD_MODE_READ_EEPROM     = 0x02;
const CPRD_MODE_READ_RADIO_INFO = 0x09;
const CPRD_BUFFER_DATE_CUTOFF   = 20211002;
const CPRD_STM32_RADIO_TYPES    = new Set([5, 6, 7, 8, 9, 10]);
const CPRD_CODEPLUG_SEGMENTS = [
  { fileStart: 0x00080, fileEnd: 0x06000, area: 1, radioStart: 0x00080, label: 'Codeplug block 1' },
  { fileStart: 0x06000, fileEnd: 0x0604A, area: 1, radioStart: 0x06000, label: 'Last used channels' },
  { fileStart: 0x07500, fileEnd: 0x0B000, area: 1, radioStart: 0x07500, label: 'Codeplug block 2' },
  { fileStart: 0x0B000, fileEnd: 0x1EE60, area: 1, radioStart: 0x9B000, label: 'Extended codeplug' },
  { fileStart: 0x1EE60, fileEnd: 0x20000, area: 1, radioStart: 0x20000, label: 'OpenGD77 custom data' },
];

window.__CPRD_VERSION__ = CPRD_VERSION;
console.info(`[CPRD] loaded ${CPRD_VERSION}`);
window.addEventListener('DOMContentLoaded', () => {
  const el = document.getElementById('radio-read-version');
  if (el) el.textContent = CPRD_VERSION;
});

function cprdDelay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const CPRD_SERIAL_SESSION_STATE = {
  port: null,
  owner: null,
};

function cprdDescribePort(port) {
  if (!port) return '(none)';
  const info = typeof port.getInfo === 'function' ? port.getInfo() : {};
  const vid = Number.isFinite(info.usbVendorId) ? `0x${info.usbVendorId.toString(16).toUpperCase()}` : '?';
  const pid = Number.isFinite(info.usbProductId) ? `0x${info.usbProductId.toString(16).toUpperCase()}` : '?';
  return `${vid}/${pid}`;
}

function cprdIsPortOpen(port) {
  return !!(port && port.readable && port.writable);
}

function cprdNormalizeOpenError(err) {
  const message = String(err?.message || err || '');
  if (/Failed to open serial port/i.test(message) || /already open/i.test(message)) {
    return new Error(
      'Could not open the selected radio port. The browser or another CPS session may still have it open. ' +
      'Close any previous radio tab/session, unplug/replug the USB cable if needed, and try again.'
    );
  }
  return err instanceof Error ? err : new Error(message || 'Failed to open serial port.');
}

async function cprdCloseSerialSession(session, reason = '') {
  if (!session) return;
  const tag = session.tag || 'serial';
  if (session.acc) {
    try { session.acc.releaseLock(); } catch (_) {}
    session.acc = null;
  }
  if (session.writer) {
    try { session.writer.releaseLock(); } catch (_) {}
    session.writer = null;
  }
  if (session.reader) {
    try { session.reader.releaseLock(); } catch (_) {}
    session.reader = null;
  }
  if (session.port) {
    console.info(`[CPRD] port close requested (${tag})${reason ? `: ${reason}` : ''}`, {
      port: cprdDescribePort(session.port),
    });
    try { await session.port.close(); } catch (_) {}
  }
  if (CPRD_SERIAL_SESSION_STATE.port === session.port) {
    CPRD_SERIAL_SESSION_STATE.port = null;
    CPRD_SERIAL_SESSION_STATE.owner = null;
  }
}

function cprdClaimSerialSessionIO(session) {
  if (!session) throw new Error('Serial session is required.');
  if (session.reader || session.writer || session.acc) return session;
  try {
    session.reader = session.port.readable.getReader();
    session.writer = session.port.writable.getWriter();
    session.acc = new SerialAccumulator(session.reader);
  } catch (err) {
    try { session.writer?.releaseLock(); } catch (_) {}
    try { session.reader?.releaseLock(); } catch (_) {}
    session.writer = null;
    session.reader = null;
    session.acc = null;
    throw cprdNormalizeOpenError(err);
  }
  return session;
}

async function cprdOpenSerialSession(filters, tag, options = {}) {
  const { claimIO = true } = options;
  if (CPRD_SERIAL_SESSION_STATE.port) {
    console.info(`[CPRD] stale port close requested before new open (${tag})`, {
      owner: CPRD_SERIAL_SESSION_STATE.owner,
      port: cprdDescribePort(CPRD_SERIAL_SESSION_STATE.port),
      alreadyOpen: cprdIsPortOpen(CPRD_SERIAL_SESSION_STATE.port),
    });
    await cprdCloseSerialSession({
      port: CPRD_SERIAL_SESSION_STATE.port,
      writer: null,
      reader: null,
      acc: null,
      tag: CPRD_SERIAL_SESSION_STATE.owner || 'stale-session',
    }, 'stale session detected');
  }

  const port = await navigator.serial.requestPort({ filters });
  console.info(`[CPRD] port selected (${tag})`, {
    port: cprdDescribePort(port),
    alreadyOpen: cprdIsPortOpen(port),
  });

  if (cprdIsPortOpen(port)) {
    console.info(`[CPRD] port already open (${tag})`, {
      port: cprdDescribePort(port),
    });
  } else {
    console.info(`[CPRD] port open requested (${tag})`, {
      port: cprdDescribePort(port),
    });
    try {
      await port.open({
        baudRate: 115200,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        bufferSize: 1032,
        flowControl: 'none',
      });
      if (typeof port.setSignals === 'function') {
        try {
          await port.setSignals({
            dataTerminalReady: false,
            requestToSend: false,
            break: false,
          });
        } catch (signalErr) {
          console.debug('[CPRD] setSignals not applied', signalErr);
        }
      }
      console.log(`[CPRD] port open success (${tag})`, {
        port: cprdDescribePort(port),
        baudRate: 115200,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        flowControl: 'none',
      });
    } catch (err) {
      throw cprdNormalizeOpenError(err);
    }
  }

  const session = { port, reader: null, writer: null, acc: null, tag, commandCount: 0 };
  CPRD_SERIAL_SESSION_STATE.port = port;
  CPRD_SERIAL_SESSION_STATE.owner = tag;
  return claimIO ? cprdClaimSerialSessionIO(session) : session;
}

function cprdHexBytes(data, count = 8) {
  if (!data) return '(none)';
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return Array.from(bytes.subarray(0, count), b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
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
    const out = this._pending.slice(0, n);
    this._pending = this._pending.slice(n);
    return out;
  }

  clearPending() {
    this._pending = new Uint8Array(0);
  }

  async drainQuiet(_idleMs = 50) {
    this.clearPending();
  }

  releaseLock() { this._reader.releaseLock(); }
}

function cprdDecodeCString(bytes, offset, len) {
  const slice = bytes.slice(offset, offset + len);
  let end = slice.indexOf(0);
  if (end < 0) end = slice.length;
  return new TextDecoder('ascii').decode(slice.slice(0, end)).trim();
}

function cprdParseRadioInfo(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const buildDateTime = cprdDecodeCString(bytes, 24, 16);
  const buildDate = Number.parseInt(buildDateTime.slice(0, 8), 10);
  const radioType = v.getUint32(4, true);
  const features = bytes.byteLength >= 46 ? v.getUint16(44, true) : 0;
  const structVersion = v.getUint32(0, true);
  return {
    structVersion,
    radioType,
    gitRevision: cprdDecodeCString(bytes, 8, 16),
    buildDateTime,
    flashId: v.getUint32(40, true),
    features,
    isSTM32: CPRD_STM32_RADIO_TYPES.has(radioType),
    usesOldUsbBufferSize: !(Number.isFinite(buildDate) && buildDate > CPRD_BUFFER_DATE_CUTOFF),
    usbBufferSize: (Number.isFinite(buildDate) && buildDate > CPRD_BUFFER_DATE_CUTOFF) ? 1024 : 32,
  };
}

async function cprdSendCommand(writer, acc, commandNumber, options = {}) {
  const {
    xOrOption = 0,
    y = 0,
    size = 0,
    alignment = 0,
    inverted = 0,
    message = '',
    fatal = true,
    context = '',
  } = options;

  const req = new Uint8Array(32);
  let len = 2;
  req[0] = CPRD_CMD_BYTE;
  req[1] = commandNumber & 0xFF;

  if (commandNumber === 2) {
    const encoded = new TextEncoder().encode(String(message).slice(0, 16));
    req[3] = y & 0xFF;
    req[4] = size & 0xFF;
    req[5] = alignment & 0xFF;
    req[6] = inverted & 0xFF;
    req.set(encoded, 7);
    len = 7 + encoded.length;
  } else if (commandNumber === 6) {
    req[2] = xOrOption & 0xFF;
    len = 3;
  }

  const session = writer && writer.__cprdSession;
  if (session && session.commandCount === 0) {
    console.log('[CPRD] first command bytes sent', {
      command: `0x${commandNumber.toString(16).toUpperCase()}`,
      bytes: Array.from(req.subarray(0, len), b => `0x${b.toString(16).toUpperCase().padStart(2, '0')}`),
      context: context || undefined,
    });
  }
  await writer.write(req.subarray(0, len));
  // Native CPS waits for pending writes to clear and then sleeps 50 ms.
  await cprdDelay(50);
  const ack = await acc.readExact(2);
  if (session && session.commandCount === 0) {
    console.log('[CPRD] first ack bytes received', {
      command: `0x${commandNumber.toString(16).toUpperCase()}`,
      ack: Array.from(ack, b => `0x${b.toString(16).toUpperCase().padStart(2, '0')}`),
      context: context || undefined,
    });
  }
  if (session) session.commandCount++;
  if (ack[1] !== (commandNumber & 0xFF)) {
    const commandHex = `0x${commandNumber.toString(16).toUpperCase()}`;
    const ackHex = cprdHexBytes(ack, 2);
    const suffix = context ? ` (${context})` : '';
    if (fatal) {
      throw new Error(`Radio rejected command ${commandHex}${suffix}. Ack=${ackHex}.`);
    }
    console.warn(`[CPRD] non-fatal command rejected: ${commandHex}${suffix}. Ack=${ackHex}.`);
    return false;
  }
  return true;
}

async function cprdSendPreambleCommand(writer, acc, commandNumber, options = {}) {
  return cprdSendCommand(writer, acc, commandNumber, { ...options, fatal: false });
}

async function cprdPrimeRadioConnection(writer, acc, { stealth = false } = {}) {
  // Decompiled OpenGD77 CPS probe sequence:
  // 1. sendCommand(..., 254) and ignore the result
  // 2. DiscardInBuffer()
  // 3. sendCommand(..., stealth ? 254 : 0) and hard-fail if rejected
  await cprdSendPreambleCommand(writer, acc, 0xFE, { context: 'probe preamble 0xFE' });
  await acc.drainQuiet(50);
  await cprdSendCommand(writer, acc, stealth ? 0xFE : 0x00, {
    context: stealth ? 'probe stealth handshake 0xFE' : 'connect/entry handshake',
  });
}

async function cprdReadRadioInfo(writer, acc, { stealth = false } = {}) {
  if (!stealth) {
    await cprdSendPreambleCommand(writer, acc, 0, { context: 'radio info preamble 0x0' });
    await cprdSendPreambleCommand(writer, acc, 1, { context: 'radio info preamble 0x1' });
    await cprdSendPreambleCommand(writer, acc, 2, { y: 0,  size: 3, alignment: 1, message: 'CPS', context: 'radio info title line 1' });
    await cprdSendPreambleCommand(writer, acc, 2, { y: 16, size: 3, alignment: 1, message: 'Read', context: 'radio info title line 2' });
    await cprdSendPreambleCommand(writer, acc, 2, { y: 32, size: 3, alignment: 1, message: 'Radio', context: 'radio info title line 3' });
    await cprdSendPreambleCommand(writer, acc, 2, { y: 48, size: 3, alignment: 1, message: 'Info', context: 'radio info title line 4' });
    await cprdSendPreambleCommand(writer, acc, 3, { context: 'radio info display refresh' });
    await cprdSendPreambleCommand(writer, acc, 6, { xOrOption: 4, context: 'radio info status mode' });
  }

  const req = new Uint8Array(8);
  req[0] = CPRD_READ_BYTE;
  req[1] = CPRD_MODE_READ_RADIO_INFO;
  await writer.write(req);

  const status = await acc.readExact(1);
  if (status[0] !== CPRD_READ_BYTE) {
    throw new Error('Radio info read failed.');
  }
  const lenBytes = await acc.readExact(2);
  const len = (lenBytes[0] << 8) | lenBytes[1];
  const payload = await acc.readExact(len);

  if (!stealth) {
    await cprdSendPreambleCommand(writer, acc, 5, { context: 'radio info teardown' });
  }

  return cprdParseRadioInfo(payload);
}

async function cprdBeginCodeplugReadTask(writer, acc) {
  await cprdSendPreambleCommand(writer, acc, 1, { context: 'begin read task 0x1' });
  await cprdSendPreambleCommand(writer, acc, 2, { y: 0,  size: 3, alignment: 1, message: 'CPS', context: 'begin read task line 1' });
  await cprdSendPreambleCommand(writer, acc, 2, { y: 16, size: 3, alignment: 1, message: 'Reading', context: 'begin read task line 2' });
  await cprdSendPreambleCommand(writer, acc, 2, { y: 32, size: 3, alignment: 1, message: 'Codeplug', context: 'begin read task line 3' });
  await cprdSendPreambleCommand(writer, acc, 3, { context: 'begin read task display refresh' });
  await cprdSendPreambleCommand(writer, acc, 6, { xOrOption: 3, context: 'begin read task status mode 3' });
  await cprdSendPreambleCommand(writer, acc, 6, { xOrOption: 2, context: 'begin read task status mode 2' });
}

async function cprdEndCodeplugReadTask(writer, acc) {
  await cprdSendPreambleCommand(writer, acc, 5, { context: 'end read task 0x5' });
  await cprdSendPreambleCommand(writer, acc, 7, { context: 'end read task 0x7' });
}

async function cprdRequest(writer, acc, area, address, length, interReadDelayMs) {
  if (interReadDelayMs > 0) await cprdDelay(interReadDelayMs);

  const req = new Uint8Array(8);
  req[0] = 0x52; // 'R'
  req[1] = area & 0xFF;
  req[2] = (address >>> 24) & 0xFF;
  req[3] = (address >>> 16) & 0xFF;
  req[4] = (address >>>  8) & 0xFF;
  req[5] =  address         & 0xFF;
  req[6] = (length  >>>  8) & 0xFF;
  req[7] =  length          & 0xFF;
  await writer.write(req);

  const status = await acc.readExact(1);
  if (status[0] !== 0x52) return null;
  const lenBytes = await acc.readExact(2);
  const respLen = (lenBytes[0] << 8) | lenBytes[1];
  return acc.readExact(respLen);
}

async function cprdReadChunk(writer, acc, area, address, length, interReadDelayMs) {
  for (let attempt = 0; attempt <= CPRD_MAX_RETRIES; attempt++) {
    const data = await cprdRequest(writer, acc, area, address, length, interReadDelayMs);
    if (data) {
      const sliced = data.subarray(0, length);
      console.debug('[CPRD] response', {
        version: CPRD_VERSION,
        area,
        address: `0x${address.toString(16).toUpperCase().padStart(5, '0')}`,
        length: `0x${length.toString(16).toUpperCase()}`,
        first8: cprdHexBytes(sliced, 8),
      });
      return sliced;
    }
  }
  console.debug('[CPRD] response', {
    version: CPRD_VERSION,
    area,
    address: `0x${address.toString(16).toUpperCase().padStart(5, '0')}`,
    length: `0x${length.toString(16).toUpperCase()}`,
    first8: '(read failed)',
  });
  return null;
}

async function cpreadReadCodeplug(onProgress, options = {}) {
  if (!navigator.serial) {
    throw new Error('Web Serial API not available. Use Chrome or Edge 89+.');
  }

  const interReadDelayMs = Math.max(0, Number(options.interReadDelayMs) || 0);
  const totalBytes = CPRD_CODEPLUG_SEGMENTS.reduce((sum, segment) => sum + (segment.fileEnd - segment.fileStart), 0);
  const out = new Uint8Array(CPRD_CODEPLUG_SIZE);
  out.fill(0xFF);

  let session = null;
  let bytesRead = 0;
  let taskStarted = false;
  let chunkSize = Math.min(
    CPRD_MAX_CHUNK,
    Math.max(1, Number(options.chunkSize) || CPRD_CODEPLUG_CHUNK)
  );

  try {
    session = await cprdOpenSerialSession(CPRD_SERIAL_FILTERS, 'cpreadReadCodeplug');
    session.writer.__cprdSession = session;
    const { writer, acc } = session;

    await cprdPrimeRadioConnection(writer, acc);
    const radioInfo = await cprdReadRadioInfo(writer, acc);
    if (!radioInfo.isSTM32) {
      throw new Error(`Unsupported radio type ${radioInfo.radioType}. This browser CPS path currently matches the STM32-family OpenGD77 CPS model only.`);
    }
    await cprdBeginCodeplugReadTask(writer, acc);
    taskStarted = true;
    chunkSize = Math.min(
      CPRD_MAX_CHUNK,
      Math.max(1, Number(options.chunkSize) || radioInfo.usbBufferSize)
    );

    for (const segment of CPRD_CODEPLUG_SEGMENTS) {
      let filePos = segment.fileStart;
      let radioAddr = segment.radioStart;

      while (filePos < segment.fileEnd) {
        const len = Math.min(chunkSize, segment.fileEnd - filePos);
        const data = await cprdReadChunk(writer, acc, segment.area, radioAddr, len, interReadDelayMs);
        if (!data || data.length !== len) {
          throw new Error(
            `Read failed at area=${segment.area} addr=0x${radioAddr.toString(16).toUpperCase().padStart(5, '0')} ` +
            `len=0x${len.toString(16).toUpperCase()}`
          );
        }

        out.set(data, filePos);
        filePos += len;
        radioAddr += len;
        bytesRead += len;

        const pct = Math.round((bytesRead / totalBytes) * 100);
        onProgress?.({
          pct,
          msg: `Reading ${segment.label} 0x${segment.radioStart.toString(16).toUpperCase().padStart(5, '0')}…`,
        });
      }
    }

    return {
      ok: true,
      buffer: out.buffer,
      bytesRead,
      metadata: {
        version: CPRD_VERSION,
        chunkSize,
        interReadDelayMs,
        totalBytes,
        radioInfo,
      },
    };
  } finally {
    if (taskStarted && session?.writer && session?.acc) {
      try { await cprdEndCodeplugReadTask(session.writer, session.acc); } catch (_) {}
    }
    await cprdCloseSerialSession(session, taskStarted ? 'read operation completed' : 'read operation ended early');
  }
}

async function cprawDumpRange(options, onProgress) {
  const area = Number(options.area);
  const start = Number(options.start) >>> 0;
  const length = Number(options.length) >>> 0;
  const chunkSize = Number(options.chunkSize) >>> 0;
  const interReadDelayMs = Number(options.interReadDelayMs);

  if (!(area === 1 || area === 2)) throw new Error('Area must be 1 or 2.');
  if (length === 0) throw new Error('Length must be greater than zero.');
  if (chunkSize === 0) throw new Error('Chunk size must be greater than zero.');
  if (chunkSize > CPRD_MAX_CHUNK) throw new Error(`Chunk size must be <= 0x${CPRD_MAX_CHUNK.toString(16).toUpperCase()}.`);
  if (!Number.isFinite(interReadDelayMs) || interReadDelayMs < 0) throw new Error('Inter-read delay must be 0 or greater.');

  if (!navigator.serial) {
    throw new Error('Web Serial API not available. Use Chrome or Edge 89+.');
  }

  let session = null;

  const chunks = [];
  const totalChunks = Math.ceil(length / chunkSize);
  let bytesRead = 0;
  let failedAt = null;
  let errorMessage = null;

  try {
    session = await cprdOpenSerialSession(CPRD_SERIAL_FILTERS, 'cprawDumpRange');
    session.writer.__cprdSession = session;
    const { writer, acc } = session;

    for (let offset = 0, chunkIndex = 0; offset < length; offset += chunkSize, chunkIndex++) {
      const len = Math.min(chunkSize, length - offset);
      const address = (start + offset) >>> 0;
      console.debug('[CPRD] request', {
        version: CPRD_VERSION,
        area,
        address: `0x${address.toString(16).toUpperCase().padStart(5, '0')}`,
        length: `0x${len.toString(16).toUpperCase()}`,
      });

      try {
        const data = await cprdReadChunk(writer, acc, area, address, len, interReadDelayMs);
        if (!data) {
          failedAt = { address, offset, length: len, chunkIndex };
          errorMessage = `Read failed at area=${area} addr=0x${address.toString(16).toUpperCase().padStart(5, '0')} len=0x${len.toString(16).toUpperCase()}`;
          break;
        }
        chunks.push(data);
        bytesRead += data.length;
      } catch (err) {
        failedAt = { address, offset, length: len, chunkIndex };
        errorMessage = err.message || String(err);
        break;
      }

      const pct = Math.round(((chunkIndex + 1) / totalChunks) * 100);
      onProgress({
        pct,
        msg: `Reading 0x${address.toString(16).toUpperCase().padStart(5, '0')} len=0x${len.toString(16).toUpperCase()} (${chunkIndex + 1}/${totalChunks})…`,
      });
    }

    const out = new Uint8Array(bytesRead);
    let pos = 0;
    for (const chunk of chunks) {
      out.set(chunk, pos);
      pos += chunk.length;
    }

    return {
      buffer: out.buffer,
      bytesRead,
      requestedLength: length,
      failedAt,
      errorMessage,
      complete: bytesRead === length,
      metadata: {
        area,
        start,
        length,
        chunkSize,
        interReadDelayMs,
        version: CPRD_VERSION,
      },
    };
  } finally {
    await cprdCloseSerialSession(session, 'raw dump completed');
  }
}
