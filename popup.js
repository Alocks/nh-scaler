const SIMPLE_PRESET_KEY = 'simplePreset';
const ENGINE_BACKEND_KEY = 'engineBackend';
const WEBGPU_MODEL_KEY = 'webgpuModel';

const DEFAULT_SIMPLE_PRESET = 'M';
const DEFAULT_ENGINE_BACKEND = 'webgl';
const DEFAULT_WEBGPU_MODEL = 'ModeA';
const CLEAR_CACHE_MESSAGE_TYPE = 'nh-scaler:clear-cache';
const GET_DIAGNOSTICS_MESSAGE_TYPE = 'nh-scaler:get-diagnostics';
const NHENTAI_TAB_URL_PATTERN = /^https?:\/\/(?:[^/]+\.)?nhentai\.net\//i;
let isWebGpuSupported = true;

const clearCacheButton = document.getElementById('clearCacheButton');
const cacheActionStatus = document.getElementById('cacheActionStatus');
const runtimeDiagnostics = document.getElementById('runtimeDiagnostics');

function setCacheActionStatus(message, tone = '') {
  if (!cacheActionStatus) return;
  cacheActionStatus.textContent = message;
  cacheActionStatus.classList.remove('error', 'success');
  if (tone) {
    cacheActionStatus.classList.add(tone);
  }
}

function isNhentaiTab(tab) {
  return typeof tab?.url === 'string' && NHENTAI_TAB_URL_PATTERN.test(tab.url);
}

function setRuntimeDiagnosticsText(text) {
  if (!runtimeDiagnostics) return;
  runtimeDiagnostics.textContent = text;
}

function formatRuntimeDiagnostics(diagnostics) {
  if (!diagnostics || typeof diagnostics !== 'object') {
    return 'Diagnostics unavailable.';
  }

  const prefs = diagnostics.preferences || {};
  const hooks = diagnostics.hooks || {};
  const queue = diagnostics.queue || {};
  const adapters = diagnostics.adapters || {};
  const generatedAt = Number.isFinite(diagnostics.generatedAt) ? new Date(diagnostics.generatedAt).toLocaleTimeString() : 'unknown';
  const pageUrl = diagnostics.pageUrl || 'unknown';

  return [
    `Snapshot: ${generatedAt}`,
    `Page: ${pageUrl}`,
    `Backend: ${prefs.selectedEngineBackend || 'unknown'} (effective: ${diagnostics.effectiveBackend || 'unknown'})`,
    `Preset: ${prefs.selectedSimplePreset || 'unknown'} | WebGPU model: ${prefs.selectedWebGpuModel || 'unknown'}`,
    `Route: ${diagnostics.readerRoute ? 'reader' : 'non-reader'} | Foreground: ${diagnostics.foreground ? 'yes' : 'no'}`,
    `Hooks - fetch: ${hooks.fetch ? 'ok' : 'missing'}, image-src: ${hooks.imageSrc ? 'ok' : 'missing'}, Image(): ${hooks.imageConstructor ? 'ok' : 'missing'}`,
    `Adapters - WebGL: ${adapters.webgl?.isSupported ? 'supported' : 'unavailable'}, WebGPU: ${adapters.webgpu?.isSupported ? 'supported' : 'unavailable'}`,
    `Queue - size: ${queue.size ?? 0}, in-flight: ${queue.inFlightCount ?? 0}, processed: ${queue.processedCount ?? 0}`
  ].join('\n');
}

async function refreshRuntimeDiagnostics() {
  const activeTab = await getActiveTab();
  if (!activeTab?.id || !isNhentaiTab(activeTab)) {
    setRuntimeDiagnosticsText('Open an nhentai tab to view runtime diagnostics.');
    return;
  }

  try {
    const response = await chrome.tabs.sendMessage(activeTab.id, { type: GET_DIAGNOSTICS_MESSAGE_TYPE });
    if (!response?.ok) {
      throw new Error(response?.error || 'Diagnostics request failed');
    }
    setRuntimeDiagnosticsText(formatRuntimeDiagnostics(response.diagnostics));
  } catch (error) {
    const message = String(error?.message || 'Diagnostics unavailable');
    setRuntimeDiagnosticsText(
      message.includes('Receiving end does not exist')
        ? 'Runtime not ready in this tab yet. Reload the nhentai page.'
        : `Diagnostics unavailable: ${message}`
    );
  }
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs?.[0] || null;
}

async function refreshCacheActionAvailability() {
  if (!clearCacheButton) return;

  try {
    const activeTab = await getActiveTab();
    const isEligible = !!activeTab?.id && isNhentaiTab(activeTab);
    clearCacheButton.disabled = !isEligible;

    if (!isEligible) {
      setCacheActionStatus('Open an nhentai tab to clear cached images.');
      return;
    }

    setCacheActionStatus('');
  } catch {
    clearCacheButton.disabled = true;
    setCacheActionStatus('Could not inspect the active tab.', 'error');
  }
}

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
refreshCacheActionAvailability();
refreshRuntimeDiagnostics();

if (clearCacheButton) {
  clearCacheButton.addEventListener('click', async () => {
    clearCacheButton.disabled = true;
    setCacheActionStatus('Clearing cache...');

    try {
      const activeTab = await getActiveTab();
      if (!activeTab?.id) {
        throw new Error('Open an nhentai tab first');
      }

      if (!isNhentaiTab(activeTab)) {
        throw new Error('Open an nhentai tab first');
      }

      const response = await chrome.tabs.sendMessage(activeTab.id, { type: CLEAR_CACHE_MESSAGE_TYPE });
      if (!response?.ok) {
        throw new Error(response?.error || 'Cache clear request failed');
      }

      setCacheActionStatus('Cached images cleared for this tab.', 'success');
    } catch (error) {
      const message = String(error?.message || '');
      setCacheActionStatus(
        message.includes('Receiving end does not exist')
          ? 'This tab is not ready yet. Reload the nhentai page and try again.'
          : error?.message || 'Could not clear cache. Open an nhentai reader tab and try again.',
        'error'
      );
    } finally {
      refreshCacheActionAvailability();
      refreshRuntimeDiagnostics();
    }
  });
}
