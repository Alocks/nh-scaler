// DOM manipulation for image rendering and canvas management

const IMAGE_LOAD_TIMEOUT_MS = 10000;

function hideOriginal(img) {
    img.style.setProperty('display', 'none', 'important');
    img.style.setProperty('visibility', 'hidden', 'important');
}

function showOriginal(img) {
    img.style.removeProperty('display');
    img.style.removeProperty('visibility');
}

function disableUpscalingForContainer(container, sourceUrl) {
    const img = container.querySelector('img');
    if (img) {
        showOriginal(img);
        img.dataset.aiProcessed = 'false';
        delete img.dataset.aiProcessingSrc;
    }

    const canvas = container.querySelector('.ai-canvas');
    if (canvas) {
        canvas.style.display = 'none';
        canvas.style.visibility = 'hidden';
        if (sourceUrl) {
            canvas.dataset.aiSourceUrl = sourceUrl;
        }
    }
}

function ensureCanvas(parent) {
    let canvas = parent.querySelector('.ai-canvas');
    if (!canvas) {
        canvas = document.createElement('canvas');
        canvas.width = 0;
        canvas.height = 0;
        if (parent.className) {
            canvas.className = parent.className + ' ai-canvas';
        } else {
            canvas.className = 'ai-canvas';
        }
        canvas.style.pointerEvents = 'none';
        canvas.style.display = 'none';
        canvas.style.visibility = 'hidden';
        parent.appendChild(canvas);
    }

    return canvas;
}

function hasRenderedCanvasForSource(img, canvas, sourceUrl) {
    return (
        !!canvas &&
        canvas.dataset.aiSourceUrl === sourceUrl &&
        canvas.width > 0 &&
        canvas.height > 0 &&
        img.dataset.aiProcessedSrc === sourceUrl
    );
}

function reconcile(container) {
    const img = container.querySelector('img');
    if (!img) return;

    const sourceUrl = img.currentSrc || img.src;
    if (!sourceUrl) return;

    const parent = img.parentElement;
    if (!parent) return;

    if (getEffectiveBackend() === 'off') {
        disableUpscalingForContainer(container, sourceUrl);
        return;
    }

    const canvas = parent.querySelector('.ai-canvas');
    if (hasRenderedCanvasForSource(img, canvas, sourceUrl)) {
        canvas.style.display = 'block';
        canvas.style.visibility = 'visible';
        hideOriginal(img);
    }
}

function loadSourceImage(sourceUrl) {
    return new Promise((resolve, reject) => {
        if (typeof sourceUrl !== 'string' || !sourceUrl) {
            reject(new Error(`Invalid source image URL: ${String(sourceUrl)}`));
            return;
        }

        const tempImg = new Image();
        let settled = false;
        let timeoutId = null;

        const cleanup = () => {
            tempImg.onload = null;
            tempImg.onerror = null;
            if (timeoutId !== null) {
                clearTimeout(timeoutId);
                timeoutId = null;
            }
        };

        const settleResolve = () => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(tempImg);
        };

        const settleReject = (error) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
        };

        tempImg.crossOrigin = 'anonymous';
        tempImg.onload = () => settleResolve();
        tempImg.onerror = () => {
            settleReject(new Error(`Failed to load source image: ${sourceUrl}`));
        };

        timeoutId = window.setTimeout(() => {
            tempImg.src = '';
            settleReject(new Error(`Timed out loading source image after ${IMAGE_LOAD_TIMEOUT_MS}ms: ${sourceUrl}`));
        }, IMAGE_LOAD_TIMEOUT_MS);

        tempImg.src = sourceUrl;
    });
}

function canvasToBlob(canvas, type = 'image/png', quality) {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (blob) {
                resolve(blob);
                return;
            }
            reject(new Error('Canvas toBlob returned null'));
        }, type, quality);
    });
}
