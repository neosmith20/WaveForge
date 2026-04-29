'use strict';

// ClearDMR Web CPS — Raw Range Dump via USB CDC (normal operating mode)
//
// This is intentionally a true raw dumper:
// - reads exactly one requested area/address/length range
// - no parsing
// - no address translation
// - no synthetic file reconstruction
// - no alternate-area fallback
// - stops on first failed chunk
//
// Source-backed raw CPS map for MDUV380 / DM-1701 class radios:
// - USB area 1 = direct SPI flash reads in usb_com.c
// - USB area 2 = direct EEPROM reads in usb_com.c
// - Raw dump proof confirms zone data is direct-mapped EEPROM in area 2 at
//   0x8000 / 0x8010 / 0x8030, matching codeplug.c
// - Channels 1..128 are EEPROM at 0x3780..0x538F in codeplug.c
// - Channels 129..1024 are SPI flash at logical 0x7B1B0..0x8761F plus
//   FLASH_ADDRESS_OFFSET(0x20000), yielding raw area-1 addresses
//   0x9B1B0..0xA761F
// - Contacts are SPI flash at logical 0x87620 plus FLASH_ADDRESS_OFFSET,
//   yielding raw area-1 base 0xA7620
// - RX group lengths/data are SPI flash at logical 0x8D620 / 0x8D6A0 plus
//   FLASH_ADDRESS_OFFSET, yielding raw area-1 bases 0xAD620 / 0xAD6A0

const CPRD_SERIAL_FILTERS = [{ usbVendorId: 0x1FC9, usbProductId: 0x0094 }];
const CPRD_MAX_CHUNK      = 2045; // firmware-side request cap
const CPRD_MAX_RETRIES    = 0;    // keep pressure low; no hammering
const CPRD_EEPROM_TAIL0   = 0xF0;
const CPRD_EEPROM_TAIL1   = 0xF8;
const CPRD_EEPROM_TAIL2   = 0xFE;
const CPRD_EEPROM_TAIL0_CHUNK = 0x04;
const CPRD_EEPROM_TAIL1_CHUNK = 0x02;
const CPRD_EEPROM_TAIL2_CHUNK = 0x01;

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
    const out = this._pending.slice(0, n);
    this._pending = this._pending.slice(n);
    return out;
  }

  releaseLock() { this._reader.releaseLock(); }
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
    if (data) return data.subarray(0, length);
  }
  return null;
}

function cprdPlanChunkLength(area, address, remaining, requestedChunkSize) {
  if (area !== 2) {
    return Math.min(requestedChunkSize, remaining);
  }

  const pageOffset = address & 0xFF;

  if (pageOffset < CPRD_EEPROM_TAIL0) {
    return Math.min(requestedChunkSize, remaining, CPRD_EEPROM_TAIL0 - pageOffset);
  }
  if (pageOffset < CPRD_EEPROM_TAIL1) {
    return Math.min(CPRD_EEPROM_TAIL0_CHUNK, remaining, CPRD_EEPROM_TAIL1 - pageOffset);
  }
  if (pageOffset < CPRD_EEPROM_TAIL2) {
    return Math.min(CPRD_EEPROM_TAIL1_CHUNK, remaining, CPRD_EEPROM_TAIL2 - pageOffset);
  }
  return Math.min(CPRD_EEPROM_TAIL2_CHUNK, remaining);
}

function cprdBuildReadPlan(area, start, length, chunkSize) {
  const plan = [];
  let offset = 0;

  while (offset < length) {
    const address = (start + offset) >>> 0;
    const remaining = length - offset;
    const plannedLength = cprdPlanChunkLength(area, address, remaining, chunkSize);

    plan.push({ address, offset, length: plannedLength });
    offset += plannedLength;
  }

  return plan;
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

  let port = null;
  let writer = null;
  let acc = null;

  const chunks = [];
  const plan = cprdBuildReadPlan(area, start, length, chunkSize);
  const totalChunks = plan.length;
  let bytesRead = 0;
  let failedAt = null;
  let errorMessage = null;

  try {
    port = await navigator.serial.requestPort({ filters: CPRD_SERIAL_FILTERS });
    await port.open({ baudRate: 115200 });
    writer = port.writable.getWriter();
    acc = new SerialAccumulator(port.readable.getReader());

    for (let chunkIndex = 0; chunkIndex < plan.length; chunkIndex++) {
      const step = plan[chunkIndex];
      const address = step.address;
      const len = step.length;
      const boundarySafe = (len !== chunkSize);

      try {
        const data = await cprdReadChunk(writer, acc, area, address, len, interReadDelayMs);
        if (!data) {
          failedAt = { address, offset: step.offset, length: len, chunkIndex };
          errorMessage = `Read failed at area=${area} addr=0x${address.toString(16).toUpperCase().padStart(5, '0')} len=0x${len.toString(16).toUpperCase()}`;
          break;
        }
        chunks.push(data);
        bytesRead += data.length;
      } catch (err) {
        failedAt = { address, offset: step.offset, length: len, chunkIndex };
        errorMessage = err.message || String(err);
        break;
      }

      const pct = Math.round(((chunkIndex + 1) / totalChunks) * 100);
      onProgress({
        pct,
        msg: `Reading 0x${address.toString(16).toUpperCase().padStart(5, '0')} len=0x${len.toString(16).toUpperCase()}${boundarySafe ? ' boundary-safe' : ''} (${chunkIndex + 1}/${totalChunks})…`,
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
        boundaryAwareEeprom: (area === 2),
        plannedChunks: totalChunks,
      },
    };
  } finally {
    if (acc)    { try { acc.releaseLock(); } catch (_) {} }
    if (writer) { try { writer.releaseLock(); } catch (_) {} }
    if (port)   { try { await port.close(); } catch (_) {} }
  }
}
