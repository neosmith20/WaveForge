// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  model:      null,   // 'DM1701' | 'MDUV380' | 'RT84'
  donorFile:  null,   // File object
  donorBytes: null,   // Uint8Array
  device:     null,   // USBDevice
};

const MODEL_NAMES = {
  DM1701:  'Baofeng DM-1701',
  MDUV380: 'TYT MD-UV380',
  RT84:    'Retevis RT84',
};

// STM32F405 DFU ROM bootloader USB identifiers (same across all three radio models)
const DFU_FILTERS = [
  { vendorId: 0x0483, productId: 0xDF11 },
];

// ─── DFU protocol constants ───────────────────────────────────────────────────

// USB DFU 1.1 request codes
const DFU_DNLOAD    = 1;
const DFU_UPLOAD    = 2;
const DFU_GETSTATUS = 3;
const DFU_CLRSTATUS = 4;
const DFU_ABORT     = 6;

// DFU device state codes (bState in GETSTATUS response)
const STATE_IDLE                = 2;
const STATE_DNLOAD_SYNC         = 3;
const STATE_DNBUSY              = 4;
const STATE_DNLOAD_IDLE         = 5;
const STATE_MANIFEST_SYNC       = 6;
const STATE_MANIFEST            = 7;
const STATE_MANIFEST_WAIT_RESET = 8;
const STATE_UPLOAD_IDLE         = 9;
const STATE_ERROR               = 10;

// Human-readable DFU error status codes for error messages
const DFU_STATUS_NAMES = {
  0x01: 'errTARGET', 0x02: 'errFILE',    0x03: 'errWRITE',
  0x04: 'errERASE',  0x05: 'errCHECK_ERASED', 0x06: 'errPROG',
  0x07: 'errVERIFY', 0x08: 'errADDRESS', 0x09: 'errNOTDONE',
  0x0A: 'errFIRMWARE', 0x0B: 'errVENDOR', 0x0E: 'errUNKNOWN',
};

// STM32 DFU extension command bytes (sent in DFU_DNLOAD with wValue=0)
const STM32_CMD_SET_ADDR = 0x21;
const STM32_CMD_ERASE    = 0x41;

// ─── Flash layout & codec offsets ────────────────────────────────────────────

// Firmware start address — STM32F405 internal flash, immediately after the
// 48 KB bootloader (sectors 0-2).  Matches FLASH ORIGIN in the linker script.
const FIRMWARE_START = 0x0800C000;

// STM32F405VGT6 (1 MB) sector start addresses.
// Sectors 0-2 hold the bootloader; we erase 3-9 to cover the full
// firmware + codec region (codec ends at 0x080BDF2C, inside sector 9).
const SECTORS_TO_ERASE = [
  0x0800C000,  // sector  3 — 16 KB
  0x08010000,  // sector  4 — 64 KB
  0x08020000,  // sector  5 — 128 KB
  0x08040000,  // sector  6 — 128 KB
  0x08060000,  // sector  7 — 128 KB
  0x08080000,  // sector  8 — 128 KB
  0x080A0000,  // sector  9 — 128 KB
];

// Codec extraction from the donor binary
const CODEC_SRC_OFFSET = 0xC2C7C;
const CODEC_SRC_LENGTH = 0x48BB0;

// Offset inside the ClearDMR firmware image where the codec is patched in.
// Absolute flash address: FIRMWARE_START + CODEC_DST_OFFSET = 0x0807537C
const CODEC_DST_OFFSET = 0x6937C;

// DFU_DNLOAD / DFU_UPLOAD transfer size — 2 KB matches the STM32F405 DFU ROM default
const BLOCK_SIZE = 2048;

// Number of 2 KB blocks to read during backup (covers the full firmware region).
// 400 blocks = 819,200 bytes — larger than the biggest variant (~806 KB).
const BACKUP_BLOCKS = 400;

