// Keep chart geometry stable and fit the complete composition into the viewport.
// Scaling the same amount on both axes preserves bar and panel proportions.
(() => {
    const frame = document.getElementById('fingerprint-frame');
    const canvas = document.getElementById('fingerprint-chart');
    function fitViewport() {
        const gap = Math.max(8, Math.min(frame.clientWidth, frame.clientHeight) * 0.02);
        const width = canvas.offsetWidth;
        const height = canvas.offsetHeight;
        if (!width || !height) return;
        const scale = Math.max(0, Math.min(
            (frame.clientWidth - 2 * gap) / width,
            (frame.clientHeight - 2 * gap) / height
        ));
        canvas.style.transform = `scale(${scale})`;
        canvas.style.left = `${Math.max(0, (frame.clientWidth - width * scale) / 2)}px`;
        canvas.style.top = `${Math.max(0, (frame.clientHeight - height * scale) / 2)}px`;
    }
    new ResizeObserver(fitViewport).observe(canvas);
    new ResizeObserver(fitViewport).observe(frame);
    fitViewport();
})();
