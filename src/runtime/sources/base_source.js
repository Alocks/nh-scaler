// Template source adapter scaffold for adding a new website
// Copy this file, rename identifiers, and implement the three adapter methods.

const TEMPLATE_SOURCE_ID = 'template-site';

const templateSiteSourceAdapter = {
    id: TEMPLATE_SOURCE_ID,
    supportsUrl(_url) {
        // Return true when the URL belongs to your target website.
        return false;
    },
    isReaderPageUrl(_url) {
        // Return true only on pages where image upscaling should run.
        return false;
    },
    parseImageUrl(_url) {
        // Return null for non-matching image URLs.
        // For matching URLs, return an object with at least:
        // { page: Number, pageKey: String }
        return null;
    }
};

if (!Array.isArray(window.NHScalerSourceAdapters)) {
    window.NHScalerSourceAdapters = [];
}

const existingTemplateAdapterIndex = window.NHScalerSourceAdapters.findIndex((adapter) => adapter?.id === TEMPLATE_SOURCE_ID);
if (existingTemplateAdapterIndex >= 0) {
    window.NHScalerSourceAdapters[existingTemplateAdapterIndex] = templateSiteSourceAdapter;
} else {
    window.NHScalerSourceAdapters.push(templateSiteSourceAdapter);
}
