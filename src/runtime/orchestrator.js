const SAFETY_INTERVAL_MS = 1000;

let jobCounter = 0;
const processedPageKeys = new Set();
const inFlightPageKeys = new Set();
let backgroundQueue = [];
let backgroundProcessing = false;
const seenPerformanceResourceUrls = new Set();

function log(label, data = {}) {
    if (typeof window.NHScalerLog === 'function') {
        window.NHScalerLog(label, data);
        return;
    }
    console.log('[NH Scaler]', label, { ts: new Date().toISOString(), ...data });
}

function isForegroundTab() {
    return document.visibilityState === 'visible' && !document.hidden;
}

function getActiveContainer() {
    return document.querySelector('#image-container');
}

function getQueueDebugData(sourceUrl) {
    return {
        sourceUrl,
        page: getPageNumberFromUrl(sourceUrl),
        pageKey: getGalleryPageKey(sourceUrl),
        queueSize: backgroundQueue.length,
        processedCount: processedPageKeys.size,
        inFlightCount: inFlightPageKeys.size,
    };
}

function logQueueEvent(label, sourceUrl, extra = {}) {
    log(label, {
        ...getQueueDebugData(sourceUrl),
        foreground: isForegroundTab(),
        backend: backendPreferenceLoaded ? getEffectiveBackend() : 'pending',
        ...extra,
    });
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

    if (!backendPreferenceLoaded) {
        logQueueEvent('bg-queue:skip', url, { source, reason: 'backend-pending' });
        return;
    }

    if (getEffectiveBackend() === 'off') {
        logQueueEvent('bg-queue:skip', url, { source, reason: 'backend-off' });
        return;
    }

    if (!isForegroundTab()) {
        logQueueEvent('bg-queue:skip', url, { source, reason: 'tab-hidden' });
        return;
    }

    const activeImg = getActiveContainer()?.querySelector('img');
    const activeUrl = activeImg?.currentSrc || activeImg?.src;
    if (url === activeUrl) {
        logQueueEvent('bg-queue:skip', url, { source, reason: 'active-image' });
        return;
    }
    const key = getGalleryPageKey(url);
    if (key && processedPageKeys.has(key)) {
        logQueueEvent('bg-queue:skip', url, { source, reason: 'page-already-processed' });
        return;
    }
    if (key && inFlightPageKeys.has(key)) {
        logQueueEvent('bg-queue:skip', url, { source, reason: 'page-in-flight' });
        return;
    }
    if (key && backgroundQueue.some(u => getGalleryPageKey(u) === key)) {
        logQueueEvent('bg-queue:skip', url, { source, reason: 'page-already-queued' });
        return;
    }
    if (hasProcessedCacheEntry(url)) {
        logQueueEvent('bg-queue:skip', url, { source, reason: 'memory-cache-hit' });
        return;
    }
    if (backgroundQueue.includes(url)) {
        logQueueEvent('bg-queue:skip', url, { source, reason: 'url-already-queued' });
        return;
    }

    logQueueEvent('bg-queue:candidate', url, { source });
    preprocessBackgroundImage(url);
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
        canvas.width = 0;
        canvas.height = 0;
        if (parent.className) {
            canvas.className = parent.className + ' ai-canvas';
        } else {
            canvas.className = 'ai-canvas';
        }
        canvas.style.pointerEvents = 'none';
        canvas.style.display = 'none';
        canvas.style.visibility = 'hidden';
        parent.appendChild(canvas);
    }

    return canvas;
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

function isStaleForegroundJob(img, jobId, sourceUrl, canvas, parent) {
    const latestSrc = img.currentSrc || img.src;
    return (
        img.dataset.aiJobId !== jobId ||
        latestSrc !== sourceUrl ||
        !canvas.isConnected ||
        canvas.parentElement !== parent
    );
}

const originalFetch = window.fetch;
window.fetch = function(...args) {
    const url = args[0];
    const urlString = typeof url === 'string' ? url : url?.url;

    queueBackgroundIfEligible(urlString, 'fetch');

    return originalFetch.apply(this, args);
};

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

