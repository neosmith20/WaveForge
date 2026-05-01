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

const CPRD_VERSION        = 'radio-read.js 2026-04-29 serial-proto-v3';
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
const CPRD_CONNECT_TIMEOUT_MS   = 1000;
const CPRD_INIT_SETTLE_MS       = 75;
const CPRD_DRAIN_IDLE_MS        = 75;
const CPRD_C_COMMAND_ACK_TIMEOUT_MS = 250;
const CPRD_C_COMMAND_POST_ACK_IDLE_MS = 50;
const CPRD_POST_INFO_SETTLE_MS  = 100;
const CPRD_POST_INFO_IDLE_MS    = 150;
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

function cprdHexAll(data) {
  if (!data) return '(none)';
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length === 0) return '(empty)';
  return Array.from(bytes, b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

function cprdLogRaw(direction, bytes, label = '') {
  const prefix = label ? `[CPRD] ${direction} ${label}` : `[CPRD] ${direction}`;
  console.log(prefix, {
    length: bytes?.length ?? 0,
    hex: cprdHexAll(bytes),
  });
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
    session.acc.resetState({ label: `port close ${tag}`, clearRecent: true, logDrop: true });
    session.acc = null;
  }
  if (session.writer) {
    try { session.writer.releaseLock(); } catch (_) {}
    session.writer = null;
  }
  if (session.reader) {
    try { await session.reader.cancel(); } catch (_) {}
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

function cprdHexTailBytes(data, count = 8) {
  if (!data) return '(none)';
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const start = Math.max(0, bytes.length - count);
  return Array.from(bytes.subarray(start), b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

function cprdFnv1a32(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let hash = 0x811C9DC5;
  for (const b of bytes) {
    hash ^= b;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `0x${hash.toString(16).toUpperCase().padStart(8, '0')}`;
}

function cprdLogBlockSummary(area, address, data, label = 'block summary') {
  console.log(`[CPRD] ${label}`, {
    area,
    address: `0x${address.toString(16).toUpperCase().padStart(5, '0')}`,
    length: data.length,
    fnv1a32: cprdFnv1a32(data),
    first8: cprdHexBytes(data, 8),
    last8: cprdHexTailBytes(data, 8),
  });
}

function cprdLogBufferSummary(data, label = 'buffer summary') {
  console.log(`[CPRD] ${label}`, {
    length: data.length,
    fnv1a32: cprdFnv1a32(data),
    first8: cprdHexBytes(data, 8),
    last8: cprdHexTailBytes(data, 8),
  });
}

function cprdConcatBytes(...parts) {
  const filtered = parts.filter(part => part && part.length > 0);
  const total = filtered.reduce((sum, part) => sum + part.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of filtered) {
    merged.set(part, offset);
    offset += part.length;
  }
  return merged;
}

function cprdBuildReadRequestBytes(area, address, length) {
  const req = new Uint8Array(8);
  req[0] = CPRD_READ_BYTE;
  req[1] = area & 0xFF;
  req[2] = (address >>> 24) & 0xFF;
  req[3] = (address >>> 16) & 0xFF;
  req[4] = (address >>>  8) & 0xFF;
  req[5] =  address         & 0xFF;
  req[6] = (length  >>>  8) & 0xFF;
  req[7] =  length          & 0xFF;
  return req;
}

function cprdLogReadResponseDiagnostics(raw, address, requestedLength, label = 'read response') {
  const len16be = raw.length >= 2 ? ((raw[0] << 8) | raw[1]) : null;
  const len16le = raw.length >= 2 ? (raw[0] | (raw[1] << 8)) : null;
  const word32be = raw.length >= 4
    ? ((((raw[0] << 24) >>> 0) | (raw[1] << 16) | (raw[2] << 8) | raw[3]) >>> 0)
    : null;
  const word32le = raw.length >= 4
    ? ((raw[0] | (raw[1] << 8) | (raw[2] << 16) | ((raw[3] << 24) >>> 0)) >>> 0)
    : null;

  console.log(`[CPRD] ${label}`, {
    rxTotalLength: raw.length,
    first32: cprdHexAll(raw.subarray(0, 32)),
    len16be,
    len16le,
    len16beMatchesRequested: len16be === requestedLength,
    len16leMatchesRequested: len16le === requestedLength,
    word32be: word32be == null ? null : `0x${word32be.toString(16).toUpperCase()}`,
    word32le: word32le == null ? null : `0x${word32le.toString(16).toUpperCase()}`,
    word32beMatchesRequested: word32be === requestedLength,
    word32leMatchesRequested: word32le === requestedLength,
    word32beMatchesAddress: word32be === address,
    word32leMatchesAddress: word32le === address,
    candidateLenStrip0: Math.max(0, raw.length),
    candidateLenStrip2: Math.max(0, raw.length - 2),
    candidateLenStrip4: Math.max(0, raw.length - 4),
    candidateLenStrip8: Math.max(0, raw.length - 8),
  });
}

function cprdAsciiPreview(bytes) {
  if (!bytes || bytes.length === 0) return '';
  return Array.from(bytes, b => (b >= 0x20 && b <= 0x7E ? String.fromCharCode(b) : '.')).join('');
}

function cprdLooksLikeRadioInfoPayload(payload) {
  if (!payload || payload.length < 40) return false;

  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const structVersion = view.getUint32(0, true);
  const radioType = view.getUint32(4, true);
  const buildDatePrefix = cprdAsciiPreview(payload.subarray(24, 32));

  return (
    structVersion > 0 &&
    structVersion < 0x100 &&
    (CPRD_STM32_RADIO_TYPES.has(radioType) || (radioType > 0 && radioType < 32)) &&
    /^\d{8}$/.test(buildDatePrefix)
  );
}

function cprdIsStaleRadioInfoResponse(respLen, framing, headerBytes, acc) {
  if (!(respLen === 46 && framing === 'R-framed')) {
    return false;
  }

  const pendingPreview = typeof acc.peekPending === 'function'
    ? acc.peekPending(64)
    : new Uint8Array(0);
  const combined = cprdConcatBytes(headerBytes, pendingPreview);
  if (combined.length < 3) return false;
  const payloadPreview = combined.subarray(3);
  return cprdLooksLikeRadioInfoPayload(payloadPreview);
}

async function cprdWriteBytes(writer, bytes, label = '') {
  cprdLogRaw('TX', bytes, label);
  await writer.write(bytes);
}

class SerialAccumulator {
  constructor(reader) {
    this._reader  = reader;
    this._pending = new Uint8Array(0);
    this._recentRxChunks = [];
  }

  async readExact(n, options = {}) {
    const { timeoutMs = 0, timeoutLabel = '' } = options;
    const initialPendingLength = this._pending.length;
    while (this._pending.length < n) {
      let result;
      if (timeoutMs > 0) {
        const timeoutToken = Symbol('timeout');
        result = await Promise.race([
          this._reader.read(),
          cprdDelay(timeoutMs).then(() => timeoutToken),
        ]);
        if (result === timeoutToken) {
          const label = timeoutLabel || `${n} serial byte(s)`;
          const actual = Math.min(n, this._pending.length) - Math.min(n, initialPendingLength);
          const expected = n - Math.min(n, initialPendingLength);
          console.warn('[CPRD] timeout stage', { label, timeoutMs, expectedBytes: expected, actualBytes: actual });
          try { await this._reader.cancel(); } catch (_) {}
          throw new Error(`Timed out waiting for ${label}. Expected ${expected} byte(s), received ${actual} byte(s) before timeout.`);
        }
      } else {
        result = await this._reader.read();
      }

      const { value, done } = result;
      if (done) throw new Error('Serial port closed unexpectedly.');
      const chunk = value instanceof Uint8Array
        ? value
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      cprdLogRaw('RX', chunk, 'chunk');
      this._rememberRxChunk(chunk);
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
    if (this._pending.length > 0) {
      cprdLogRaw('DROP', this._pending, 'pending');
    }
    this._pending = new Uint8Array(0);
  }

  resetState(options = {}) {
    const {
      label = 'reset',
      clearRecent = true,
      logDrop = false,
    } = options;
    if (logDrop && this._pending.length > 0) {
      cprdLogRaw('DROP', this._pending, `${label} pending reset`);
    }
    this._pending = new Uint8Array(0);
    if (clearRecent) {
      this._recentRxChunks = [];
    }
  }

  async readSome(options = {}) {
    const { timeoutMs = 0, timeoutLabel = '', suppressTimeoutLog = false } = options;
    if (this._pending.length > 0) {
      const out = this._pending;
      this._pending = new Uint8Array(0);
      return out;
    }

    let result;
    if (timeoutMs > 0) {
      const timeoutToken = Symbol('timeout');
      result = await Promise.race([
        this._reader.read(),
        cprdDelay(timeoutMs).then(() => timeoutToken),
      ]);
      if (result === timeoutToken) {
        const label = timeoutLabel || 'serial response';
        if (!suppressTimeoutLog) {
          console.warn('[CPRD] timeout at stage', { label, timeoutMs });
        }
        return null;
      }
    } else {
      result = await this._reader.read();
    }

    const { value, done } = result;
    if (done) throw new Error('Serial port closed unexpectedly.');
    const chunk = value instanceof Uint8Array
      ? value
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    cprdLogRaw('RX', chunk, 'chunk');
    this._rememberRxChunk(chunk);
    return chunk;
  }

  clearAllPending() {
    this.clearPending();
  }

  prependPending(bytes) {
    if (!bytes || bytes.length === 0) return;
    const merged = new Uint8Array(bytes.length + this._pending.length);
    merged.set(bytes, 0);
    merged.set(this._pending, bytes.length);
    this._pending = merged;
  }

  getRecentRxHex(maxBytes = 64) {
    if (this._recentRxChunks.length === 0) return '(none)';
    const flattened = [];
    for (const chunk of this._recentRxChunks) {
      for (const b of chunk) flattened.push(b);
    }
    const slice = flattened.slice(-Math.max(1, maxBytes));
    return cprdHexAll(Uint8Array.from(slice));
  }

  getPendingLength() {
    return this._pending.length;
  }

  peekPending(maxBytes = this._pending.length) {
    return this._pending.slice(0, Math.max(0, maxBytes));
  }

  getRecentRxByteCount() {
    return this._recentRxChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  }

  _rememberRxChunk(chunk) {
    const copy = new Uint8Array(chunk);
    this._recentRxChunks.push(copy);
    if (this._recentRxChunks.length > 16) {
      this._recentRxChunks.shift();
    }
  }

  releaseLock() { this._reader.releaseLock(); }
}

async function cprdClearInputBuffer(acc, options = {}) {
  const {
    idleMs = CPRD_DRAIN_IDLE_MS,
    label = 'input buffer',
  } = options;

  acc.clearPending();

  let drained = 0;
  while (true) {
    const chunk = await acc.readSome({
      timeoutMs: idleMs,
      timeoutLabel: `${label} drain`,
      suppressTimeoutLog: true,
    });
    if (!chunk || chunk.length === 0) break;
    drained += chunk.length;
    cprdLogRaw('DROP', chunk, `${label} drain`);
  }

  console.log('[CPRD] input drain complete', { label, drained });
}

async function cprdObserveIncoming(acc, options = {}) {
  const {
    idleMs = CPRD_DRAIN_IDLE_MS,
    label = 'observe',
    preserve = false,
  } = options;

  const chunks = [];
  while (true) {
    const chunk = await acc.readSome({
      timeoutMs: idleMs,
      timeoutLabel: `${label} observe`,
      suppressTimeoutLog: true,
    });
    if (!chunk || chunk.length === 0) break;
    chunks.push(chunk);
    cprdLogRaw('OBSERVE', chunk, label);
  }

  if (chunks.length > 0) {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    if (preserve) {
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      acc.prependPending(merged);
    }
    console.log('[CPRD] observe complete', { label, chunks: chunks.length, bytes: total, preserved: preserve });
  } else {
    console.log('[CPRD] observe complete', { label, chunks: 0, bytes: 0, preserved: preserve });
  }
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
    timeoutMs = 0,
    logTx = false,
    logAck = false,
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

  const txHex = Array.from(req.subarray(0, len), b => `0x${b.toString(16).toUpperCase().padStart(2, '0')}`);
  const session = writer && writer.__cprdSession;
  if (logTx || (session && session.commandCount === 0)) {
    console.log(session && session.commandCount === 0 ? '[CPRD] first command bytes sent' : '[CPRD] command bytes sent', {
      command: `0x${commandNumber.toString(16).toUpperCase()}`,
      bytes: txHex,
      context: context || undefined,
    });
  }
  await cprdWriteBytes(writer, req.subarray(0, len), `command 0x${commandNumber.toString(16).toUpperCase()}`);
  // Native CPS waits for pending writes to clear and then sleeps 50 ms.
  await cprdDelay(50);
  const ack = await acc.readExact(2, {
    timeoutMs,
    timeoutLabel: context ? `${context} ack` : `command 0x${commandNumber.toString(16).toUpperCase()} ack`,
  });
  const ackHexList = Array.from(ack, b => `0x${b.toString(16).toUpperCase().padStart(2, '0')}`);
  if (logAck || (session && session.commandCount === 0)) {
    console.log(session && session.commandCount === 0 ? '[CPRD] first ack bytes received' : '[CPRD] raw ack bytes received', {
      command: `0x${commandNumber.toString(16).toUpperCase()}`,
      ack: ackHexList,
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

function cprdBuildCommandBytes(commandNumber, options = {}) {
  const {
    xOrOption = 0,
    y = 0,
    size = 0,
    alignment = 0,
    inverted = 0,
    message = '',
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

  return req.subarray(0, len);
}

async function cprdNativeProbeCommand(writer, acc, commandNumber, {
  stageName,
  timeoutMs = CPRD_CONNECT_TIMEOUT_MS,
  requireAck = true,
} = {}) {
  const req = cprdBuildCommandBytes(commandNumber);
  console.log(`[CPRD] ${stageName}`, { command: `0x${commandNumber.toString(16).toUpperCase()}` });
  await cprdWriteBytes(writer, req, stageName);
  await cprdDelay(50);

  const response = await acc.readSome({
    timeoutMs,
    timeoutLabel: stageName,
  });
  if (!response) {
    if (requireAck) {
      throw new Error(`Timed out waiting for ${stageName}.`);
    }
    console.warn('[CPRD] no reply for optional probe stage', { stageName });
    return null;
  }

  const ackList = Array.from(response, b => `0x${b.toString(16).toUpperCase().padStart(2, '0')}`);
  console.log('[CPRD] received ack bytes', {
    stageName,
    ack: ackList,
  });
  return response;
}

async function cprdSendCCommandAndExpectAck(writer, acc, commandByte, label, options = {}) {
  const {
    drainAfterAck = true,
  } = options;
  const req = new Uint8Array([CPRD_CMD_BYTE, commandByte & 0xFF]);
  await cprdWriteBytes(writer, req, label);

  const ack = await acc.readExact(1, {
    timeoutMs: CPRD_C_COMMAND_ACK_TIMEOUT_MS,
    timeoutLabel: `${label} ACK`,
  });
  if (ack[0] !== 0x2D) {
    throw new Error(
      `${label} expected ACK 0x2D, got 0x${ack[0].toString(16).toUpperCase().padStart(2, '0')}.`
    );
  }

  console.log('[CPRD] C command ACK received', {
    label,
    ack: '0x2D',
  });

  if (drainAfterAck) {
    await cprdClearInputBuffer(acc, {
      label: `${label} post-ack drain`,
      idleMs: CPRD_C_COMMAND_POST_ACK_IDLE_MS,
    });
  }
}

async function cprdPrimeRadioConnection(writer, acc, { stealth = false } = {}) {
  void stealth;
  await cprdSendCCommandAndExpectAck(writer, acc, 0x00, 'init C 00', { drainAfterAck: false });
  await cprdSendCCommandAndExpectAck(writer, acc, 0xFE, 'init C FE', { drainAfterAck: false });
  await cprdClearInputBuffer(acc, {
    label: 'init C command post-ack drain',
    idleMs: CPRD_C_COMMAND_POST_ACK_IDLE_MS,
  });
  await cprdDelay(CPRD_INIT_SETTLE_MS);
}

async function cprdReadRadioInfo(writer, acc, { stealth = false } = {}) {
  void stealth;
  const req = new Uint8Array(8);
  req[0] = CPRD_READ_BYTE;
  req[1] = CPRD_MODE_READ_RADIO_INFO;
  console.log('[CPRD] radio info request bytes', { hex: cprdHexAll(req) });
  await cprdWriteBytes(writer, req, 'radio info request');

  try {
    const firstByte = await acc.readExact(1, {
      timeoutMs: CPRD_CONNECT_TIMEOUT_MS,
      timeoutLabel: 'radio info first byte',
    });

    if (firstByte[0] !== CPRD_READ_BYTE) {
      throw new Error(
        `USB CDC protocol error during radio info read. Expected leading 0x${CPRD_READ_BYTE.toString(16).toUpperCase()}, ` +
        `received 0x${firstByte[0].toString(16).toUpperCase().padStart(2, '0')}.`
      );
    }

    const lenBytes = await acc.readExact(2, {
      timeoutMs: CPRD_CONNECT_TIMEOUT_MS,
      timeoutLabel: 'radio info length bytes',
    });
    const len = (lenBytes[0] << 8) | lenBytes[1];
    if (len <= 0 || len > 64) {
      throw new Error(`Radio info read failed. Unexpected R-framed length=0x${len.toString(16).toUpperCase()}.`);
    }
    const payload = await acc.readExact(len, {
      timeoutMs: CPRD_CONNECT_TIMEOUT_MS,
      timeoutLabel: 'radio info payload',
    });

    console.log('[CPRD] radio info response', {
      format: 'R-framed',
      length: len,
      payloadHex: cprdHexAll(payload),
    });

    const info = cprdParseRadioInfo(payload);
    console.log('[CPRD] radio info decoded', {
      structVersion: info.structVersion,
      radioType: info.radioType,
      gitRevision: info.gitRevision,
      buildDateTime: info.buildDateTime,
      flashId: `0x${info.flashId.toString(16).toUpperCase()}`,
      features: `0x${info.features.toString(16).toUpperCase()}`,
      isSTM32: info.isSTM32,
      usbBufferSize: info.usbBufferSize,
      usesOldUsbBufferSize: info.usesOldUsbBufferSize,
    });

    if (acc.getPendingLength() > 0) {
      const trailing = acc.peekPending(64);
      throw new Error(
        `USB CDC protocol error after radio info read. Expected exactly ${len + 3} bytes, ` +
        `but ${acc.getPendingLength()} trailing byte(s) remain in the accumulator. ` +
        `Trailing=${cprdHexAll(trailing)}.`
      );
    }

    return info;
  } catch (err) {
    const recentHex = acc.getRecentRxHex(96);
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${message} Last RX=${recentHex}.`);
  }
}

async function cprdBeginCodeplugReadTask(writer, acc) {
  void writer;
  void acc;
  console.log('[CPRD] begin read task: serial read protocol only');
}

async function cprdEndCodeplugReadTask(writer, acc) {
  void writer;
  void acc;
  console.log('[CPRD] end read task: serial read protocol only');
}

async function cprdRequest(writer, acc, area, address, length, interReadDelayMs) {
  if (interReadDelayMs > 0) await cprdDelay(interReadDelayMs);

  const req = cprdBuildReadRequestBytes(area, address, length);
  const addrHex = `0x${address.toString(16).toUpperCase().padStart(5, '0')}`;
  console.log('[CPRD] read request bytes', {
    format: 'R area addr_be32 len_be16',
    area,
    address: addrHex,
    length: `0x${length.toString(16).toUpperCase()}`,
    hex: cprdHexAll(req),
  });
  await cprdWriteBytes(writer, req, `read area=${area} addr=${addrHex} len=0x${length.toString(16).toUpperCase()}`);
  try {
    const firstByte = await acc.readExact(1, {
      timeoutMs: CPRD_CONNECT_TIMEOUT_MS,
      timeoutLabel: `read first byte ${addrHex}`,
    });

    if (firstByte[0] !== CPRD_READ_BYTE) {
      throw new Error(
        `USB CDC protocol error during memory read at area=${area} addr=${addrHex}. ` +
        `Expected leading 0x${CPRD_READ_BYTE.toString(16).toUpperCase()}, ` +
        `received 0x${firstByte[0].toString(16).toUpperCase().padStart(2, '0')}.`
      );
    }

    const framing = 'R-framed';
    const lenBytes = await acc.readExact(2, {
      timeoutMs: CPRD_CONNECT_TIMEOUT_MS,
      timeoutLabel: `read R-framed length prefix ${addrHex}`,
    });
    const headerBytes = cprdConcatBytes(firstByte, lenBytes);
    const respLen = (lenBytes[0] << 8) | lenBytes[1];
    if (respLen !== length) {
      const pendingPreview = acc.peekPending(64);
      const responsePreview = cprdConcatBytes(headerBytes, pendingPreview);
      cprdLogReadResponseDiagnostics(responsePreview, address, length, `read response header mismatch addr=${addrHex}`);
      if (cprdIsStaleRadioInfoResponse(respLen, framing, headerBytes, acc)) {
        throw new Error(
          `Stale radio info response received before codeplug block at area=${area} addr=${addrHex} (${framing}). ` +
          `Expected 2-byte BE length ${length}, received ${respLen}.`
        );
      }
      throw new Error(
        `Read length prefix mismatch at area=${area} addr=${addrHex} (${framing}). ` +
        `Expected 2-byte BE length ${length}, received ${respLen}.`
      );
    }
    const payload = await acc.readExact(respLen, {
      timeoutMs: CPRD_CONNECT_TIMEOUT_MS,
      timeoutLabel: `read ${framing} payload ${addrHex}`,
    });
    cprdLogReadResponseDiagnostics(
      cprdConcatBytes(headerBytes, payload),
      address,
      length,
      `read response complete addr=${addrHex}`
    );
    return payload;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${message} Last RX=${acc.getRecentRxHex(96)}.`);
  }
}

async function cprdReadChunk(writer, acc, area, address, length, interReadDelayMs) {
  for (let attempt = 0; attempt <= CPRD_MAX_RETRIES; attempt++) {
    const data = await cprdRequest(writer, acc, area, address, length, interReadDelayMs);
    if (data) {
      if (data.length !== length) {
        throw new Error(
          `Read payload length mismatch at area=${area} addr=0x${address.toString(16).toUpperCase().padStart(5, '0')}. ` +
          `Expected ${length} byte(s), received ${data.length}.`
        );
      }
      console.debug('[CPRD] response', {
        version: CPRD_VERSION,
        area,
        address: `0x${address.toString(16).toUpperCase().padStart(5, '0')}`,
        length: `0x${length.toString(16).toUpperCase()}`,
        first8: cprdHexBytes(data, 8),
      });
      cprdLogBlockSummary(area, address, data);
      return data;
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

    await cprdClearInputBuffer(acc, { label: 'cpread session start' });
    acc.resetState({ label: 'cpread session start', clearRecent: true, logDrop: false });
    console.log('[CPRD] read session reset', {
      rxBufferLength: acc.getPendingLength(),
      recentRxBytes: acc.getRecentRxByteCount(),
    });

    await cprdPrimeRadioConnection(writer, acc);
    const radioInfo = await cprdReadRadioInfo(writer, acc);
    if (!radioInfo.isSTM32) {
      throw new Error(`Unsupported radio type ${radioInfo.radioType}. This browser CPS path currently matches the STM32-family OpenGD77 CPS model only.`);
    }
    await cprdDelay(CPRD_POST_INFO_SETTLE_MS);
    await cprdClearInputBuffer(acc, {
      label: 'after radio info before codeplug reads',
      idleMs: CPRD_POST_INFO_IDLE_MS,
    });
    await cprdBeginCodeplugReadTask(writer, acc);
    taskStarted = true;
    chunkSize = Math.min(
      CPRD_MAX_CHUNK,
      Math.max(1, Number(options.chunkSize) || radioInfo.usbBufferSize)
    );
    acc.resetState({ label: 'before first codeplug block', clearRecent: true, logDrop: true });

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

    cprdLogBufferSummary(out, 'codeplug summary');
    return {
      ok: true,
      buffer: out.buffer,
      bytesRead,
      metadata: {
        version: CPRD_VERSION,
        chunkSize,
        interReadDelayMs,
        totalBytes,
        codeplugFnv1a32: cprdFnv1a32(out),
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
    await cprdPrimeRadioConnection(writer, acc);
    const radioInfo = await cprdReadRadioInfo(writer, acc);
    console.log('[CPRD] raw dump radio info', radioInfo);

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
        radioInfo,
      },
    };
  } finally {
    await cprdCloseSerialSession(session, 'raw dump completed');
  }
}
