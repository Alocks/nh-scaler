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
const DEFAULT_SIMPLE_PRESET = 'M';
const SIMPLE_PRESET_VALUES = new Set(['S', 'M', 'L', 'UL', 'VL']);

let selectedSimplePreset = DEFAULT_SIMPLE_PRESET;
let presetReadyPromise = Promise.resolve();

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

presetReadyPromise = loadSimplePresetPreference();

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

async function getScaler() {
    if (scaler) return scaler;
    if (scalerPromise) return scalerPromise;

    scalerPromise = (async () => {
        await presetReadyPromise;

        const lib = window.Anime4KJS || window.Anime4K;
        if (!lib) {
            throw new Error('Anime4KJS not found on window');
        }

        const preset = getRestoreUpscalePreset(lib);
        log('scaler:init', {
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
    if (backgroundProcessing || backgroundQueue.length === 0) return;
    
    backgroundProcessing = true;
    
    while (backgroundQueue.length > 0) {
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
            const engine = await getScaler();

            if (!engine.supported) {
                throw new Error('Anime4KJS WebGL pipeline not supported');
            }

            // Create a temporary canvas for background processing
            const bgCanvas = document.createElement('canvas');
            const t3 = performance.now();
            engine.attachSource(tempImg, bgCanvas);
            engine.upscale();
            engine.detachSource();
            const t4 = performance.now();
            log('bg-process:upscale-time', { sourceUrl, page, duration: (t4 - t3).toFixed(2) + 'ms' });

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
    const img = container.querySelector('img');
    if (!img) return;

    const sourceUrl = img.currentSrc || img.src;
    if (!sourceUrl) return;

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
        const [engine, tempImg] = await Promise.all([
            getScaler(),
            loadImageForWebGL(sourceUrl)
        ]);
        const t2 = performance.now();
        //log('process:load-time', { sourceUrl, page, duration: (t2 - t1).toFixed(2) + 'ms' });

        const latestSrc = img.currentSrc || img.src;
        if (img.dataset.aiJobId !== jobId || latestSrc !== sourceUrl) {
            log('process:abort-stale', { sourceUrl, latestSrc, jobId, activeJobId: img.dataset.aiJobId });
            delete img.dataset.aiProcessingSrc;
            return;
        }

        if (!engine.supported) {
            throw new Error('Anime4KJS WebGL pipeline not supported');
        }

        const t3 = performance.now();
        engine.attachSource(tempImg, canvas);
        engine.upscale();
        engine.detachSource();
        const t4 = performance.now();
        log('process:upscale-time', { sourceUrl, page, duration: (t4 - t3).toFixed(2) + 'ms' });

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

if (chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'sync' || !changes[SIMPLE_PRESET_KEY]) return;

        const nextPreset = normalizeSimplePreset(changes[SIMPLE_PRESET_KEY].newValue);
        if (nextPreset === selectedSimplePreset) return;

        selectedSimplePreset = nextPreset;
        scaler = null;
        scalerPromise = null;
        processedCache.clear();
        processedPageKeys.clear();
        inFlightPageKeys.clear();
        backgroundQueue = [];

        log('preset:changed', { selectedSimplePreset });
        scheduleProcess('preset-changed');
    });
}

// Pre-initialize the scaler on script load for faster first-image processing
getScaler().catch(err => {
    log('scaler:preinit-failed', { error: String(err) });
});

// Periodic safety pass for style flips and SPA container swaps, and background image processing
setInterval(() => {
    attachContainerObserver();
    scheduleProcess('interval');
    // Fallback scan in case images were loaded in a way we didn't catch
    findAndProcessBackgroundImages();
    scanPerformanceResources();
}, SAFETY_INTERVAL_MS);

attachContainerObserver();
scheduleProcess('initial');
scanPerformanceResources();