const OriginalImage = window.Image;
function ProxyImage(...args) {
    const img = new OriginalImage(...args);
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
    if (!isForegroundTab()) {
        logQueueEvent('bg-queue:skip', sourceUrl, { reason: 'tab-hidden-before-enqueue' });
        return;
    }

    if (await getProcessedCacheBlob(sourceUrl)) {
        logQueueEvent('bg-process:skip-cached', sourceUrl, { cache: 'persistent' });
        return;
    }

    if (backgroundQueue.includes(sourceUrl)) {
        logQueueEvent('bg-queue:skip', sourceUrl, { reason: 'url-already-queued-late' });
        return;
    }

    const activeImg = getActiveContainer()?.querySelector('img');
    const activeUrl = activeImg?.currentSrc || activeImg?.src;
    if (sourceUrl === activeUrl) {
        logQueueEvent('bg-process:skip-foreground', sourceUrl);
        return;
    }

    if (!backgroundQueue.includes(sourceUrl)) {
        backgroundQueue.push(sourceUrl);
        logQueueEvent('bg-queue:enqueued', sourceUrl);
    }

    if (!backgroundProcessing) {
        log('bg-queue:kickoff', { queueSize: backgroundQueue.length });
        processBackgroundQueue();
    }
}

async function processBackgroundQueue() {
    if (!isForegroundTab()) {
        log('bg-queue:paused', { reason: 'tab-hidden', queueSize: backgroundQueue.length });
        return;
    }

    await Promise.all([backendReadyPromise, webgpuModelReadyPromise]);

    if (backgroundProcessing || backgroundQueue.length === 0) return;

    if (getEffectiveBackend() === 'off') {
        log('bg-queue:cleared', { reason: 'backend-off', queueSize: backgroundQueue.length });
        backgroundQueue = [];
        return;
    }

    backgroundProcessing = true;
    log('bg-queue:start', { queueSize: backgroundQueue.length });

    while (backgroundQueue.length > 0) {
        if (!isForegroundTab()) {
            log('bg-queue:paused', { reason: 'tab-hidden-mid-run', queueSize: backgroundQueue.length });
            break;
        }

        const nextIndex = getNextBackgroundQueueIndex();
        if (nextIndex < 0) break;
        const [sourceUrl] = backgroundQueue.splice(nextIndex, 1);
        logQueueEvent('bg-queue:dequeued', sourceUrl, { nextIndex });

        if (await getProcessedCacheBlob(sourceUrl)) {
            logQueueEvent('bg-process:skip-cached', sourceUrl, { cache: 'persistent-after-dequeue' });
            continue;
        }

        const activeImg = getActiveContainer()?.querySelector('img');
        const activeUrl = activeImg?.currentSrc || activeImg?.src;
        if (sourceUrl === activeUrl) {
            logQueueEvent('bg-process:skip-now-foreground', sourceUrl);
            continue;
        }

        const page = getPageNumberFromUrl(sourceUrl);
        const pageKey = getGalleryPageKey(sourceUrl);
        if (page == null) {
            logQueueEvent('bg-process:page-missing', sourceUrl);
        }
        if (pageKey) inFlightPageKeys.add(pageKey);

        try {
            const tempImg = await loadImageForWebGL(sourceUrl);
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

            if (pageKey) processedPageKeys.add(pageKey);

            if (bgCanvas.width <= 0 || bgCanvas.height <= 0) {
                throw new Error('Canvas output is empty after upscale');
            }

            bgCanvas.toBlob((blob) => {
                if (blob) {
                    setProcessedCacheBlob(sourceUrl, blob);
                    logQueueEvent('bg-process:cached', sourceUrl, {
                        width: bgCanvas.width,
                        height: bgCanvas.height,
                    });
                }
            });
        } catch (err) {
            log('bg-process:error', { sourceUrl, page, error: String(err) });
        } finally {
            if (pageKey) inFlightPageKeys.delete(pageKey);
        }

        await new Promise(resolve => setTimeout(resolve, 10));
    }

    backgroundProcessing = false;
    log('bg-queue:idle', { queueSize: backgroundQueue.length });
}

