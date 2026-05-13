// WebGPU adapter using anime4k-webgpu library

let webgpuDevicePromise = null;
let webgpuRenderPipeline = null;
let webgpuRenderPipelineFormat = null;
let webgpuRenderBindGroupLayout = null;
let webgpuSampler = null;

function getWebGpuLibrary() {
    const lib = window['anime4k-webgpu'];
    return lib && typeof lib === 'object' ? lib : null;
}

function getWebGpuPresetCtor(lib, runtimeSettings = getRuntimePreferenceSnapshot()) {
    const settings = getNormalizedRuntimePreferenceSnapshot(runtimeSettings);
    const explicitCtor = lib[settings.selectedWebGpuModel];
    if (typeof explicitCtor === 'function') {
        return explicitCtor;
    }

    const presetByLevel = {
        S: [lib.ModeC, lib.ModeB, lib.ModeA],
        M: [lib.ModeB, lib.ModeA, lib.ModeC],
        L: [lib.ModeA, lib.ModeAA, lib.ModeB],
        VL: [lib.ModeAA, lib.ModeA, lib.ModeCA],
        UL: [lib.ModeCA, lib.ModeAA, lib.ModeA]
    };

    const ordered = presetByLevel[settings.selectedSimplePreset] || [lib.ModeA, lib.ModeB, lib.ModeC];
    for (const ctor of ordered) {
        if (typeof ctor === 'function') return ctor;
    }

    const fallback = [lib.ModeA, lib.ModeAA, lib.ModeB, lib.ModeBB, lib.ModeC, lib.ModeCA];
    for (const ctor of fallback) {
        if (typeof ctor === 'function') return ctor;
    }

    return null;
}

async function getWebGpuDevice() {
    if (webgpuDevicePromise) return webgpuDevicePromise;

    webgpuDevicePromise = (async () => {
        if (!navigator?.gpu) {
            throw new Error('WebGPU API unavailable in this browser context');
        }
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
            throw new Error('No WebGPU adapter available');
        }

        const requiredLimits = {};
        const adapterLimits = adapter.limits;
        const defaultMaxBufferSize = 268435456;
        const defaultMaxStorageBufferBindingSize = 134217728;

        if (adapterLimits) {
            if (
                typeof adapterLimits.maxBufferSize === 'number' &&
                Number.isFinite(adapterLimits.maxBufferSize) &&
                adapterLimits.maxBufferSize > defaultMaxBufferSize
            ) {
                requiredLimits.maxBufferSize = adapterLimits.maxBufferSize;
            }
            if (
                typeof adapterLimits.maxStorageBufferBindingSize === 'number' &&
                Number.isFinite(adapterLimits.maxStorageBufferBindingSize) &&
                adapterLimits.maxStorageBufferBindingSize > defaultMaxStorageBufferBindingSize
            ) {
                requiredLimits.maxStorageBufferBindingSize = adapterLimits.maxStorageBufferBindingSize;
            }
        }

        try {
            if (Object.keys(requiredLimits).length > 0) {
                return await adapter.requestDevice({ requiredLimits });
            }
            return await adapter.requestDevice();
        } catch {
            return adapter.requestDevice();
        }
    })();

    try {
        return await webgpuDevicePromise;
    } catch (err) {
        webgpuDevicePromise = null;
        throw err;
    }
}

function resetWebGpuAdapterState() {
    webgpuDevicePromise = null;
    webgpuRenderPipeline = null;
    webgpuRenderPipelineFormat = null;
    webgpuRenderBindGroupLayout = null;
    webgpuSampler = null;
}

function getWebGpuRenderShaderModules(device) {
    if (!webgpuRenderBindGroupLayout) {
        webgpuRenderBindGroupLayout = device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} }
            ]
        });
    }

    if (!webgpuSampler) {
        webgpuSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    }

    return {
        bindGroupLayout: webgpuRenderBindGroupLayout,
        sampler: webgpuSampler,
        vertexModule: device.createShaderModule({
            code: `
@vertex
fn main(@builtin(vertex_index) vertexIndex : u32) -> @builtin(position) vec4<f32> {
    var positions = array<vec2<f32>, 6>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(1.0, -1.0),
        vec2<f32>(-1.0, 1.0),
        vec2<f32>(-1.0, 1.0),
        vec2<f32>(1.0, -1.0),
        vec2<f32>(1.0, 1.0)
    );
    let p = positions[vertexIndex];
    return vec4<f32>(p, 0.0, 1.0);
}
`
        }),
        fragmentModule: device.createShaderModule({
            code: `
@group(0) @binding(0) var linearSampler : sampler;
@group(0) @binding(1) var sourceTex : texture_2d<f32>;

@fragment
fn main(@builtin(position) pos : vec4<f32>) -> @location(0) vec4<f32> {
    let dims = vec2<f32>(textureDimensions(sourceTex, 0));
    let uv = pos.xy / dims;
    return textureSample(sourceTex, linearSampler, uv);
}
`
        })
    };
}

