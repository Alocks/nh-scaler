const loggedNhentaiParseIssues = new Set();

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
    return typeof url === 'string' && /nhentai\.net/i.test(url) && /\/(?:galleries\/)?\d+/i.test(url);
}

function isNhentaiGalleryUrl(url) {
    if (typeof url !== 'string') return false;
    return /\/\d+\.(?:webp|jpe?g|png)([?#].*)?$/i.test(url);
}

function getGalleryPageKey(url) {
    if (typeof url !== 'string') return null;
    const match = url.match(/\/galleries\/(\d+)\/(\d+)\.(?:webp|jpe?g|png)/i);
    if (!match) {
        if (isLikelyNhentaiImageUrl(url) && /\/galleries\//i.test(url)) {
            logNhentaiParseIssue('gallery-key-miss', url);
        }
        return null;
    }
    return `${match[1]}/${match[2]}`;
}

function getPageNumberFromUrl(url) {
    if (typeof url !== 'string') return null;
    const match = url.match(/\/(\d+)\.(?:webp|jpe?g|png)(?:[?#].*)?$/i);
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
