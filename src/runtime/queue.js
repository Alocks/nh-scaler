// Background queue management for batch image upscaling

const processedPageKeys = new Set();
const inFlightPageKeys = new Set();
let backgroundQueue = [];
let backgroundProcessing = false;
const seenPerformanceResourceUrls = new Set();

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
    if (!isNhentaiReaderPageUrl(window.location.href)) return;
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

async function preprocessBackgroundImage(sourceUrl) {
    if (!isNhentaiReaderPageUrl(window.location.href)) return;
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
    if (!isNhentaiReaderPageUrl(window.location.href)) {
        backgroundQueue = [];
        backgroundProcessing = false;
        return;
    }
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
            const tempImg = await loadSourceImage(sourceUrl);
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
    if (!isNhentaiReaderPageUrl(window.location.href)) return;
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
