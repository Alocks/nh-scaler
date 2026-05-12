const SIMPLE_PRESET_KEY = 'simplePreset';
const ENGINE_BACKEND_KEY = 'engineBackend';
const WEBGPU_MODEL_KEY = 'webgpuModel';

const DEFAULT_SIMPLE_PRESET = 'M';
const DEFAULT_ENGINE_BACKEND = 'webgl';
const DEFAULT_WEBGPU_MODEL = 'ModeA';
let isWebGpuSupported = true;

async function detectWebGpuSupport() {
  if (!navigator?.gpu || typeof navigator.gpu.requestAdapter !== 'function') {
    return false;
  }

  try {
    const adapter = await navigator.gpu.requestAdapter();
    return !!adapter;
  } catch {
    return false;
  }
}

function applyWebGpuAvailabilityUi(supported) {
  const webgpuTab = document.querySelector('.tab-pill[data-tab="webgpu"]');
  if (webgpuTab) {
    webgpuTab.classList.toggle('disabled', !supported);
    webgpuTab.setAttribute('aria-disabled', String(!supported));
    webgpuTab.title = supported ? '' : 'WebGPU is not supported by this browser';
  }

  document.querySelectorAll('input[name="webgpuModel"]').forEach((input) => {
    input.disabled = !supported;
    const option = input.closest('.preset-option');
    if (option) option.classList.toggle('disabled', !supported);
  });
}

function setActiveEnginePanel(backend) {
  const normalizedBackend = String(backend || DEFAULT_ENGINE_BACKEND).toLowerCase();
  const panels = document.querySelectorAll('.engine-panel');
  const tabs = document.querySelectorAll('.tab-pill');
  const webgpuWarning = document.querySelector('.tab-descriptions');

  panels.forEach((panel) => {
    panel.classList.toggle('active', panel.id === `enginePanel-${normalizedBackend}`);
  });

  tabs.forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.tab === normalizedBackend);
  });

  if (webgpuWarning) {
    webgpuWarning.style.display = normalizedBackend === 'webgpu' ? 'block' : 'none';
  }
}

// Load current settings and set radio buttons
async function loadCurrentSettings() {
  isWebGpuSupported = await detectWebGpuSupport();

  const result = await chrome.storage.sync.get({
    [SIMPLE_PRESET_KEY]: DEFAULT_SIMPLE_PRESET,
    [ENGINE_BACKEND_KEY]: DEFAULT_ENGINE_BACKEND,
    [WEBGPU_MODEL_KEY]: DEFAULT_WEBGPU_MODEL
  });

  const currentPreset = String(result[SIMPLE_PRESET_KEY] || DEFAULT_SIMPLE_PRESET).toUpperCase();
  let currentBackend = String(result[ENGINE_BACKEND_KEY] || DEFAULT_ENGINE_BACKEND).toLowerCase();
  const currentWebGpuModel = String(result[WEBGPU_MODEL_KEY] || DEFAULT_WEBGPU_MODEL);

  if (!isWebGpuSupported && currentBackend === 'webgpu') {
    currentBackend = 'webgl';
    chrome.storage.sync.set({ [ENGINE_BACKEND_KEY]: currentBackend });
  }

  const presetRadio = document.querySelector(`input[name="preset"][value="${currentPreset}"]`);
  if (presetRadio) presetRadio.checked = true;

  const webgpuModelRadio = document.querySelector(`input[name="webgpuModel"][value="${currentWebGpuModel}"]`);
  if (webgpuModelRadio) webgpuModelRadio.checked = true;

  applyWebGpuAvailabilityUi(isWebGpuSupported);
  setActiveEnginePanel(currentBackend);
}

// Save preset on selection change
document.querySelectorAll('input[name="preset"]').forEach((radio) => {
  radio.addEventListener('change', (e) => {
    if (e.target.checked) {
      chrome.storage.sync.set({ [SIMPLE_PRESET_KEY]: e.target.value });
    }
  });
});

// Save backend on tab click
document.querySelectorAll('.tab-pill').forEach((tab) => {
  tab.addEventListener('click', () => {
    const backend = String(tab.dataset.tab || DEFAULT_ENGINE_BACKEND).toLowerCase();
    if (backend === 'webgpu' && !isWebGpuSupported) {
      return;
    }
    setActiveEnginePanel(backend);
    chrome.storage.sync.set({ [ENGINE_BACKEND_KEY]: backend });
  });
});

// Save webgpu model on selection change
document.querySelectorAll('input[name="webgpuModel"]').forEach((radio) => {
  radio.addEventListener('change', (e) => {
    if (e.target.checked) {
      chrome.storage.sync.set({ [WEBGPU_MODEL_KEY]: e.target.value });
    }
  });
});

// Load on popup open
loadCurrentSettings();
