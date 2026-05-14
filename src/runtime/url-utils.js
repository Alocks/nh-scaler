// Source adapter dispatch helpers

function getRegisteredSourceAdapters() {
    return Array.isArray(window.NHScalerSourceAdapters) ? window.NHScalerSourceAdapters : [];
}

function getActiveSourceAdapter(pageUrl = window.location.href) {
    const adapters = getRegisteredSourceAdapters();
    return adapters.find((adapter) => typeof adapter?.isReaderPageUrl === 'function' && adapter.isReaderPageUrl(pageUrl)) || null;
}

function getSourceAdapterForImageUrl(url) {
    const activeAdapter = getActiveSourceAdapter(window.location.href);
    if (activeAdapter && typeof activeAdapter?.parseImageUrl === 'function') {
        const parsed = activeAdapter.parseImageUrl(url);
        if (parsed) return { adapter: activeAdapter, parsed };
    }

    const adapters = getRegisteredSourceAdapters();
    for (const adapter of adapters) {
        if (adapter === activeAdapter || typeof adapter?.parseImageUrl !== 'function') continue;
        const parsed = adapter.parseImageUrl(url);
        if (parsed) return { adapter, parsed };
    }

    return null;
}

function isReaderPageUrl(url) {
    return !!getActiveSourceAdapter(url);
}

function isSourceImageUrl(url) {
    return !!getSourceAdapterForImageUrl(url);
}

function getSourcePageKey(url) {
    return getSourceAdapterForImageUrl(url)?.parsed?.pageKey || null;
}

function getSourcePageNumber(url) {
    return getSourceAdapterForImageUrl(url)?.parsed?.page || null;
}
