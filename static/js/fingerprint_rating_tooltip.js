function attachRatingTooltip(points, formatConfidence) {
    let card = document.getElementById('rating-tooltip');
    if (!card) {
        card = document.createElement('div');
        card.id = 'rating-tooltip';
        card.className = 'rating-tooltip';
        card.setAttribute('role', 'tooltip');
        card.hidden = true;
        document.body.appendChild(card);
        const hide = () => { card.hidden = true; };
        window.addEventListener('resize', hide);
        window.addEventListener('scroll', hide, true);
        new MutationObserver(hide).observe(document.getElementById('fingerprint-chart'), { childList: true, subtree: true });
    }
    const hide = () => { card.hidden = true; };
    const position = event => {
        const bounds = event.currentTarget.getBoundingClientRect();
        const x = event.type.startsWith('pointer') ? event.clientX : bounds.right;
        const y = event.type.startsWith('pointer') ? event.clientY : bounds.top;
        card.style.left = `${Math.max(12, Math.min(x + 16, window.innerWidth - card.offsetWidth - 12))}px`;
        card.style.top = `${Math.max(12, Math.min(y + 16, window.innerHeight - card.offsetHeight - 12))}px`;
    };
    const show = (event, row) => {
        card.replaceChildren();
        const add = (className, text) => {
            const element = document.createElement('div');
            element.className = className;
            element.textContent = text;
            card.appendChild(element);
        };
        add('rating-tooltip-user', `User: ${row.user}`);
        if (row.product) add('rating-tooltip-meta', `Product: ${row.product}`);
        add('rating-tooltip-meta', `Rating: ${row.value} / 9 · Confidence: ${formatConfidence(row)}`);
        add('rating-tooltip-label', 'Comments');
        add('rating-tooltip-comment', row.comments || 'No comments');
        card.hidden = false;
        position(event);
    };
    points.on('pointerenter.tooltip', show)
        .on('pointermove.tooltip', position)
        .on('pointerleave.tooltip', hide)
        .on('focus.tooltip', show)
        .on('blur.tooltip', hide)
        .on('click.tooltip', hide)
        .on('keydown.tooltip', event => {
            if (event.key === 'Escape') hide();
            if (!card.hidden && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
                event.preventDefault();
                card.scrollTop += event.key === 'ArrowDown' ? 40 : -40;
            }
        })
        .on('wheel.tooltip', event => {
            if (!card.hidden && card.scrollHeight > card.clientHeight) {
                event.preventDefault();
                card.scrollTop += event.deltaY;
            }
        }, { passive: false });
}
