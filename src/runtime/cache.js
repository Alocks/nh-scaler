const processedCache = new Map();
const PROCESSED_CACHE_DB_NAME = 'nh-scaler-processed-cache';
const PROCESSED_CACHE_STORE_NAME = 'images';
let processedCacheDbPromise = null;

function getProcessedCacheSignature() {
    const backend = getEffectiveBackend();
    if (backend === 'off') return 'off';
    return `${backend}|${selectedSimplePreset}|${selectedWebGpuModel}`;
}

function getProcessedCacheKey(url) {
    if (typeof url !== 'string' || !url) return null;
    return `${getProcessedCacheSignature()}|${url}`;
}

function openProcessedCacheDb() {
    if (!('indexedDB' in window)) {
        return Promise.resolve(null);
    }

    if (processedCacheDbPromise) {
        return processedCacheDbPromise;
    }

    processedCacheDbPromise = new Promise((resolve) => {
        const request = indexedDB.open(PROCESSED_CACHE_DB_NAME, 1);

        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(PROCESSED_CACHE_STORE_NAME)) {
                db.createObjectStore(PROCESSED_CACHE_STORE_NAME, { keyPath: 'cacheKey' });
            }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
    });

    return processedCacheDbPromise;
}

async function getProcessedCacheBlob(url) {
    const cacheKey = getProcessedCacheKey(url);
    if (!cacheKey) return null;

    if (processedCache.has(cacheKey)) {
        return processedCache.get(cacheKey);
    }

    const db = await openProcessedCacheDb();
    if (!db) return null;

    return new Promise((resolve) => {
        const tx = db.transaction(PROCESSED_CACHE_STORE_NAME, 'readonly');
        const store = tx.objectStore(PROCESSED_CACHE_STORE_NAME);
        const request = store.get(cacheKey);

        request.onsuccess = () => {
            const blob = request.result?.blob || null;
            if (blob) {
                processedCache.set(cacheKey, blob);
            }
            resolve(blob);
        };

        request.onerror = () => resolve(null);
    });
}

async function setProcessedCacheBlob(url, blob) {
    const cacheKey = getProcessedCacheKey(url);
    if (!cacheKey || !blob) return;

    processedCache.set(cacheKey, blob);

    const db = await openProcessedCacheDb();
    if (!db) return;

    return new Promise((resolve) => {
        const tx = db.transaction(PROCESSED_CACHE_STORE_NAME, 'readwrite');
        const store = tx.objectStore(PROCESSED_CACHE_STORE_NAME);
        store.put({ cacheKey, url, blob, updatedAt: Date.now() });
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
    });
}

function hasProcessedCacheEntry(url) {
    const cacheKey = getProcessedCacheKey(url);
    return !!cacheKey && processedCache.has(cacheKey);
}

async function clearProcessedCache() {
    processedCache.clear();

    const db = await openProcessedCacheDb();
    if (!db) return false;

    return new Promise((resolve) => {
        const tx = db.transaction(PROCESSED_CACHE_STORE_NAME, 'readwrite');
        const store = tx.objectStore(PROCESSED_CACHE_STORE_NAME);
        store.clear();
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
    });
}
