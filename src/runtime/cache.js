// Image processing cache: in-memory Map and IndexedDB persistence

const processedCache = new Map();
const MAX_PROCESSED_CACHE_ENTRIES = 100;
const PROCESSED_CACHE_DB_NAME = 'nh-scaler-processed-cache';
const PROCESSED_CACHE_STORE_NAME = 'images';
let processedCacheDbPromise = null;

function getProcessedCacheEntry(cacheKey) {
    if (!processedCache.has(cacheKey)) return null;

    const blob = processedCache.get(cacheKey) || null;
    if (!blob) {
        processedCache.delete(cacheKey);
        return null;
    }

    processedCache.delete(cacheKey);
    processedCache.set(cacheKey, blob);
    return blob;
}

function trimProcessedCacheEntries() {
    while (processedCache.size > MAX_PROCESSED_CACHE_ENTRIES) {
        const oldestKey = processedCache.keys().next().value;
        if (!oldestKey) break;
        processedCache.delete(oldestKey);
    }
}

function rememberProcessedCacheEntry(cacheKey, blob) {
    if (!cacheKey || !blob) return;

    if (processedCache.has(cacheKey)) {
        processedCache.delete(cacheKey);
    }

    processedCache.set(cacheKey, blob);
    trimProcessedCacheEntries();
}

function getProcessedCacheSignature(runtimeSettings = getRuntimePreferenceSnapshot()) {
    const settings = getNormalizedRuntimePreferenceSnapshot(runtimeSettings);
    const backend = getEffectiveBackend(settings);
    if (backend === 'off') return 'off';
    return `${backend}|${settings.selectedSimplePreset}|${settings.selectedWebGpuModel}|${settings.selectedWebGpuScale}`;
}

function getProcessedCacheKey(url, runtimeSettings = getRuntimePreferenceSnapshot()) {
    if (typeof url !== 'string' || !url) return null;
    return `${getProcessedCacheSignature(runtimeSettings)}|${url}`;
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
        request.onerror = () => {
            runtimeLog('cache:db-open-error', { error: String(request.error) });
            resolve(null);
        };
        request.onblocked = () => {
            runtimeLog('cache:db-open-blocked');
            resolve(null);
        };
    });

    return processedCacheDbPromise;
}

async function getProcessedCacheBlob(url, runtimeSettings = getRuntimePreferenceSnapshot()) {
    const cacheKey = getProcessedCacheKey(url, runtimeSettings);
    if (!cacheKey) return null;

    const memoryBlob = getProcessedCacheEntry(cacheKey);
    if (memoryBlob) {
        return memoryBlob;
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
                rememberProcessedCacheEntry(cacheKey, blob);
            }
            resolve(blob);
        };

        request.onerror = () => {
            runtimeLog('cache:db-read-error', { cacheKey, error: String(request.error) });
            resolve(null);
        };
    });
}

async function setProcessedCacheBlob(url, blob, runtimeSettings = getRuntimePreferenceSnapshot()) {
    const cacheKey = getProcessedCacheKey(url, runtimeSettings);
    if (!cacheKey || !blob) return;

    rememberProcessedCacheEntry(cacheKey, blob);

    const db = await openProcessedCacheDb();
    if (!db) return;

    return new Promise((resolve) => {
        const tx = db.transaction(PROCESSED_CACHE_STORE_NAME, 'readwrite');
        const store = tx.objectStore(PROCESSED_CACHE_STORE_NAME);
        store.put({ cacheKey, url, blob, updatedAt: Date.now() });
        tx.oncomplete = () => resolve();
        tx.onerror = () => {
            runtimeLog('cache:db-write-error', { cacheKey, error: String(tx.error) });
            resolve();
        };
        tx.onabort = () => {
            runtimeLog('cache:db-write-abort', { cacheKey, error: String(tx.error) });
            resolve();
        };
    });
}

function hasProcessedCacheEntry(url, runtimeSettings = getRuntimePreferenceSnapshot()) {
    const cacheKey = getProcessedCacheKey(url, runtimeSettings);
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
        tx.onerror = () => {
            runtimeLog('cache:db-clear-error', { error: String(tx.error) });
            resolve(false);
        };
        tx.onabort = () => {
            runtimeLog('cache:db-clear-abort', { error: String(tx.error) });
            resolve(false);
        };
    });
}