// Firmware binaries are committed to docs/firmware/ and served same-origin from
// GitHub Pages.  GitHub Releases download URLs go through release-assets.githubusercontent.com
// which does not set Access-Control-Allow-Origin, making them unfetchable from
// a browser.  Same-origin paths have no CORS involvement at all.
const FIRMWARE_URLS = {
  DM1701:  './firmware/ClearDMR_DM1701.bin',
  MDUV380: './firmware/ClearDMR_MDUV380.bin',
  RT84:    './firmware/ClearDMR_RT84.bin',
};

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const cardModel    = document.getElementById('card-model');
const cardDonor    = document.getElementById('card-donor');
const cardConnect  = document.getElementById('card-connect');
const cardFlash    = document.getElementById('card-flash');

const radioBtns      = document.querySelectorAll('.radio-btn');
const donorPickBtn   = document.getElementById('donor-pick-btn');
const donorFileInput = document.getElementById('donor-file-input');
const donorDropArea  = document.getElementById('donor-drop-area');
const donorFileName  = document.getElementById('donor-file-name');

const connectBtn    = document.getElementById('connect-btn');
const connectStatus = document.getElementById('connect-status');

const cardBackup       = document.getElementById('card-backup');
const backupBtn        = document.getElementById('backup-btn');
const backupProgressArea = document.getElementById('backup-progress-area');
const backupProgressBar  = document.getElementById('backup-progress-bar');
const backupProgressLabel = document.getElementById('backup-progress-label');
const backupStatus     = document.getElementById('backup-status');

const flashSummary  = document.getElementById('flash-summary');
const flashBtn      = document.getElementById('flash-btn');
const progressArea  = document.getElementById('progress-area');
const progressBar   = document.getElementById('progress-bar');
const progressLabel = document.getElementById('progress-label');
const flashStatus   = document.getElementById('flash-status');

const browserBanner = document.getElementById('browser-banner');

// ─── Browser compatibility check ─────────────────────────────────────────────
function checkBrowser() {
  if (typeof navigator.usb === 'undefined') {
    browserBanner.classList.remove('hidden');
    connectBtn.disabled = true;
    flashBtn.disabled   = true;
    donorPickBtn.disabled = true;
    radioBtns.forEach(b => b.disabled = true);
  }
}

// ─── Step 1: Radio model ──────────────────────────────────────────────────────
radioBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    radioBtns.forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    state.model = btn.dataset.model;
    markComplete(cardModel, 'step-num-1');
    unlock(cardDonor);
    updateFlashSummary();
  });
});

// ─── Step 2: Donor file ───────────────────────────────────────────────────────
donorPickBtn.addEventListener('click', () => donorFileInput.click());

donorFileInput.addEventListener('change', e => {
  if (e.target.files[0]) handleDonorFile(e.target.files[0]);
});

donorDropArea.addEventListener('dragover', e => {
  e.preventDefault();
  donorDropArea.classList.add('drag-over');
});

donorDropArea.addEventListener('dragleave', () => {
  donorDropArea.classList.remove('drag-over');
});

donorDropArea.addEventListener('drop', e => {
  e.preventDefault();
  donorDropArea.classList.remove('drag-over');
  if (e.dataTransfer.files[0]) handleDonorFile(e.dataTransfer.files[0]);
});

function handleDonorFile(file) {
  if (!file.name.toLowerCase().endsWith('.bin')) {
    donorFileName.textContent = 'Please select a .bin firmware file.';
    donorFileName.style.color = 'var(--red)';
    donorFileName.classList.remove('hidden');
    return;
  }

  state.donorFile = file;
  donorFileName.textContent = `${file.name}  (${formatBytes(file.size)})`;
  donorFileName.style.color = '';
  donorFileName.classList.remove('hidden');

  const reader = new FileReader();
  reader.onload = e => {
    state.donorBytes = new Uint8Array(e.target.result);
    markComplete(cardDonor, 'step-num-2');
    unlock(cardConnect);
    connectBtn.disabled = false;
    updateFlashSummary();
  };
  reader.readAsArrayBuffer(file);
}

