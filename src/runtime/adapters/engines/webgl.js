// WebGL adapter using anime4k-webgl library

/** @type {any} */
let scaler = null;
/** @type {Promise<any> | null} */
let scalerPromise = null;

function getRestoreUpscalePreset(lib, runtimeSettings = getRuntimePreferenceSnapshot()) {
    const settings = getNormalizedRuntimePreferenceSnapshot(runtimeSettings);
    const preferredSimple = {
        S: lib.ANIME4KJS_SIMPLE_S_2X,
        M: lib.ANIME4KJS_SIMPLE_M_2X,
        L: lib.ANIME4KJS_SIMPLE_L_2X,
        VL: lib.ANIME4KJS_SIMPLE_VL_2X,
        UL: lib.ANIME4KJS_SIMPLE_UL_2X
    };

    if (preferredSimple[settings.selectedSimplePreset]) {
        return preferredSimple[settings.selectedSimplePreset];
    }

    const fallbackOrder = ['M', 'L', 'S', 'UL', 'VL'];
    for (const key of fallbackOrder) {
        if (preferredSimple[key]) return preferredSimple[key];
    }

    return lib.ANIME4KJS_EMPTY || [];
}

async function getScaler(runtimeSettings = getRuntimePreferenceSnapshot()) {
    const settings = getNormalizedRuntimePreferenceSnapshot(runtimeSettings);
    if (scaler) return scaler;
    if (scalerPromise) return scalerPromise;

    scalerPromise = (async () => {
        await Promise.all([presetReadyPromise, backendReadyPromise]);

        const lib = window.Anime4KJS || window.Anime4K;
        if (!lib) {
            throw new Error('Anime4KJS WebGL runtime not found on window');
        }

        const preset = getRestoreUpscalePreset(lib, settings);
        runtimeLog('scaler:init', {
            backend: 'webgl',
            hasImageUpscaler: typeof lib.ImageUpscaler === 'function',
            presetLength: Array.isArray(preset) ? preset.length : null,
            selectedSimplePreset: settings.selectedSimplePreset
        });

        const instance = new lib.ImageUpscaler(preset);

        if (instance && instance.supported !== undefined) {
            runtimeLog('scaler:webgl-supported', { supported: instance.supported });
        }

        if (instance && instance.renderer) {
            runtimeLog('scaler:renderer-info', {
                hasRenderer: !!instance.renderer,
                rendererType: instance.renderer?.constructor?.name
            });
        }

        return instance;
    })();

    try {
        scaler = await scalerPromise;
        return scaler;
    } finally {
        scalerPromise = null;
    }
}

function resetWebGlAdapterState() {
    scaler = null;
    scalerPromise = null;
}

function getWebGlAdapterDiagnostics() {
    const lib = window.Anime4KJS || window.Anime4K;
    const capable = !!lib && typeof lib.ImageUpscaler === 'function';
    const initialized = !!scaler;
    const isSupported = initialized && scaler.supported === true;
    return { capable, initialized, isSupported };
}

function createEngineAdapter(overrides = {}) {
    if (typeof window.createBaseEngineAdapter === 'function') {
        return window.createBaseEngineAdapter(overrides);
    }

    return {
        isSupported: () => false,
        upscale: async () => {
            throw new Error('Base engine adapter: upscale() is not implemented');
        },
        prewarm: async () => {},
        reset: () => {},
        ...overrides
    };
}


window.WebGLAdapter = createEngineAdapter({
    isSupported: () => {
        return scaler && scaler.supported === true;
    },
    upscale: async (tempImg, canvas, runtimeSettings = getRuntimePreferenceSnapshot()) => {
        const settings = getNormalizedRuntimePreferenceSnapshot(runtimeSettings);
        const engine = await getScaler(settings);
        if (!engine.supported) {
            throw new Error('Anime4KJS WebGL pipeline not supported');
        }
        engine.attachSource(tempImg, canvas);
        engine.upscale();
        engine.detachSource();
        return `SIMPLE_${settings.selectedSimplePreset}`;
    },
    prewarm: async (runtimeSettings = getRuntimePreferenceSnapshot()) => {
        await getScaler(runtimeSettings);
    },
    reset: resetWebGlAdapterState,
    getDiagnosticsStatus: getWebGlAdapterDiagnostics
});
