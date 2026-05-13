// Dispatcher — adapter implementations are in src/runtime/adapters/

const REQUIRED_ADAPTER_METHODS = ['isSupported', 'upscale', 'prewarm', 'reset'];

function getValidatedAdapter(adapterName) {
    const adapter = window[adapterName];
    if (!adapter || typeof adapter !== 'object') {
        throw new Error(`${adapterName} is missing from window`);
    }

    for (const methodName of REQUIRED_ADAPTER_METHODS) {
        if (typeof adapter[methodName] !== 'function') {
            throw new Error(`${adapterName}.${methodName} is not a function`);
        }
    }

    return adapter;
}

function tryGetValidatedAdapter(adapterName) {
    try {
        return getValidatedAdapter(adapterName);
    } catch (error) {
        runtimeLog('adapter:invalid', { adapterName, error: String(error) });
        return null;
    }
}

function getEffectiveBackend(runtimeSettings = getRuntimePreferenceSnapshot()) {
    const settings = getNormalizedRuntimePreferenceSnapshot(runtimeSettings);
    if (settings.selectedEngineBackend === 'off') return 'off';
    const webGpuAdapter = tryGetValidatedAdapter('WebGPUAdapter');
    if (settings.selectedEngineBackend === 'webgpu' && webGpuAdapter && webGpuAdapter.isSupported()) {
        return 'webgpu';
    }
    return 'webgl';
}

async function upscaleWithSelectedBackend(tempImg, canvas, runtimeSettings = getRuntimePreferenceSnapshot()) {
    const settings = getNormalizedRuntimePreferenceSnapshot(runtimeSettings);
    const backend = getEffectiveBackend(settings);
    if (backend === 'webgpu') {
        try {
            const webGpuAdapter = getValidatedAdapter('WebGPUAdapter');
            const model = await webGpuAdapter.upscale(tempImg, canvas, settings);
            return { backend: 'webgpu', model };
        } catch (err) {
            runtimeLog('webgpu:fallback-to-webgl', { error: String(err) });
        }
    }

    const webGlAdapter = getValidatedAdapter('WebGLAdapter');
    const model = await webGlAdapter.upscale(tempImg, canvas, settings);
    return { backend: 'webgl', model };
}

async function prewarmSelectedBackend() {
    const settings = getRuntimePreferenceSnapshot();
    const backend = getEffectiveBackend(settings);
    if (backend === 'off') return;
    if (backend === 'webgpu') {
        const webGpuAdapter = getValidatedAdapter('WebGPUAdapter');
        await webGpuAdapter.prewarm(settings);
        return;
    }
    const webGlAdapter = getValidatedAdapter('WebGLAdapter');
    await webGlAdapter.prewarm(settings);
}

function resetBackendRuntimeState() {
    const webGlAdapter = tryGetValidatedAdapter('WebGLAdapter');
    if (webGlAdapter) {
        webGlAdapter.reset();
    }

    const webGpuAdapter = tryGetValidatedAdapter('WebGPUAdapter');
    if (webGpuAdapter) {
        webGpuAdapter.reset();
    }
}
