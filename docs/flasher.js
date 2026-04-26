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
  setStatus(flashStatus, 'Preparing…', '');

  try {
    await flashFirmware(state.device, state.donorBytes, state.model, (pct, msg) => {
      progressBar.style.width  = `${pct}%`;
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

// ─── WebUSB: connect ──────────────────────────────────────────────────────────
// Returns an open USBDevice in DFU mode.
// The browser will show its own permission dialog restricted to DFU_FILTERS.
async function connectUSB() {
  const device = await navigator.usb.requestDevice({ filters: DFU_FILTERS });
  await device.open();
  if (device.configuration === null) {
    await device.selectConfiguration(1);
  }
  return device;
}

// ─── WebUSB: flash ────────────────────────────────────────────────────────────
// Placeholder implementation — reports simulated progress so the full UI flow
// can be exercised today. Replace the body of this function with a real
// USB DFU 1.1 / STM32 DFU extension implementation.
//
// Real implementation outline:
//   1. Claim DFU interface (usually interface 0 or 1; scan descriptors)
//   2. Issue DFU_GETSTATUS to confirm DFU_IDLE state
//   3. Extract vocoder codec bytes from donorBytes at model-specific offsets
//   4. Patch extracted codec into the ClearDMR firmware image
//   5. Erase target flash sectors via STM32 DFU erase command (DFU_DNLOAD, wValue=0)
//   6. Write firmware in <=2 KB blocks using DFU_DNLOAD (wValue = block index)
//      — poll DFU_GETSTATUS after each block; call onProgress(pct, msg)
//   7. Send zero-length DFU_DNLOAD to signal end-of-image
//   8. Issue DFU_GETSTATUS until dfuMANIFEST_WAIT_RESET, then trigger reset
async function flashFirmware(device, donorBytes, model, onProgress) {
  // TODO: replace with real DFU protocol
  console.log('[flasher] flashFirmware called', { model, donorSize: donorBytes?.length });

  const stages = [
    [0,   'Erasing flash sectors…'],
    [15,  'Extracting codec from donor file…'],
    [25,  'Patching firmware image…'],
    [35,  'Writing firmware to radio…'],
    [90,  'Finalizing…'],
    [100, null],
  ];

  for (const [pct, msg] of stages) {
    await delay(pct === 35 ? 1800 : 600);
    onProgress(pct, msg);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
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

// ─── Init ─────────────────────────────────────────────────────────────────────
checkBrowser();
