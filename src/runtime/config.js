// Settings constants, preference loaders, and ready promises

const SIMPLE_PRESET_KEY = 'simplePreset';
const ENGINE_BACKEND_KEY = 'engineBackend';
const WEBGPU_MODEL_KEY = 'webgpuModel';
const DEFAULT_SIMPLE_PRESET = 'M';
const DEFAULT_ENGINE_BACKEND = 'webgl';
const DEFAULT_WEBGPU_MODEL = 'ModeA';
const SIMPLE_PRESET_VALUES = new Set(['S', 'M', 'L', 'UL', 'VL']);
const ENGINE_BACKEND_VALUES = new Set(['off', 'webgl', 'webgpu']);
const WEBGPU_MODEL_VALUES = new Set([
    'ModeA', 'ModeAA', 'ModeB', 'ModeBB', 'ModeC', 'ModeCA'
]);

let selectedSimplePreset = DEFAULT_SIMPLE_PRESET;
let selectedEngineBackend = DEFAULT_ENGINE_BACKEND;
let selectedWebGpuModel = DEFAULT_WEBGPU_MODEL;
let presetReadyPromise = Promise.resolve();
let backendReadyPromise = Promise.resolve();
let webgpuModelReadyPromise = Promise.resolve();
let backendPreferenceLoaded = false;

function runtimeLog(label, data = {}) {
    if (typeof window.NHScalerLog === 'function') {
        window.NHScalerLog(label, data);
        return;
    }
    console.log('[NH Scaler]', label, { ts: new Date().toISOString(), ...data });
}

function normalizeSimplePreset(value) {
    const normalized = String(value || '').toUpperCase();
    return SIMPLE_PRESET_VALUES.has(normalized) ? normalized : DEFAULT_SIMPLE_PRESET;
}

function normalizeEngineBackend(value) {
    const normalized = String(value || '').toLowerCase();
    return ENGINE_BACKEND_VALUES.has(normalized) ? normalized : DEFAULT_ENGINE_BACKEND;
}

function normalizeWebGpuModel(value) {
    const normalized = String(value || '').trim();
    return WEBGPU_MODEL_VALUES.has(normalized) ? normalized : DEFAULT_WEBGPU_MODEL;
}

function getRuntimePreferenceSnapshot() {
    return {
        selectedSimplePreset,
        selectedEngineBackend,
        selectedWebGpuModel
    };
}

function getNormalizedRuntimePreferenceSnapshot(snapshot) {
    const source = snapshot && typeof snapshot === 'object' ? snapshot : {};
    return {
        selectedSimplePreset: normalizeSimplePreset(source.selectedSimplePreset),
        selectedEngineBackend: normalizeEngineBackend(source.selectedEngineBackend),
        selectedWebGpuModel: normalizeWebGpuModel(source.selectedWebGpuModel)
    };
}

function applyRuntimePreferenceStorageChanges(changes) {
    const hasPresetChange = !!changes[SIMPLE_PRESET_KEY];
    const hasBackendChange = !!changes[ENGINE_BACKEND_KEY];
    const hasWebGpuModelChange = !!changes[WEBGPU_MODEL_KEY];
    if (!hasPresetChange && !hasBackendChange && !hasWebGpuModelChange) {
        return { didChange: false, changed: { preset: false, backend: false, webgpuModel: false } };
    }

    let didChange = false;

    if (hasPresetChange) {
        const nextPreset = normalizeSimplePreset(changes[SIMPLE_PRESET_KEY].newValue);
        if (nextPreset !== selectedSimplePreset) {
            selectedSimplePreset = nextPreset;
            didChange = true;
        }
    }

    if (hasBackendChange) {
        const nextBackend = normalizeEngineBackend(changes[ENGINE_BACKEND_KEY].newValue);
        if (nextBackend !== selectedEngineBackend) {
            selectedEngineBackend = nextBackend;
            didChange = true;
        }
    }

    if (hasWebGpuModelChange) {
        const nextWebGpuModel = normalizeWebGpuModel(changes[WEBGPU_MODEL_KEY].newValue);
        if (nextWebGpuModel !== selectedWebGpuModel) {
            selectedWebGpuModel = nextWebGpuModel;
            didChange = true;
        }
    }

    return {
        didChange,
        changed: {
            preset: hasPresetChange,
            backend: hasBackendChange,
            webgpuModel: hasWebGpuModelChange
        }
    };
}

function loadSimplePresetPreference() {
    if (!chrome?.storage?.sync) {
        return Promise.resolve();
    }

    return new Promise((resolve) => {
        chrome.storage.sync.get({ [SIMPLE_PRESET_KEY]: DEFAULT_SIMPLE_PRESET }, (result) => {
            selectedSimplePreset = normalizeSimplePreset(result?.[SIMPLE_PRESET_KEY]);
            runtimeLog('preset:loaded', { selectedSimplePreset });
            resolve();
        });
    });
}

function loadEngineBackendPreference() {
    if (!chrome?.storage?.sync) {
        return Promise.resolve();
    }

    return new Promise((resolve) => {
        chrome.storage.sync.get({ [ENGINE_BACKEND_KEY]: DEFAULT_ENGINE_BACKEND }, (result) => {
            selectedEngineBackend = normalizeEngineBackend(result?.[ENGINE_BACKEND_KEY]);
            backendPreferenceLoaded = true;
            runtimeLog('backend:loaded', { selectedEngineBackend });
            resolve();
        });
    });
}

function loadWebGpuModelPreference() {
    if (!chrome?.storage?.sync) {
        return Promise.resolve();
    }

    return new Promise((resolve) => {
        chrome.storage.sync.get({ [WEBGPU_MODEL_KEY]: DEFAULT_WEBGPU_MODEL }, (result) => {
            selectedWebGpuModel = normalizeWebGpuModel(result?.[WEBGPU_MODEL_KEY]);
            runtimeLog('webgpu-model:loaded', { selectedWebGpuModel });
            resolve();
        });
    });
}

presetReadyPromise = loadSimplePresetPreference();
backendReadyPromise = loadEngineBackendPreference();
webgpuModelReadyPromise = loadWebGpuModelPreference();