function findAndProcessBackgroundImages() {
    if (!isForegroundTab()) return;

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

    if (existingCanvas && existingCanvas.dataset.aiSourceUrl && existingCanvas.dataset.aiSourceUrl !== sourceUrl) {
        existingCanvas.remove();
    }

    const currentCanvas = parent.querySelector('.ai-canvas');
    if (hasRenderedCanvasForSource(img, currentCanvas, sourceUrl)) {
        hideOriginal(img);
        currentCanvas.style.display = 'block';
        currentCanvas.style.visibility = 'visible';
        return;
    }

    const cachedBlob = await getProcessedCacheBlob(sourceUrl);
    if (cachedBlob) {
        let canvas = ensureCanvas(parent);

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
            return;
        } catch (err) {
            log('process:cache-restore-failed', { sourceUrl, error: String(err) });
        }
    }

    if (img.dataset.aiProcessingSrc === sourceUrl) return;

    const jobId = String(++jobCounter);
    img.dataset.aiJobId = jobId;
    img.dataset.aiProcessingSrc = sourceUrl;
    img.dataset.aiProcessed = 'true';
    const page = getPageNumberFromUrl(sourceUrl);
    if (page == null) {
        log('process:page-missing', { sourceUrl, pageKey: getGalleryPageKey(sourceUrl), jobId });
    }
    log('process:start', { sourceUrl, page, jobId, backend: getEffectiveBackend() });

    let canvas = ensureCanvas(parent);

    try {
        const tempImg = await loadImageForWebGL(sourceUrl);

        const latestSrc = img.currentSrc || img.src;
        if (isStaleForegroundJob(img, jobId, sourceUrl, canvas, parent)) {
            log('process:abort-stale', { sourceUrl, latestSrc, jobId, activeJobId: img.dataset.aiJobId, phase: 'before-upscale' });
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

        const latestAfterUpscale = img.currentSrc || img.src;
        if (isStaleForegroundJob(img, jobId, sourceUrl, canvas, parent)) {
            log('process:abort-stale', {
                sourceUrl,
                latestSrc: latestAfterUpscale,
                jobId,
                activeJobId: img.dataset.aiJobId,
                phase: 'after-upscale'
            });
            delete img.dataset.aiProcessingSrc;
            return;
        }

        canvas.style.visibility = 'visible';
        canvas.style.display = 'block';

        if (canvas.width <= 0 || canvas.height <= 0) {
            throw new Error('Canvas output is empty after upscale');
        }

        canvas.toBlob((blob) => {
            if (blob) {
                setProcessedCacheBlob(sourceUrl, blob);
            }
        });

        img.dataset.aiProcessed = 'true';
        img.dataset.aiProcessedSrc = sourceUrl;
        canvas.dataset.aiSourceUrl = sourceUrl;
        delete img.dataset.aiProcessingSrc;
        hideOriginal(img);
        reconcile(container);
    } catch (err) {
        img.dataset.aiProcessed = 'false';
        delete img.dataset.aiProcessingSrc;
        showOriginal(img);
        log('process:error', { sourceUrl, page, jobId, error: String(err) });
        console.error('Anime4K processing failed:', err);
    }
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
            scheduleProcess(reason);
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
    findAndProcessBackgroundImages();
}

const rootObserver = new MutationObserver((mutations) => {
    attachContainerObserver();
    scanPerformanceResources();

    for (const mutation of mutations) {
        if (mutation.type === 'childList') {
            for (const node of mutation.addedNodes) {
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

        document.querySelectorAll('img[data-ai-processed-src]').forEach((img) => {
            delete img.dataset.aiProcessed;
            delete img.dataset.aiProcessedSrc;
            delete img.dataset.aiProcessingSrc;
            delete img.dataset.aiJobId;
        });
        document.querySelectorAll('.ai-canvas').forEach((canvas) => {
            canvas.remove();
        });
        seenPerformanceResourceUrls.clear();

        log('settings:changed', { selectedSimplePreset, selectedEngineBackend, selectedWebGpuModel });
        scheduleProcess('preset-changed');
        findAndProcessBackgroundImages();
        scanPerformanceResources();
    });
}

backendReadyPromise
    .then(() => {
        if (getEffectiveBackend() !== 'webgl') return;
        return getScaler();
    })
    .catch(err => {
        log('scaler:preinit-failed', { error: String(err) });
    });

setInterval(() => {
    if (!isForegroundTab()) return;

    attachContainerObserver();
    scheduleProcess('interval');
    findAndProcessBackgroundImages();
    scanPerformanceResources();
}, SAFETY_INTERVAL_MS);

attachContainerObserver();
scheduleProcess('initial');
scanPerformanceResources();
