'use strict';

// STM32 DFU ROM bootloader — same USB identifiers as the firmware flasher
const CPWR_FILTERS = [{ vendorId: 0x0483, productId: 0xDF11 }];

// USB DFU 1.1 request codes
const CPWR_DNLOAD    = 1;
const CPWR_GETSTATUS = 3;
const CPWR_CLRSTATUS = 4;
const CPWR_ABORT     = 6;

// DFU device state codes (bState in GETSTATUS response)
const CPWR_STATE_IDLE        = 2;
const CPWR_STATE_DNBUSY      = 4;
const CPWR_STATE_DNLOAD_IDLE = 5;
const CPWR_STATE_ERROR       = 10;

const CPWR_STATUS_NAMES = {
  0x01: 'errTARGET', 0x02: 'errFILE',    0x03: 'errWRITE',
  0x04: 'errERASE',  0x05: 'errCHECK_ERASED', 0x06: 'errPROG',
  0x07: 'errVERIFY', 0x08: 'errADDRESS', 0x09: 'errNOTDONE',
  0x0A: 'errFIRMWARE', 0x0B: 'errVENDOR', 0x0E: 'errUNKNOWN',
};

// STM32 DFU extension command bytes (sent in DFU_DNLOAD with wValue=0)
const CPWR_CMD_SET_ADDR = 0x21;
const CPWR_CMD_ERASE    = 0x41;

// STM32F405 sector 10 is the codeplug staging area.  The firmware flasher only
// erases sectors 3–9, so sector 10 survives a firmware flash and is safe to use
// as a 128 KB landing zone for a codeplug import.
const CPWR_BLOCK_SIZE    = 2048;
const CPWR_STAGING_ADDR  = 0x080C0000; // sector 10 start
const CPWR_CODEPLUG_SIZE = 0x20000;    // 128 KB — exact size of sector 10
const CPWR_NUM_BLOCKS    = CPWR_CODEPLUG_SIZE / CPWR_BLOCK_SIZE; // 64 blocks

function cpwrFindDfuInterface(device) {
  for (const iface of device.configuration.interfaces) {
    for (const alt of iface.alternates) {
      if (alt.interfaceClass === 0xFE && alt.interfaceSubclass === 0x01) {
        return iface.interfaceNumber;
      }
    }
  }
  return null;
}

async function cpwrOut(device, ifNum, request, value, data) {
  const result = await device.controlTransferOut(
    { requestType: 'class', recipient: 'interface', request, value, index: ifNum },
    data instanceof Uint8Array ? data : new Uint8Array(0)
  );
  if (result.status !== 'ok') {
    throw new Error(`DFU request 0x${request.toString(16)} failed: ${result.status}`);
  }
}

async function cpwrGetStatus(device, ifNum) {
  const result = await device.controlTransferIn(
    { requestType: 'class', recipient: 'interface', request: CPWR_GETSTATUS, value: 0, index: ifNum },
    6
  );
  if (result.status !== 'ok') throw new Error(`DFU_GETSTATUS failed: ${result.status}`);
  const d = new Uint8Array(result.data.buffer);
  return { bStatus: d[0], bwPollTimeout: d[1] | (d[2] << 8) | (d[3] << 16), bState: d[4] };
}

async function cpwrPoll(device, ifNum, targetState) {
  for (;;) {
    const st = await cpwrGetStatus(device, ifNum);
    if (st.bStatus !== 0x00) {
      const name = CPWR_STATUS_NAMES[st.bStatus] || `0x${st.bStatus.toString(16)}`;
      throw new Error(`DFU device error: ${name}`);
    }
    if (st.bState === CPWR_STATE_ERROR) throw new Error('DFU device entered error state.');
    if (st.bState === targetState) return st;
    if (st.bState === CPWR_STATE_DNBUSY) {
      await new Promise(r => setTimeout(r, Math.max(st.bwPollTimeout, 10)));
    }
  }
}

async function cpwrEraseSector(device, ifNum, addr) {
  const cmd = new Uint8Array(5);
  cmd[0] = CPWR_CMD_ERASE;
  cmd[1] = (addr >>>  0) & 0xFF;
  cmd[2] = (addr >>>  8) & 0xFF;
  cmd[3] = (addr >>> 16) & 0xFF;
  cmd[4] = (addr >>> 24) & 0xFF;
  await cpwrOut(device, ifNum, CPWR_DNLOAD, 0, cmd);
  await cpwrPoll(device, ifNum, CPWR_STATE_DNLOAD_IDLE);
}