// ─── Step 3: Connect ──────────────────────────────────────────────────────────
connectBtn.addEventListener('click', async () => {
  setStatus(connectStatus, 'Opening browser USB device picker…', '');
  connectBtn.disabled = true;

  try {
    state.device = await connectUSB();
    const name = state.device.productName || 'Radio in flash mode';
    setStatus(connectStatus, `Connected: ${name}`, 'success');
    markComplete(cardConnect, 'step-num-3');
    unlock(cardBackup);
    backupBtn.disabled = false;
    unlock(cardFlash);
    flashBtn.disabled = false;
    updateFlashSummary();
  } catch (err) {
    connectBtn.disabled = false;
    if (err.name === 'NotFoundError') {
      setStatus(connectStatus, 'No device selected.', '');
    } else {
      setStatus(connectStatus, `Connection failed: ${err.message}`, 'error');
    }
  }
});

// ─── Step 4: Flash ────────────────────────────────────────────────────────────
flashBtn.addEventListener('click', async () => {
  flashBtn.disabled = true;
  progressArea.classList.remove('hidden');
  setStatus(flashStatus, 'Starting…', '');

  try {
    await flashFirmware(state.device, state.donorBytes, state.model, (pct, msg) => {
      progressBar.style.width   = `${pct}%`;
      progressLabel.textContent = `${Math.round(pct)}%`;
      if (msg) setStatus(flashStatus, msg, '');
    });

    progressBar.style.width   = '100%';
    progressLabel.textContent = '100%';
    setStatus(
      flashStatus,
      'Done! Firmware flashed successfully. Unplug the cable and power on your radio.',
      'success'
    );
    markComplete(cardFlash, 'step-num-4');
  } catch (err) {
    setStatus(flashStatus, `Flash failed: ${err.message}`, 'error');
    flashBtn.disabled = false;
  }
});

// ─── Backup button ────────────────────────────────────────────────────────────
backupBtn.addEventListener('click', async () => {
  backupBtn.disabled = true;
  backupProgressArea.classList.remove('hidden');
  setStatus(backupStatus, 'Starting backup…', '');

  try {
    const data = await backupFirmware(state.device, (pct, msg) => {
      backupProgressBar.style.width    = `${pct}%`;
      backupProgressLabel.textContent  = `${Math.round(pct)}%`;
      if (msg) setStatus(backupStatus, msg, '');
    });

    downloadBackup(data);
    backupProgressBar.style.width   = '100%';
    backupProgressLabel.textContent = '100%';
    setStatus(backupStatus, `Backup saved — ${formatBytes(data.length)}.`, 'success');
    markComplete(cardBackup, 'backup-badge');
  } catch (err) {
    setStatus(backupStatus, `Backup failed: ${err.message}`, 'error');
    backupBtn.disabled = false;
  }
});

// ─── WebUSB: connect ──────────────────────────────────────────────────────────
async function connectUSB() {
  const device = await navigator.usb.requestDevice({ filters: DFU_FILTERS });
  await device.open();
  if (device.configuration === null) {
    await device.selectConfiguration(1);
  }
  return device;
}