function getOrCreateWebGpuRenderPipeline(device, format) {
    if (webgpuRenderPipeline && webgpuRenderPipelineFormat === format) {
        return webgpuRenderPipeline;
    }

    const shader = getWebGpuRenderShaderModules(device);
    const layout = device.createPipelineLayout({ bindGroupLayouts: [shader.bindGroupLayout] });

    webgpuRenderPipeline = device.createRenderPipeline({
        layout,
        vertex: { module: shader.vertexModule, entryPoint: 'main' },
        fragment: { module: shader.fragmentModule, entryPoint: 'main', targets: [{ format }] },
        primitive: { topology: 'triangle-list' }
    });
    webgpuRenderPipelineFormat = format;
    return webgpuRenderPipeline;
}

async function runAnime4KWebGpu(tempImg, canvas, runtimeSettings = getRuntimePreferenceSnapshot()) {
    const settings = getNormalizedRuntimePreferenceSnapshot(runtimeSettings);
    const lib = getWebGpuLibrary();
    if (!lib) {
        throw new Error('anime4k-webgpu runtime is not loaded on window');
    }

    const device = await getWebGpuDevice();
    const nativeWidth = tempImg.naturalWidth || tempImg.width;
    const nativeHeight = tempImg.naturalHeight || tempImg.height;
    if (!nativeWidth || !nativeHeight) {
        throw new Error('Invalid source image dimensions for WebGPU');
    }

    const context = canvas.getContext('webgpu');
    if (!context) {
        throw new Error('Failed to acquire WebGPU canvas context');
    }

    const requestedScale = settings.selectedWebGpuModel === 'GANx4UUL' ? 4 : settings.selectedWebGpuModel === 'GANx3L' ? 3 : 2;
    const targetWidth = nativeWidth * requestedScale;
    const targetHeight = nativeHeight * requestedScale;

    const inputTexture = device.createTexture({
        size: [nativeWidth, nativeHeight, 1],
        format: 'rgba16float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.STORAGE_BINDING
    });

    device.queue.copyExternalImageToTexture(
        { source: tempImg },
        { texture: inputTexture },
        [nativeWidth, nativeHeight]
    );

    const encoder = device.createCommandEncoder();
    let outputTexture = null;
    let modelUsed = settings.selectedWebGpuModel;

    if (typeof lib.Anime4K === 'function') {
        const anime = new lib.Anime4K(device, inputTexture);
        modelUsed = 'Anime4K';
        outputTexture = device.createTexture({
            size: [targetWidth, targetHeight, 1],
            format: 'rgba16float',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.STORAGE_BINDING
        });
        anime.render(outputTexture, encoder);
    } else {
        const presetCtor = getWebGpuPresetCtor(lib, settings);
        if (!presetCtor) {
            throw new Error('No compatible anime4k-webgpu preset class is exported');
        }
        modelUsed = presetCtor.name || settings.selectedWebGpuModel;
        const pipeline = new presetCtor({
            device,
            inputTexture,
            nativeDimensions: { width: nativeWidth, height: nativeHeight },
            targetDimensions: { width: targetWidth, height: targetHeight }
        });

        if (typeof pipeline.pass !== 'function' || typeof pipeline.getOutputTexture !== 'function') {
            throw new Error('Invalid anime4k-webgpu pipeline interface');
        }

        pipeline.pass(encoder);
        outputTexture = pipeline.getOutputTexture();
    }

    if (!outputTexture) {
        throw new Error('anime4k-webgpu did not produce an output texture');
    }

    canvas.width = outputTexture.width;
    canvas.height = outputTexture.height;

    const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format: canvasFormat, alphaMode: 'premultiplied' });

    const renderPipeline = getOrCreateWebGpuRenderPipeline(device, canvasFormat);
    const shader = getWebGpuRenderShaderModules(device);
    const bindGroup = device.createBindGroup({
        layout: shader.bindGroupLayout,
        entries: [
            { binding: 0, resource: shader.sampler },
            { binding: 1, resource: outputTexture.createView() }
        ]
    });

    const pass = encoder.beginRenderPass({
        colorAttachments: [{
            view: context.getCurrentTexture().createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: 'clear',
            storeOp: 'store'
        }]
    });
    pass.setPipeline(renderPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(6);
    pass.end();

    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();

    return modelUsed;
}

// Adapter pattern: WebGPU adapter
window.WebGPUAdapter = {
    isSupported: () => {
        if (!navigator?.gpu) return false;
        const lib = getWebGpuLibrary();
        if (!lib) return false;
        return (
            typeof lib.Anime4K === 'function' ||
            typeof lib.ModeA === 'function' ||
            typeof lib.ModeAA === 'function' ||
            typeof lib.ModeB === 'function' ||
            typeof lib.ModeBB === 'function' ||
            typeof lib.ModeC === 'function' ||
            typeof lib.ModeCA === 'function'
        );
    },
    upscale: runAnime4KWebGpu,
    prewarm: async () => {
        await getWebGpuDevice();
    },
    reset: resetWebGpuAdapterState
};
