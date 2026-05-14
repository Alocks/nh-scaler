// Bootstrap entrypoint: logger setup and CSS injection

const DEBUG = false;
const ALWAYS_LOG_LABELS = new Set([
    'bg-process:skip-cached',
    'bg-process:upscale-time',
    'process:upscale-time'
]);

function log(label, data = {}) {
    if (!DEBUG && !ALWAYS_LOG_LABELS.has(label)) return;
    console.log('[Manga Scaler]', label, { ts: new Date().toISOString(), ...data });
}

window.NHScalerLog = log;

if (!document.querySelector('style[data-ai-scaler]')) {
    const style = document.createElement('style');
    style.setAttribute('data-ai-scaler', 'true');
    style.textContent = `
        #image-container {
            overflow: hidden;
        }

        .ai-canvas {
            max-width: 100%;
            max-height: 100%;
            width: auto;
            height: auto;
            display: block;
            margin: auto;
        }
    `;
    document.head.appendChild(style);
}
