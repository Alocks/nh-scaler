// @ts-nocheck
const DEBUG = true;
const SAFETY_INTERVAL_MS = 1000;

if (!document.querySelector('style[data-ai-scaler]')) {
    const style = document.createElement('style');
    style.setAttribute('data-ai-scaler', 'true');
    style.textContent = `
        #image-container {
            overflow: hidden;
        }

        .ai-canvas {
            max-width: 100%;
            max-height: 100%;
            width: auto;
            height: auto;
            display: block;
            margin: auto;
        }
    `;
    document.head.appendChild(style);
}

/** @type {any} */
let scaler = null;
/** @type {Promise<any> | null} */
let scalerPromise = null;
let jobCounter = 0;

// Cache for processed images: Map<sourceUrl, canvas imageData blob>
const processedCache = new Map();
// Dedup set by gallery+page key (e.g. "3928680/4") to block CDN subdomain duplicates
const processedPageKeys = new Set();
// Keys currently being upscaled in-flight (popped from queue, not yet finished)
const inFlightPageKeys = new Set();
// Track background processing queue to process sequentially
let backgroundQueue = [];
let backgroundProcessing = false;
const seenPerformanceResourceUrls = new Set();

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

let webgpuDevicePromise = null;
let webgpuRenderPipeline = null;
let webgpuRenderPipelineFormat = null;
let webgpuRenderBindGroupLayout = null;
let webgpuSampler = null;