// ─── WebUSB: flash ────────────────────────────────────────────────────────────
async function flashFirmware(device, donorBytes, model, onProgress) {
  // 1. Fetch the firmware binary from GitHub Releases
  onProgress(0, 'Fetching firmware from GitHub…');
  const url = FIRMWARE_URLS[model];
  let fwResponse;
  try {
    fwResponse = await fetch(url);
  } catch (e) {
    throw new Error(`Could not load firmware file (${url}). ${e.message}`);
  }
  if (!fwResponse.ok) {
    throw new Error(`Firmware file not found (HTTP ${fwResponse.status}): ${url}`);
  }
  const firmware = new Uint8Array(await fwResponse.arrayBuffer());
  onProgress(4, 'Firmware downloaded.');

  // 2. Validate donor file size before extracting
  const requiredDonorSize = CODEC_SRC_OFFSET + CODEC_SRC_LENGTH;
  if (donorBytes.length < requiredDonorSize) {
    throw new Error(
      `Donor file is too small (${formatBytes(donorBytes.length)}). ` +
      `Expected at least ${formatBytes(requiredDonorSize)}.`
    );
  }

  // 3. Extract codec from donor and patch it into the firmware image
  onProgress(5, 'Extracting codec from donor file…');
  const codec = donorBytes.slice(CODEC_SRC_OFFSET, CODEC_SRC_OFFSET + CODEC_SRC_LENGTH);

  const requiredFwSize = CODEC_DST_OFFSET + CODEC_SRC_LENGTH;
  if (firmware.length < requiredFwSize) {
    throw new Error(
      `Firmware image is too small to accept the codec patch ` +
      `(got ${formatBytes(firmware.length)}, need ${formatBytes(requiredFwSize)}).`
    );
  }
  firmware.set(codec, CODEC_DST_OFFSET);
  onProgress(8, 'Codec patched into firmware image.');

  // 4. Find the DFU interface and claim it
  onProgress(9, 'Claiming DFU interface…');
  const ifNum = findDfuInterface(device);
  if (ifNum === null) {
    throw new Error('No DFU interface found on the connected device.');
  }
  await device.claimInterface(ifNum);

  // 5. Ensure the device is in dfuIDLE — clear any stale error or operation
  let st = await dfuGetStatus(device, ifNum);
  if (st.bState === STATE_ERROR) {
    await dfuOut(device, ifNum, DFU_CLRSTATUS, 0);
    st = await dfuGetStatus(device, ifNum);
  }
  if (st.bState !== STATE_IDLE && st.bState !== STATE_DNLOAD_IDLE) {
    await dfuOut(device, ifNum, DFU_ABORT, 0);
    st = await dfuGetStatus(device, ifNum);
  }
  if (st.bState !== STATE_IDLE) {
    throw new Error(`Device is not ready (state ${st.bState}). Try reconnecting the radio.`);
  }

  // 6. Erase flash sectors 3-9 (covers FIRMWARE_START through codec end)
  for (let i = 0; i < SECTORS_TO_ERASE.length; i++) {
    const pct = 10 + (i / SECTORS_TO_ERASE.length) * 30;
    onProgress(pct, `Erasing sector ${i + 1} of ${SECTORS_TO_ERASE.length}…`);
    await dfuErasesector(device, ifNum, SECTORS_TO_ERASE[i]);
  }

  // 7. Set the write address pointer to the start of firmware flash
  onProgress(41, 'Setting write address…');
  await dfuSetAddress(device, ifNum, FIRMWARE_START);

  // 8. Write firmware in 2 KB blocks
  const totalBlocks = Math.ceil(firmware.length / BLOCK_SIZE);
  for (let block = 0; block < totalBlocks; block++) {
    const pct = 43 + (block / totalBlocks) * 50;
    onProgress(pct, `Writing block ${block + 1} of ${totalBlocks}…`);

    const offset = block * BLOCK_SIZE;
    const chunk  = firmware.slice(offset, Math.min(offset + BLOCK_SIZE, firmware.length));

    // wValue = block index + 2 (STM32 DFU convention: 0/1 are reserved for
    // special commands; data blocks start at wValue=2)
    await dfuOut(device, ifNum, DFU_DNLOAD, block + 2, chunk);
    await dfuPoll(device, ifNum, STATE_DNLOAD_IDLE);
  }

  // 9. Zero-length DFU_DNLOAD signals end-of-image → triggers manifest
  onProgress(94, 'Sending manifest command…');
  await dfuOut(device, ifNum, DFU_DNLOAD, totalBlocks + 2, new Uint8Array(0));

  // 10. Poll through manifest states; device will self-reset when done.
  // A USB disconnect error here is normal and treated as success.
  try {
    await dfuPoll(device, ifNum, STATE_MANIFEST_WAIT_RESET);
  } catch (e) {
    const msg = e.message || '';
    const isDisconnect =
      msg.includes('disconnected') ||
      msg.includes('network changed') ||
      msg.includes('No device selected') ||
      e.name === 'NetworkError';
    if (!isDisconnect) throw e;
    // Device reset itself — this is the expected success path
  }

  onProgress(100, null);
}

// ─── DFU helper functions ─────────────────────────────────────────────────────

// Scan the USB configuration for the first DFU-class interface and return its
// interface number, or null if none is found.
function findDfuInterface(device) {
  for (const iface of device.configuration.interfaces) {
    for (const alt of iface.alternates) {
      if (alt.interfaceClass === 0xFE && alt.interfaceSubclass === 0x01) {
        return iface.interfaceNumber;
      }
    }
  }
  return null;
}

