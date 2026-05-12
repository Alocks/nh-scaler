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
