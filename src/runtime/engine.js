// Dispatcher — adapter implementations are in src/runtime/adapters/

function getEffectiveBackend(runtimeSettings = getRuntimePreferenceSnapshot()) {
    const settings = getNormalizedRuntimePreferenceSnapshot(runtimeSettings);
    if (settings.selectedEngineBackend === 'off') return 'off';
    if (settings.selectedEngineBackend === 'webgpu' && window.WebGPUAdapter?.isSupported?.()) return 'webgpu';
    return 'webgl';
}

async function upscaleWithSelectedBackend(tempImg, canvas, runtimeSettings = getRuntimePreferenceSnapshot()) {
    const settings = getNormalizedRuntimePreferenceSnapshot(runtimeSettings);
    const backend = getEffectiveBackend(settings);
    if (backend === 'webgpu') {
        try {
            const model = await window.WebGPUAdapter.upscale(tempImg, canvas, settings);
            return { backend: 'webgpu', model };
        } catch (err) {
            runtimeLog('webgpu:fallback-to-webgl', { error: String(err) });
        }
    }

    const model = await window.WebGLAdapter.upscale(tempImg, canvas, settings);
    return { backend: 'webgl', model };
}

async function prewarmSelectedBackend() {
    const settings = getRuntimePreferenceSnapshot();
    const backend = getEffectiveBackend(settings);
    if (backend === 'off') return;
    if (backend === 'webgpu') {
        if (window.WebGPUAdapter?.prewarm) {
            await window.WebGPUAdapter.prewarm(settings);
        }
        return;
    }
    if (window.WebGLAdapter?.prewarm) {
        await window.WebGLAdapter.prewarm(settings);
    }
}

function resetBackendRuntimeState() {
    if (window.WebGLAdapter?.reset) {
        window.WebGLAdapter.reset();
    }
    if (window.WebGPUAdapter?.reset) {
        window.WebGPUAdapter.reset();
    }
}
