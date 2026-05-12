// @ts-nocheck
const DEBUG = true;

function log(label, data = {}) {
    if (!DEBUG) return;
    console.log('[NH Scaler]', label, { ts: new Date().toISOString(), ...data });
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
