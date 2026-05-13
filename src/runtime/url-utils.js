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

function logNhentaiParseIssue(kind, url, extra = {}) {
    if (typeof url !== 'string' || !url) return;

    const issueKey = `${kind}|${url}`;
    if (loggedNhentaiParseIssues.has(issueKey)) return;
    loggedNhentaiParseIssues.add(issueKey);

    if (typeof window.NHScalerLog === 'function') {
        window.NHScalerLog(`url:${kind}`, { url, ...extra });
    }
}

function isLikelyNhentaiImageUrl(url) {
    const parsed = parseUrlSafely(url);
    if (!parsed || !isNhentaiHost(parsed.hostname)) return false;
    return /^\/galleries\/\d+\/\d+\.(?:webp|jpe?g|png)$/i.test(parsed.pathname);
}

function isNhentaiReaderPageUrl(url) {
    const parsed = parseUrlSafely(url);
    if (!parsed || !isNhentaiHost(parsed.hostname)) return false;
    return /^\/g\/\d+\/\d+\/?$/i.test(parsed.pathname);
}

function isNhentaiGalleryUrl(url) {
    const parsed = parseUrlSafely(url);
    if (!parsed || !isNhentaiHost(parsed.hostname)) return false;
    return /^\/galleries\/\d+\/\d+\.(?:webp|jpe?g|png)$/i.test(parsed.pathname);
}

function getGalleryPageKey(url) {
    const parsed = parseUrlSafely(url);
    if (!parsed) return null;
    const match = parsed.pathname.match(/^\/galleries\/(\d+)\/(\d+)\.(?:webp|jpe?g|png)$/i);
    if (!match) {
        if (isLikelyNhentaiImageUrl(url)) {
            logNhentaiParseIssue('gallery-key-miss', url);
        }
        return null;
    }
    return `${match[1]}/${match[2]}`;
}

function getPageNumberFromUrl(url) {
    const parsed = parseUrlSafely(url);
    if (!parsed) return null;
    const match = parsed.pathname.match(/^\/galleries\/\d+\/(\d+)\.(?:webp|jpe?g|png)$/i);
    if (!match) {
        if (isLikelyNhentaiImageUrl(url)) {
            logNhentaiParseIssue('page-number-miss', url);
        }
        return null;
    }
    const page = Number(match[1]);
    if (!Number.isFinite(page)) {
        logNhentaiParseIssue('page-number-invalid', url, { rawPage: match[1] });
        return null;
    }
    return Number.isFinite(page) ? page : null;
}
