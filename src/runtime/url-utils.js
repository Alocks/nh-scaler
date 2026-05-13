// URL parsing and nhentai gallery detection with diagnostics

const loggedNhentaiParseIssues = new Set();

function parseUrlSafely(url) {
    if (typeof url !== 'string' || !url) return null;
    try {
        return new URL(url, window.location.href);
    } catch {
        return null;
    }
}

function isNhentaiHost(hostname) {
    return typeof hostname === 'string' && /(^|\.)nhentai\.net$/i.test(hostname);
}

function parseNhentaiGalleryImageUrl(url) {
    const parsed = parseUrlSafely(url);
    if (!parsed || !isNhentaiHost(parsed.hostname)) return null;

    const match = parsed.pathname.match(/^\/galleries\/(\d+)\/(\d+)\.(webp|jpe?g|png)$/i);
    if (!match) return null;

    const galleryId = match[1];
    const page = Number(match[2]);
    if (!Number.isFinite(page)) {
        logNhentaiParseIssue('page-number-invalid', url, { rawPage: match[2] });
        return null;
    }

    return {
        parsedUrl: parsed,
        galleryId,
        page,
        extension: match[3].toLowerCase(),
        pageKey: `${galleryId}/${page}`
    };
}

function logNhentaiParseIssue(kind, url, extra = {}) {
    if (typeof url !== 'string' || !url) return;

    const issueKey = `${kind}|${url}`;
    if (loggedNhentaiParseIssues.has(issueKey)) return;
    loggedNhentaiParseIssues.add(issueKey);

    if (typeof window.NHScalerLog === 'function') {
        window.NHScalerLog(`url:${kind}`, { url, ...extra });
    }
}

function isNhentaiReaderPageUrl(url) {
    const parsed = parseUrlSafely(url);
    if (!parsed || !isNhentaiHost(parsed.hostname)) return false;
    return /^\/g\/\d+\/\d+\/?$/i.test(parsed.pathname);
}

function isNhentaiGalleryUrl(url) {
    return !!parseNhentaiGalleryImageUrl(url);
}

const isLikelyNhentaiImageUrl = isNhentaiGalleryUrl;

function getGalleryPageKey(url) {
    return parseNhentaiGalleryImageUrl(url)?.pageKey || null;
}

function getPageNumberFromUrl(url) {
    return parseNhentaiGalleryImageUrl(url)?.page || null;
}
