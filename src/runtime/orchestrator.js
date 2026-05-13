// Main orchestrator: listeners, observers, and foreground image processing

const SAFETY_INTERVAL_MS = 1000;
const BACKGROUND_DISCOVERY_DEBOUNCE_MS = 150;

let jobCounter = 0;
const CLEAR_CACHE_MESSAGE_TYPE = 'nh-scaler:clear-cache';

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

function resetProcessedRuntimeState() {
    processedCache.clear();
    processedPageKeys.clear();
    inFlightPageKeys.clear();
    backgroundQueue = [];
    backgroundProcessing = false;
    seenPerformanceResourceUrls.clear();
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
        const tempImg = await loadSourceImage(sourceUrl);

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

        const processedBlob = await canvasToBlob(canvas);
        await setProcessedCacheBlob(sourceUrl, processedBlob);

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
let backgroundDiscoveryTimeoutId = null;

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

function scheduleBackgroundDiscovery(reason) {
    if (backgroundDiscoveryTimeoutId !== null) {
        clearTimeout(backgroundDiscoveryTimeoutId);
    }

    backgroundDiscoveryTimeoutId = window.setTimeout(() => {
        backgroundDiscoveryTimeoutId = null;
        findAndProcessBackgroundImages();
        scanPerformanceResources();
        log('bg-discovery:run', { reason });
    }, BACKGROUND_DISCOVERY_DEBOUNCE_MS);
}

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
            scheduleBackgroundDiscovery(reason);
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
    scheduleBackgroundDiscovery('container-attached');
}

const rootObserver = new MutationObserver((mutations) => {
    attachContainerObserver();
    scheduleBackgroundDiscovery('root-mutation');

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
    scheduleBackgroundDiscovery('visibilitychange');
    processBackgroundQueue();
});

if (chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'sync') return;

        const changeResult = applyRuntimePreferenceStorageChanges(changes);
        if (!changeResult.didChange) return;

        resetBackendRuntimeState();
        resetProcessedRuntimeState();

        document.querySelectorAll('img[data-ai-processed-src]').forEach((img) => {
            delete img.dataset.aiProcessed;
            delete img.dataset.aiProcessedSrc;
            delete img.dataset.aiProcessingSrc;
            delete img.dataset.aiJobId;
        });
        document.querySelectorAll('.ai-canvas').forEach((canvas) => {
            canvas.remove();
        });

        log('settings:changed', getRuntimePreferenceSnapshot());
        scheduleProcess('preset-changed');
        scheduleBackgroundDiscovery('preset-changed');
    });
}

if (chrome?.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (message?.type !== CLEAR_CACHE_MESSAGE_TYPE) return;

        (async () => {
            try {
                const cleared = await clearProcessedCache();
                resetProcessedRuntimeState();
                log('cache:cleared', { cleared });
                sendResponse({ ok: cleared });
            } catch (error) {
                sendResponse({ ok: false, error: String(error) });
            }
        })();

        return true;
    });
}

backendReadyPromise
    .then(() => {
        return prewarmSelectedBackend();
    })
    .catch(err => {
        log('scaler:preinit-failed', { error: String(err) });
    });

setInterval(() => {
    if (!isForegroundTab()) return;

    attachContainerObserver();
    scheduleProcess('interval');
    scheduleBackgroundDiscovery('interval');
}, SAFETY_INTERVAL_MS);

attachContainerObserver();
scheduleProcess('initial');
scheduleBackgroundDiscovery('initial');