// Issue a class OUT request to the DFU interface with no data body.
async function dfuOut(device, ifNum, request, value, data) {
  const result = await device.controlTransferOut(
    { requestType: 'class', recipient: 'interface', request, value, index: ifNum },
    data instanceof Uint8Array ? data : new Uint8Array(0)
  );
  if (result.status !== 'ok') {
    throw new Error(`DFU request 0x${request.toString(16)} failed: ${result.status}`);
  }
}

// Issue DFU_GETSTATUS and return the parsed 6-byte response.
async function dfuGetStatus(device, ifNum) {
  const result = await device.controlTransferIn(
    { requestType: 'class', recipient: 'interface', request: DFU_GETSTATUS, value: 0, index: ifNum },
    6
  );
  if (result.status !== 'ok') {
    throw new Error(`DFU_GETSTATUS failed: ${result.status}`);
  }
  const d = new Uint8Array(result.data.buffer);
  return {
    bStatus:        d[0],
    bwPollTimeout:  d[1] | (d[2] << 8) | (d[3] << 16),
    bState:         d[4],
  };
}

// Poll DFU_GETSTATUS until a stable/idle state is reached, respecting the
// device's requested poll timeout between BUSY or MANIFEST transitions.
async function dfuPoll(device, ifNum, targetState) {
  for (;;) {
    const st = await dfuGetStatus(device, ifNum);

    if (st.bStatus !== 0x00) {
      const name = DFU_STATUS_NAMES[st.bStatus] || `0x${st.bStatus.toString(16)}`;
      throw new Error(`DFU device error: ${name}`);
    }
    if (st.bState === STATE_ERROR) {
      throw new Error('DFU device entered error state.');
    }
    if (st.bState === targetState) {
      return st;
    }

    // Busy or manifesting — wait the device-specified timeout before polling again
    if (st.bState === STATE_DNBUSY || st.bState === STATE_MANIFEST) {
      await delay(Math.max(st.bwPollTimeout, 10));
    }
    // STATE_DNLOAD_SYNC and STATE_MANIFEST_SYNC fall through immediately to re-poll
  }
}

// Send the STM32 DFU "Erase Sector" special command for the sector that
// contains the given address, then poll until the erase completes.
async function dfuErasesector(device, ifNum, addr) {
  const cmd = new Uint8Array(5);
  cmd[0] = STM32_CMD_ERASE;
  cmd[1] = (addr >>>  0) & 0xFF;
  cmd[2] = (addr >>>  8) & 0xFF;
  cmd[3] = (addr >>> 16) & 0xFF;
  cmd[4] = (addr >>> 24) & 0xFF;
  await dfuOut(device, ifNum, DFU_DNLOAD, 0, cmd);
  await dfuPoll(device, ifNum, STATE_DNLOAD_IDLE);
}

// Send the STM32 DFU "Set Address Pointer" special command, then poll until
// the device acknowledges it.  All subsequent data blocks are written relative
// to this base address.
async function dfuSetAddress(device, ifNum, addr) {
  const cmd = new Uint8Array(5);
  cmd[0] = STM32_CMD_SET_ADDR;
  cmd[1] = (addr >>>  0) & 0xFF;
  cmd[2] = (addr >>>  8) & 0xFF;
  cmd[3] = (addr >>> 16) & 0xFF;
  cmd[4] = (addr >>> 24) & 0xFF;
  await dfuOut(device, ifNum, DFU_DNLOAD, 0, cmd);
  await dfuPoll(device, ifNum, STATE_DNLOAD_IDLE);
}

// ─── WebUSB: backup ───────────────────────────────────────────────────────────

