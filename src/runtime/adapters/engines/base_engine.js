// Base engine adapter scaffold for implementing additional upscale backends.
// New engines can clone this shape and replace each placeholder method.

function createBaseEngineAdapter(overrides = {}) {
    const adapter = {
        isSupported: () => false,
        upscale: async () => {
            throw new Error('Base engine adapter: upscale() is not implemented');
        },
        prewarm: async () => {},
        reset: () => {}
    };

    return {
        ...adapter,
        ...overrides
    };
}

// Expose the scaffold factory so future engine files can reuse it.
window.createBaseEngineAdapter = createBaseEngineAdapter;