function isNhentaiGalleryUrl(url) {
    if (typeof url !== 'string') return false;
    // Only match URLs ending with /digits.webp (optionally with query/hash)
    // Example: https://i3.nhentai.net/galleries/3927153/6.webp
    return /\/\d+\.webp([?#].*)?$/.test(url);
}

// Returns a stable dedup key like "3928680/4" regardless of CDN subdomain (i1/i2/i3)
function getGalleryPageKey(url) {
    if (typeof url !== 'string') return null;
    const match = url.match(/\/galleries\/(\d+)\/(\d+)\.webp/);
    if (!match) return null;
    return `${match[1]}/${match[2]}`;
}

function getPageNumberFromUrl(url) {
    if (typeof url !== 'string') return null;
    const match = url.match(/\/(\d+)\.webp(?:[?#].*)?$/);
    if (!match) return null;
    const page = Number(match[1]);
    return Number.isFinite(page) ? page : null;
}

function isForegroundTab() {
    return document.visibilityState === 'visible' && !document.hidden;
}

function getNextBackgroundQueueIndex() {
    if (backgroundQueue.length === 0) return -1;

    let bestIndex = 0;
    let bestPage = getPageNumberFromUrl(backgroundQueue[0]);
    let bestRank = bestPage == null ? Number.POSITIVE_INFINITY : bestPage;

    for (let i = 1; i < backgroundQueue.length; i++) {
        const page = getPageNumberFromUrl(backgroundQueue[i]);
        const rank = page == null ? Number.POSITIVE_INFINITY : page;
        if (rank < bestRank) {
            bestRank = rank;
            bestIndex = i;
            bestPage = page;
        }
    }

    return bestIndex;
}

function queueBackgroundIfEligible(url, source) {
    if (!backendPreferenceLoaded) return;
    if (getEffectiveBackend() === 'off') return;
    if (!isForegroundTab()) return;
    if (!isNhentaiGalleryUrl(url)) return;

    const activeImg = getActiveContainer()?.querySelector('img');
    const activeUrl = activeImg?.currentSrc || activeImg?.src;
    if (url === activeUrl) return;
    // Deduplicate by gallery+page key to avoid re-processing the same image from different CDN subdomains
    const key = getGalleryPageKey(url);
    if (key && (processedPageKeys.has(key) || inFlightPageKeys.has(key))) return;
    if (key && backgroundQueue.some(u => getGalleryPageKey(u) === key)) return;
    if (processedCache.has(url) || backgroundQueue.includes(url)) return;
    //log('bg-detect', { source, url });
    preprocessBackgroundImage(url);
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

function loadSimplePresetPreference() {
    if (!chrome?.storage?.sync) {
        return Promise.resolve();
    }

    return new Promise((resolve) => {
        chrome.storage.sync.get({ [SIMPLE_PRESET_KEY]: DEFAULT_SIMPLE_PRESET }, (result) => {
            selectedSimplePreset = normalizeSimplePreset(result?.[SIMPLE_PRESET_KEY]);
            log('preset:loaded', { selectedSimplePreset });
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
            log('backend:loaded', { selectedEngineBackend });
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
            log('webgpu-model:loaded', { selectedWebGpuModel });
            resolve();
        });
    });
}

presetReadyPromise = loadSimplePresetPreference();
backendReadyPromise = loadEngineBackendPreference();
webgpuModelReadyPromise = loadWebGpuModelPreference();

function log(label, data = {}) {
    if (!DEBUG) return;
    console.log('[NH Scaler]', label, { ts: new Date().toISOString(), ...data });
}

function hideOriginal(img) {
    img.style.setProperty('display', 'none', 'important');
    img.style.setProperty('visibility', 'hidden', 'important');
}

function showOriginal(img) {
    img.style.removeProperty('display');
    img.style.removeProperty('visibility');
}

function disableUpscalingForContainer(container, sourceUrl) {
    const img = container.querySelector('img');
    if (img) {
        showOriginal(img);
        img.dataset.aiProcessed = 'false';
        delete img.dataset.aiProcessingSrc;
    }

    const canvas = container.querySelector('.ai-canvas');
    if (canvas) {
        canvas.style.display = 'none';
        canvas.style.visibility = 'hidden';
        if (sourceUrl) {
            canvas.dataset.aiSourceUrl = sourceUrl;
        }
    }
}

function ensureCanvas(parent) {
    let canvas = parent.querySelector('.ai-canvas');
    if (!canvas) {
        canvas = document.createElement('canvas');
        // Keep zero-size/hidden until we have a rendered frame to avoid transient scrollbars.
        canvas.width = 0;
        canvas.height = 0;
        // Copy layout classes from parent container to canvas
        if (parent.className) {
            canvas.className = parent.className + ' ai-canvas';
        } else {
            canvas.className = 'ai-canvas';
        }
        canvas.style.pointerEvents = 'none';
        canvas.style.display = 'none';
        canvas.style.visibility = 'hidden';
        parent.appendChild(canvas);
        //log('canvas:create', { parentClasses: parent.className });
    }

    return canvas;
}

function getRestoreUpscalePreset(lib) {
    const preferredSimple = {
        S: lib.ANIME4KJS_SIMPLE_S_2X,
        M: lib.ANIME4KJS_SIMPLE_M_2X,
        L: lib.ANIME4KJS_SIMPLE_L_2X,
        VL: lib.ANIME4KJS_SIMPLE_VL_2X,
        UL: lib.ANIME4KJS_SIMPLE_UL_2X
    };

    if (preferredSimple[selectedSimplePreset]) {
        return preferredSimple[selectedSimplePreset];
    }

    const fallbackOrder = ['M', 'L', 'S', 'UL', 'VL'];
    for (const key of fallbackOrder) {
        if (preferredSimple[key]) return preferredSimple[key];
    }

    return lib.ANIME4KJS_EMPTY || [];
}

function getWebGpuLibrary() {
    const lib = window['anime4k-webgpu'];
    return lib && typeof lib === 'object' ? lib : null;
}

function supportsWebGpuBackend() {
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
}

function getEffectiveBackend() {
    if (selectedEngineBackend === 'off') {
        return 'off';
    }
    if (selectedEngineBackend === 'webgpu' && supportsWebGpuBackend()) {
        return 'webgpu';
    }
    return 'webgl';
}

function getWebGpuPresetCtor(lib) {
    const explicitCtor = lib[selectedWebGpuModel];
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

    const ordered = presetByLevel[selectedSimplePreset] || [lib.ModeA, lib.ModeB, lib.ModeC];
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

        const defaultMaxBufferSize = 268435456; // 256 MiB default in many WebGPU implementations
        const defaultMaxStorageBufferBindingSize = 134217728; // 128 MiB common default

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
        } catch (err) {
            // If explicit limits fail on some drivers, retry with default request.
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
        webgpuSampler = device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear'
        });
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
        vertex: {
            module: shader.vertexModule,
            entryPoint: 'main'
        },
        fragment: {
            module: shader.fragmentModule,
            entryPoint: 'main',
            targets: [{ format }]
        },
        primitive: {
            topology: 'triangle-list'
        }
    });
    webgpuRenderPipelineFormat = format;
    return webgpuRenderPipeline;
}

async function runAnime4KWebGpu(tempImg, canvas) {
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

    const requestedScale = selectedWebGpuModel === 'GANx4UUL' ? 4 : selectedWebGpuModel === 'GANx3L' ? 3 : 2;
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
    let modelUsed = selectedWebGpuModel;

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
        const presetCtor = getWebGpuPresetCtor(lib);
        if (!presetCtor) {
            throw new Error('No compatible anime4k-webgpu preset class is exported');
        }
        modelUsed = presetCtor.name || selectedWebGpuModel;
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
    context.configure({
        device,
        format: canvasFormat,
        alphaMode: 'premultiplied'
    });

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

async function runAnime4KWebGl(tempImg, canvas) {
    const engine = await getScaler();
    if (!engine.supported) {
        throw new Error('Anime4KJS WebGL pipeline not supported');
    }
    engine.attachSource(tempImg, canvas);
    engine.upscale();
    engine.detachSource();

    return `SIMPLE_${selectedSimplePreset}`;
}

async function upscaleWithSelectedBackend(tempImg, canvas) {
    const backend = getEffectiveBackend();
    if (backend === 'webgpu') {
        try {
            const model = await runAnime4KWebGpu(tempImg, canvas);
            return { backend: 'webgpu', model };
        } catch (err) {
            log('webgpu:fallback-to-webgl', { error: String(err) });
        }
    }

    const model = await runAnime4KWebGl(tempImg, canvas);
    return { backend: 'webgl', model };
}

async function getScaler() {
    if (scaler) return scaler;
    if (scalerPromise) return scalerPromise;

    scalerPromise = (async () => {
        await Promise.all([presetReadyPromise, backendReadyPromise]);

        const lib = window.Anime4KJS || window.Anime4K;
        if (!lib) {
            throw new Error('Anime4KJS WebGL runtime not found on window');
        }

        const preset = getRestoreUpscalePreset(lib);
        log('scaler:init', {
            backend: 'webgl',
            hasImageUpscaler: typeof lib.ImageUpscaler === 'function',
            presetLength: Array.isArray(preset) ? preset.length : null,
            selectedSimplePreset
        });

        const instance = new lib.ImageUpscaler(preset);
        
        // Log WebGL capabilities
        if (instance && instance.supported !== undefined) {
            log('scaler:webgl-supported', { supported: instance.supported });
        }
        
        // Check if WebGL context exists
        if (instance && instance.renderer) {
            log('scaler:renderer-info', { 
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

function hasRenderedCanvasForSource(img, canvas, sourceUrl) {
    return (
        !!canvas &&
        canvas.dataset.aiSourceUrl === sourceUrl &&
        canvas.width > 0 &&
        canvas.height > 0 &&
        img.dataset.aiProcessedSrc === sourceUrl
    );
}

function reconcile(container) {
    const img = container.querySelector('img');
    if (!img) return;

    const sourceUrl = img.currentSrc || img.src;
    if (!sourceUrl) return;

    const parent = img.parentElement;
    if (!parent) return;

    if (getEffectiveBackend() === 'off') {
        disableUpscalingForContainer(container, sourceUrl);
        return;
    }

    const canvas = parent.querySelector('.ai-canvas');
    if (hasRenderedCanvasForSource(img, canvas, sourceUrl)) {
        canvas.style.display = 'block';
        canvas.style.visibility = 'visible';
        hideOriginal(img);
    }
}

function loadImageForWebGL(sourceUrl) {
    return new Promise((resolve, reject) => {
        const tempImg = new Image();
        tempImg.crossOrigin = 'anonymous';
        tempImg.onload = () => resolve(tempImg);
        tempImg.onerror = reject;
        tempImg.src = sourceUrl;
    });
}

// Intercept fetch requests to detect image loads
const originalFetch = window.fetch;
window.fetch = function(...args) {
    const url = args[0];
    const urlString = typeof url === 'string' ? url : url?.url;

    queueBackgroundIfEligible(urlString, 'fetch');
    
    return originalFetch.apply(this, args);
};

// Also hook into Image.onload to detect when images are actually loaded
const originalImageProto = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
if (originalImageProto) {
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
        set(value) {
            queueBackgroundIfEligible(value, 'image-src');
            originalImageProto.set.call(this, value);
        },
        get() {
            return originalImageProto.get.call(this);
        },
        configurable: true
    });
}

// Hook Image constructor to catch all new images created by JS
const OriginalImage = window.Image;
function ProxyImage(...args) {
    const img = new OriginalImage(...args);
    // Proxy the src property for this instance
    const srcDescriptor = Object.getOwnPropertyDescriptor(img, 'src') || Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    if (srcDescriptor && srcDescriptor.configurable) {
        Object.defineProperty(img, 'src', {
            set(value) {
                queueBackgroundIfEligible(value, 'image-constructor');
                srcDescriptor.set.call(this, value);
            },
            get() {
                return srcDescriptor.get.call(this);
            },
            configurable: true
        });
    }
    return img;
}
ProxyImage.prototype = OriginalImage.prototype;
window.Image = ProxyImage;

async function preprocessBackgroundImage(sourceUrl) {
    if (!isForegroundTab()) return;

    // Skip if already cached or processing
    if (processedCache.has(sourceUrl)) {
        log('bg-process:skip-cached', { sourceUrl });
        return;
    }

    if (backgroundQueue.includes(sourceUrl)) {
        return;
    }
    
    // Skip if currently being processed in foreground
    const activeImg = getActiveContainer()?.querySelector('img');
    const activeUrl = activeImg?.currentSrc || activeImg?.src;
    if (sourceUrl === activeUrl) {
        log('bg-process:skip-foreground', { sourceUrl });
        return;
    }
    
    // Add to queue instead of processing immediately
    if (!backgroundQueue.includes(sourceUrl)) {
        backgroundQueue.push(sourceUrl);
        //log('bg-process:queued', { sourceUrl, queueSize: backgroundQueue.length });
    }
    
    // Start processing queue if not already running
    if (!backgroundProcessing) {
        processBackgroundQueue();
    }
}

async function processBackgroundQueue() {
    if (!isForegroundTab()) return;

    await Promise.all([backendReadyPromise, webgpuModelReadyPromise]);

    if (backgroundProcessing || backgroundQueue.length === 0) return;

    if (getEffectiveBackend() === 'off') {
        backgroundQueue = [];
        return;
    }
    
    backgroundProcessing = true;
    
    while (backgroundQueue.length > 0) {
        if (!isForegroundTab()) break;

        const nextIndex = getNextBackgroundQueueIndex();
        if (nextIndex < 0) break;
        const [sourceUrl] = backgroundQueue.splice(nextIndex, 1);
        
        if (processedCache.has(sourceUrl)) {
            continue;
        }
        
        // Skip if this image is now the active foreground image
        const activeImg = getActiveContainer()?.querySelector('img');
        const activeUrl = activeImg?.currentSrc || activeImg?.src;
        if (sourceUrl === activeUrl) {
            log('bg-process:skip-now-foreground', { sourceUrl });
            continue;
        }
        
        const page = getPageNumberFromUrl(sourceUrl);
        const pageKey = getGalleryPageKey(sourceUrl);
        if (pageKey) inFlightPageKeys.add(pageKey);
        //log('bg-process:start', { sourceUrl, page, queueSize: backgroundQueue.length });
        
        try {
            // Check if image is actually loadable
            const tempImg = await loadImageForWebGL(sourceUrl);

            // Create a temporary canvas for background processing
            const bgCanvas = document.createElement('canvas');
            const t3 = performance.now();
            const runInfo = await upscaleWithSelectedBackend(tempImg, bgCanvas);
            const t4 = performance.now();
            log('bg-process:upscale-time', {
                sourceUrl,
                page,
                duration: (t4 - t3).toFixed(2) + 'ms',
                backend: runInfo.backend,
                model: runInfo.model
            });

            // Mark this gallery+page as done so CDN subdomain variants are not re-processed
            if (pageKey) processedPageKeys.add(pageKey);

            if (bgCanvas.width <= 0 || bgCanvas.height <= 0) {
                throw new Error('Canvas output is empty after upscale');
            }

            // Cache the result
            bgCanvas.toBlob((blob) => {
                if (blob) {
                    processedCache.set(sourceUrl, blob);
                    //log('bg-process:cached', { sourceUrl });
                }
            });

            //log('bg-process:success', { sourceUrl, page, width: bgCanvas.width, height: bgCanvas.height });
        } catch (err) {
            log('bg-process:error', { sourceUrl, page, error: String(err) });
        } finally {
            if (pageKey) inFlightPageKeys.delete(pageKey);
        }
        
        // Minimal delay between processing to avoid blocking
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    
    backgroundProcessing = false;
}

function findAndProcessBackgroundImages() {
    if (!isForegroundTab()) return;

    // Look for images that might be preloaded in the page but not in active container
    const allImages = Array.from(document.querySelectorAll('img[src], img[data-src]'));
    const activeContainer = getActiveContainer();
    const activeImg = activeContainer?.querySelector('img');
    const activeUrl = activeImg?.currentSrc || activeImg?.src;

    let found = 0;
    for (const img of allImages) {
        const srcUrl = img.currentSrc || img.src || img.dataset.src;
        if (!srcUrl || srcUrl === activeUrl) continue;
        
        if (isNhentaiGalleryUrl(srcUrl)) {
            queueBackgroundIfEligible(srcUrl, 'scan');
            found++;

            // Process max 3 at a time to avoid overwhelming the queue
            if (found >= 3) break;
        }
    }
    
    if (found > 0) {
        log('bg-process:found', { count: found, queueSize: backgroundQueue.length });
    }
}

function scanPerformanceResources() {
    if (!performance?.getEntriesByType) return;

    const resources = performance.getEntriesByType('resource');
    for (const entry of resources) {
        const url = entry?.name;
        if (typeof url !== 'string' || !url) continue;
        if (seenPerformanceResourceUrls.has(url)) continue;
        seenPerformanceResourceUrls.add(url);

        // Reader preloading often uses new Image() from page-world script.
        // Performance resource entries let us discover those URLs from content script world.
        if (isNhentaiGalleryUrl(url)) {
            queueBackgroundIfEligible(url, `perf:${entry.initiatorType || 'unknown'}`);
        }
    }
}

async function processCurrentImage(container) {
    if (!isForegroundTab()) return;

    await Promise.all([backendReadyPromise, webgpuModelReadyPromise]);

    const img = container.querySelector('img');
    if (!img) return;

    const sourceUrl = img.currentSrc || img.src;
    if (!sourceUrl) return;

    if (getEffectiveBackend() === 'off') {
        disableUpscalingForContainer(container, sourceUrl);
        return;
    }

    const parent = img.parentElement;
    if (!parent) return;

    const existingCanvas = parent.querySelector('.ai-canvas');
    
    // Check if canvas has stale data from a different image
    if (existingCanvas && existingCanvas.dataset.aiSourceUrl && existingCanvas.dataset.aiSourceUrl !== sourceUrl) {
        //log('process:remove-stale-canvas', { oldUrl: existingCanvas.dataset.aiSourceUrl, newUrl: sourceUrl });
        // Remove stale canvas entirely so a fresh one is created
        existingCanvas.remove();
    }
    
    const currentCanvas = parent.querySelector('.ai-canvas');
    if (hasRenderedCanvasForSource(img, currentCanvas, sourceUrl)) {
        hideOriginal(img);
        currentCanvas.style.display = 'block';
        currentCanvas.style.visibility = 'visible';
        return;
    }

    // Check cache first
    if (processedCache.has(sourceUrl)) {
        let canvas = ensureCanvas(parent);
        const cachedBlob = processedCache.get(sourceUrl);
        
        try {
            const bitmap = await createImageBitmap(cachedBlob);
            const ctx = canvas.getContext('2d');
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            ctx.drawImage(bitmap, 0, 0);
            
            img.dataset.aiProcessed = 'true';
            img.dataset.aiProcessedSrc = sourceUrl;
            canvas.dataset.aiSourceUrl = sourceUrl;
            hideOriginal(img);
            canvas.style.display = 'block';
            canvas.style.visibility = 'visible';
            //log('process:cache-hit', { sourceUrl, width: canvas.width, height: canvas.height });
            return;
        } catch (err) {
            log('process:cache-restore-failed', { sourceUrl, error: String(err) });
            processedCache.delete(sourceUrl);
        }
    }

    if (img.dataset.aiProcessingSrc === sourceUrl) return;

    const jobId = String(++jobCounter);
    img.dataset.aiJobId = jobId;
    img.dataset.aiProcessingSrc = sourceUrl;
    img.dataset.aiProcessed = 'true';
    const startTime = performance.now();
    const page = getPageNumberFromUrl(sourceUrl);
    //log('process:start', { sourceUrl, page, jobId });

    let canvas = ensureCanvas(parent);

    try {
        const t1 = performance.now();
        const tempImg = await loadImageForWebGL(sourceUrl);
        const t2 = performance.now();
        //log('process:load-time', { sourceUrl, page, duration: (t2 - t1).toFixed(2) + 'ms' });

        const latestSrc = img.currentSrc || img.src;
        if (img.dataset.aiJobId !== jobId || latestSrc !== sourceUrl) {
            log('process:abort-stale', { sourceUrl, latestSrc, jobId, activeJobId: img.dataset.aiJobId });
            delete img.dataset.aiProcessingSrc;
            return;
        }

        const t3 = performance.now();
        const runInfo = await upscaleWithSelectedBackend(tempImg, canvas);
        const t4 = performance.now();
        log('process:upscale-time', {
            sourceUrl,
            page,
            duration: (t4 - t3).toFixed(2) + 'ms',
            backend: runInfo.backend,
            model: runInfo.model,
        });

        // Some builds hide canvas inside detachSource.
        canvas.style.visibility = 'visible';
        canvas.style.display = 'block';

        if (canvas.width <= 0 || canvas.height <= 0) {
            throw new Error('Canvas output is empty after upscale');
        }

        // Cache the result for future use
        canvas.toBlob((blob) => {
            if (blob) {
                processedCache.set(sourceUrl, blob);
                //log('process:cached', { sourceUrl });
            }
        });

        img.dataset.aiProcessed = 'true';
        img.dataset.aiProcessedSrc = sourceUrl;
        canvas.dataset.aiSourceUrl = sourceUrl;
        delete img.dataset.aiProcessingSrc;
        hideOriginal(img);
        reconcile(container);
        const endTime = performance.now();
        //log('process:success', { sourceUrl, page, jobId, width: canvas.width, height: canvas.height, totalTime: (endTime - startTime).toFixed(2) + 'ms' });
    } catch (err) {
        img.dataset.aiProcessed = 'false';
        delete img.dataset.aiProcessingSrc;
        showOriginal(img);
        log('process:error', { sourceUrl, page, jobId, error: String(err) });
        console.error('Anime4K processing failed:', err);
    }
}

function getActiveContainer() {
    return document.querySelector('#image-container');
}

function isAiCanvasNode(node) {
    return node instanceof HTMLCanvasElement && node.classList.contains('ai-canvas');
}

function isCanvasOnlyChildListMutation(mutation) {
    if (mutation.type !== 'childList') return false;

    const added = Array.from(mutation.addedNodes);
    if (added.length === 0) return false;

    return added.every((n) => isAiCanvasNode(n));
}

let observedContainer = null;
let containerObserver = null;
let scheduled = false;

const scheduleProcess = (reason) => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
        scheduled = false;
        const container = getActiveContainer();
        if (!container) {
            log('observer:run:waiting-for-container', { reason });
            return;
        }

        //log('observer:run', { reason });
        reconcile(container);
        processCurrentImage(container);
    });
};

function attachContainerObserver() {
    const container = getActiveContainer();
    if (!container) {
        if (containerObserver) {
            containerObserver.disconnect();
            containerObserver = null;
            observedContainer = null;
        }
        return;
    }

    if (container === observedContainer && containerObserver) return;

    if (containerObserver) containerObserver.disconnect();

    observedContainer = container;
    containerObserver = new MutationObserver((mutations) => {
        const effectiveMutations = mutations.filter((m) => !isCanvasOnlyChildListMutation(m));
        if (effectiveMutations.length === 0) return;

        let shouldProcess = false;
        let reason = 'unknown';

        for (const mutation of effectiveMutations) {
            if (mutation.type === 'childList') {
                const imgChange =
                    Array.from(mutation.addedNodes).some(
                        (n) => n instanceof HTMLImageElement || (n instanceof Element && !!n.querySelector('img'))
                    ) ||
                    Array.from(mutation.removedNodes).some(
                        (n) => n instanceof HTMLImageElement || (n instanceof Element && !!n.querySelector('img'))
                    );

                if (imgChange) {
                    shouldProcess = true;
                    reason = 'childList:img-change';
                    break;
                }
            }

            if (
                mutation.type === 'attributes' &&
                ['src', 'srcset', 'data-src', 'data-srcset'].includes(mutation.attributeName || '')
            ) {
                shouldProcess = true;
                reason = `attributes:${mutation.attributeName}`;
                break;
            }
        }

        if (shouldProcess) {
            //log('observer:batch', {
            //    count: effectiveMutations.length,
            //    reason,
            //    types: effectiveMutations.map((m) => m.type)
            //});
            scheduleProcess(reason);
            // Immediately scan for background images when container changes
            findAndProcessBackgroundImages();
        }
    });

    containerObserver.observe(container, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src', 'srcset', 'data-src', 'data-srcset']
    });

    log('observer:attached-container', {
        tag: container.tagName,
        className: container.className
    });
    scheduleProcess('container-attached');
    // Scan for background images immediately after attaching
    findAndProcessBackgroundImages();
}

const rootObserver = new MutationObserver((mutations) => {
    attachContainerObserver();
    scanPerformanceResources();
    
    // Watch for dynamically loaded images
    for (const mutation of mutations) {
        if (mutation.type === 'childList') {
            for (const node of mutation.addedNodes) {
                // Check if added node or its descendants are images
                if (node instanceof HTMLImageElement) {
                    const srcUrl = node.currentSrc || node.src;
                    queueBackgroundIfEligible(srcUrl, 'dom-image');
                } else if (node instanceof Element) {
                    const imgs = node.querySelectorAll('img[src], img[data-src]');
                    for (const img of imgs) {
                        const srcUrl = img.currentSrc || img.src || img.dataset.src;
                        queueBackgroundIfEligible(srcUrl, 'dom-scan');
                    }
                }
            }
        }
    }
});

rootObserver.observe(document.body, { childList: true, subtree: true });

document.addEventListener('visibilitychange', () => {
    if (!isForegroundTab()) {
        return;
    }

    attachContainerObserver();
    scheduleProcess('visibilitychange');
    findAndProcessBackgroundImages();
    scanPerformanceResources();
    processBackgroundQueue();
});

if (chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'sync') return;

        const hasPresetChange = !!changes[SIMPLE_PRESET_KEY];
        const hasBackendChange = !!changes[ENGINE_BACKEND_KEY];
        const hasWebGpuModelChange = !!changes[WEBGPU_MODEL_KEY];
        if (!hasPresetChange && !hasBackendChange && !hasWebGpuModelChange) return;

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

        if (!didChange) return;

        scaler = null;
        scalerPromise = null;
        processedCache.clear();
        processedPageKeys.clear();
        inFlightPageKeys.clear();
        backgroundQueue = [];

        // Reset processed-state on all tracked images so canvases are re-rendered with the new settings
        document.querySelectorAll('img[data-ai-processed-src]').forEach((img) => {
            delete img.dataset.aiProcessed;
            delete img.dataset.aiProcessedSrc;
            delete img.dataset.aiProcessingSrc;
            delete img.dataset.aiJobId;
        });
        document.querySelectorAll('.ai-canvas').forEach((canvas) => {
            canvas.remove();
        });
        // Clear seen-URL set so performance-discovered URLs are rediscovered and requeued
        seenPerformanceResourceUrls.clear();

        log('settings:changed', { selectedSimplePreset, selectedEngineBackend, selectedWebGpuModel });
        scheduleProcess('preset-changed');
        // Re-scan to requeue background images with the new settings
        findAndProcessBackgroundImages();
        scanPerformanceResources();
    });
}

// Pre-initialize the scaler on script load for faster first-image processing.
// Wait for backend preference so off-mode does not initialize or process on first load.
backendReadyPromise
    .then(() => {
        if (getEffectiveBackend() !== 'webgl') return;
        return getScaler();
    })
    .catch(err => {
        log('scaler:preinit-failed', { error: String(err) });
    });

// Periodic safety pass for style flips and SPA container swaps, and background image processing
setInterval(() => {
    if (!isForegroundTab()) return;

    attachContainerObserver();
    scheduleProcess('interval');
    // Fallback scan in case images were loaded in a way we didn't catch
    findAndProcessBackgroundImages();
    scanPerformanceResources();
}, SAFETY_INTERVAL_MS);

attachContainerObserver();
scheduleProcess('initial');
scanPerformanceResources();