// Read BACKUP_BLOCKS * BLOCK_SIZE bytes from FIRMWARE_START via DFU_UPLOAD and
// return them as a single Uint8Array.  The interface is claimed at entry and
// always released (even on error) so the subsequent flash step can claim it.
async function backupFirmware(device, onProgress) {
  const ifNum = findDfuInterface(device);
  if (ifNum === null) throw new Error('No DFU interface found on the connected device.');

  await device.claimInterface(ifNum);
  try {
    // Clear any stale DFU state before reading
    let st = await dfuGetStatus(device, ifNum);
    if (st.bState === STATE_ERROR) {
      await dfuOut(device, ifNum, DFU_CLRSTATUS, 0);
      st = await dfuGetStatus(device, ifNum);
    }
    if (st.bState !== STATE_IDLE) {
      await dfuOut(device, ifNum, DFU_ABORT, 0);
      st = await dfuGetStatus(device, ifNum);
    }

    // Set the address pointer to the firmware start, then abort back to
    // dfuIDLE — SET_ADDR leaves the device in dfuDNLOAD-IDLE, and DFU_UPLOAD
    // requires dfuIDLE.  The address pointer register survives the ABORT.
    onProgress(0, 'Setting read address…');
    await dfuSetAddress(device, ifNum, FIRMWARE_START);
    await dfuOut(device, ifNum, DFU_ABORT, 0);

    st = await dfuGetStatus(device, ifNum);
    if (st.bState !== STATE_IDLE) {
      throw new Error(`Device not ready for upload (state ${st.bState}).`);
    }

    // Read blocks with DFU_UPLOAD.  wValue starts at 2 (STM32 DFU convention;
    // 0 and 1 are reserved for special responses).
    const chunks = [];
    for (let block = 0; block < BACKUP_BLOCKS; block++) {
      const pct = (block / BACKUP_BLOCKS) * 100;
      if (block % 20 === 0) {
        onProgress(pct, `Reading block ${block + 1} of ${BACKUP_BLOCKS}…`);
      }

      const result = await device.controlTransferIn({
        requestType: 'class',
        recipient:   'interface',
        request:     DFU_UPLOAD,
        value:       block + 2,
        index:       ifNum,
      }, BLOCK_SIZE);

      if (result.status !== 'ok') {
        throw new Error(`DFU_UPLOAD failed at block ${block}: ${result.status}`);
      }

      const chunk = new Uint8Array(result.data.buffer);
      chunks.push(chunk);
      if (chunk.length < BLOCK_SIZE) break; // end of readable flash region
    }

    // Abort from dfuUPLOAD-IDLE back to dfuIDLE so the device is clean for
    // the flash step.
    await dfuOut(device, ifNum, DFU_ABORT, 0);

    const totalBytes = chunks.reduce((sum, c) => sum + c.length, 0);
    const backup = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) { backup.set(chunk, offset); offset += chunk.length; }
    return backup;

  } finally {
    try { await device.releaseInterface(ifNum); } catch (_) {}
  }
}

function downloadBackup(data) {
  const date  = new Date().toISOString().slice(0, 10);
  const model = state.model || 'radio';
  const blob  = new Blob([data], { type: 'application/octet-stream' });
  const url   = URL.createObjectURL(blob);
  const a     = document.createElement('a');
  a.href     = url;
  a.download = `ClearDMR_backup_${model}_${date}.bin`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── UI helpers ───────────────────────────────────────────────────────────────
function unlock(card) {
  card.classList.remove('locked');
}

function markComplete(card, stepNumId) {
  card.classList.add('complete');
  const el = document.getElementById(stepNumId);
  if (el) el.textContent = '✓';
}

function setStatus(el, msg, type) {
  el.textContent = msg;
  el.className   = 'status-text' + (type ? ` ${type}` : '');
}

function updateFlashSummary() {
  const lines = [];
  if (state.model)     lines.push(`<strong>Radio:</strong> ${MODEL_NAMES[state.model]}`);
  if (state.donorFile) lines.push(`<strong>Donor file:</strong> ${state.donorFile.name}`);
  if (state.device)    lines.push(`<strong>USB device:</strong> ${state.device.productName || 'Connected'}`);
  if (!lines.length)   return;
  flashSummary.innerHTML = lines.join('<br>');
  flashSummary.classList.remove('hidden');
}

function formatBytes(bytes) {
  if (bytes < 1024)        return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Windows driver notice ────────────────────────────────────────────────────
function checkWindows() {
  const platform = navigator.userAgentData?.platform ?? navigator.platform ?? '';
  const isWindows = /win/i.test(platform);
  if (isWindows) {
    document.getElementById('card-windows-driver').classList.remove('hidden');
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────
checkBrowser();
checkWindows();
