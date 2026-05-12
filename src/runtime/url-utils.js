function isNhentaiGalleryUrl(url) {
    if (typeof url !== 'string') return false;
    return /\/\d+\.(?:webp|jpe?g|png)([?#].*)?$/i.test(url);
}

function getGalleryPageKey(url) {
    if (typeof url !== 'string') return null;
    const match = url.match(/\/galleries\/(\d+)\/(\d+)\.(?:webp|jpe?g|png)/i);
    if (!match) return null;
    return `${match[1]}/${match[2]}`;
}

function getPageNumberFromUrl(url) {
    if (typeof url !== 'string') return null;
    const match = url.match(/\/(\d+)\.(?:webp|jpe?g|png)(?:[?#].*)?$/i);
    if (!match) return null;
    const page = Number(match[1]);
    return Number.isFinite(page) ? page : null;
}