async function cpwrSetAddress(device, ifNum, addr) {
  const cmd = new Uint8Array(5);
  cmd[0] = CPWR_CMD_SET_ADDR;
  cmd[1] = (addr >>>  0) & 0xFF;
  cmd[2] = (addr >>>  8) & 0xFF;
  cmd[3] = (addr >>> 16) & 0xFF;
  cmd[4] = (addr >>> 24) & 0xFF;
  await cpwrOut(device, ifNum, CPWR_DNLOAD, 0, cmd);
  await cpwrPoll(device, ifNum, CPWR_STATE_DNLOAD_IDLE);
}

// Write an ArrayBuffer codeplug to the radio's staging flash sector via DFU.
// onProgress({ phase: 'erase'|'write', pct: 0-100, msg: string })
async function cpwrWriteCodeplug(arrayBuffer, onProgress) {
  // Pad or truncate to exactly 128 KB
  const src = new Uint8Array(arrayBuffer);
  const buf = new Uint8Array(CPWR_CODEPLUG_SIZE);
  buf.fill(0xFF);
  buf.set(src.subarray(0, CPWR_CODEPLUG_SIZE));

  let device = null;
  let ifNum  = null;

  try {
    // 1. Request device
    device = await navigator.usb.requestDevice({ filters: CPWR_FILTERS });
    await device.open();
    if (device.configuration === null) await device.selectConfiguration(1);

    // 2. Find and claim the DFU interface
    ifNum = cpwrFindDfuInterface(device);
    if (ifNum === null) throw new Error('No DFU interface found. Is the radio in DFU mode?');
    await device.claimInterface(ifNum);

    // 3. Clear any stale error or in-progress state
    let st = await cpwrGetStatus(device, ifNum);
    if (st.bState === CPWR_STATE_ERROR) {
      await cpwrOut(device, ifNum, CPWR_CLRSTATUS, 0);
      st = await cpwrGetStatus(device, ifNum);
    }
    if (st.bState !== CPWR_STATE_IDLE && st.bState !== CPWR_STATE_DNLOAD_IDLE) {
      await cpwrOut(device, ifNum, CPWR_ABORT, 0);
      st = await cpwrGetStatus(device, ifNum);
    }
    if (st.bState !== CPWR_STATE_IDLE) {
      throw new Error(`Device not ready (state ${st.bState}). Try reconnecting the radio.`);
    }

    // 4. Erase sector 10 (single 128 KB sector)
    onProgress({ phase: 'erase', pct: 0, msg: 'Erasing staging area…' });
    await cpwrEraseSector(device, ifNum, CPWR_STAGING_ADDR);
    onProgress({ phase: 'erase', pct: 100, msg: 'Erase complete.' });

    // 5. Set write address to start of staging area
    await cpwrSetAddress(device, ifNum, CPWR_STAGING_ADDR);

    // 6. Write 64 × 2 KB blocks (wValue starts at 2 per STM32 DFU convention)
    for (let block = 0; block < CPWR_NUM_BLOCKS; block++) {
      const offset = block * CPWR_BLOCK_SIZE;
      const chunk  = buf.subarray(offset, offset + CPWR_BLOCK_SIZE);
      await cpwrOut(device, ifNum, CPWR_DNLOAD, block + 2, chunk);
      await cpwrPoll(device, ifNum, CPWR_STATE_DNLOAD_IDLE);
      const pct = Math.round(((block + 1) / CPWR_NUM_BLOCKS) * 100);
      onProgress({ phase: 'write', pct, msg: `Writing block ${block + 1} of ${CPWR_NUM_BLOCKS}…` });
    }

    // 7. Abort — data is already committed; no manifest needed.
    // Leaves the device in DFU mode so the user can disconnect cleanly.
    await cpwrOut(device, ifNum, CPWR_ABORT, 0);

    return { ok: true };

  } finally {
    if (device) {
      try { if (ifNum !== null) await device.releaseInterface(ifNum); } catch (_) {}
      try { await device.close(); } catch (_) {}
    }
  }
}
