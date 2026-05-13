// Dispatcher — adapter implementations are in src/runtime/adapters/

function getEffectiveBackend() {
    if (selectedEngineBackend === 'off') return 'off';
    if (selectedEngineBackend === 'webgpu' && window.WebGPUAdapter?.isSupported?.()) return 'webgpu';
    return 'webgl';
}

async function upscaleWithSelectedBackend(tempImg, canvas) {
    const backend = getEffectiveBackend();
    if (backend === 'webgpu') {
        try {
            const model = await window.WebGPUAdapter.upscale(tempImg, canvas);
            return { backend: 'webgpu', model };
        } catch (err) {
            runtimeLog('webgpu:fallback-to-webgl', { error: String(err) });
        }
    }

    const model = await window.WebGLAdapter.upscale(tempImg, canvas);
    return { backend: 'webgl', model };
}

async function prewarmSelectedBackend() {
    const backend = getEffectiveBackend();
    if (backend === 'off') return;
    if (backend === 'webgpu') {
        if (window.WebGPUAdapter?.prewarm) {
            await window.WebGPUAdapter.prewarm();
        }
        return;
    }
    if (window.WebGLAdapter?.prewarm) {
        await window.WebGLAdapter.prewarm();
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
