    const stepInfoButton = document.getElementById("stepInfoButton");
    const stepDescriptionPopover = document.getElementById("stepDescriptionPopover");
    stepInfoButton?.addEventListener("click", event => {
        event.stopPropagation();
        const opening = stepDescriptionPopover.hidden;
        stepDescriptionPopover.hidden = !opening;
        stepInfoButton.setAttribute("aria-expanded", String(opening));
    });
    document.addEventListener("click", event => {
        if (!stepDescriptionPopover || stepDescriptionPopover.hidden) return;
        if (event.target.closest("#stepDescriptionPopover")) return;
        stepDescriptionPopover.hidden = true;
        stepInfoButton?.setAttribute("aria-expanded", "false");
    });

    document.querySelectorAll(".step3-source-window").forEach(sourceWindow => {
        const track = sourceWindow.querySelector(".step3-source-track");
        const modeSwitch = sourceWindow.querySelector("[data-source-mode-switch]");
        let panX = 0;
        let sourceZoom = 1;
        let startX = 0;
        let startPanX = 0;
        let dragging = false;
        let moved = false;

        const applySourceTransform = () => {
            track.style.transform = `translateX(${panX}px) scale(${sourceZoom})`;
        };

        sourceWindow.addEventListener("pointerdown", event => {
            if (event.target.closest(".step3-source-tools")) return;
            event.stopPropagation();
            dragging = true;
            moved = false;
            startX = event.clientX;
            startPanX = panX;
            sourceWindow.classList.add("is-grabbing");
            sourceWindow.setPointerCapture(event.pointerId);
        });

        sourceWindow.addEventListener("pointermove", event => {
            if (!dragging) return;
            event.stopPropagation();
            const delta = event.clientX - startX;
            if (Math.abs(delta) > 5) moved = true;
            if (sourceWindow.classList.contains("overview")) {
                const minPan = Math.min(0, sourceWindow.clientWidth - track.scrollWidth * sourceZoom);
                panX = Math.max(minPan, Math.min(0, startPanX + delta));
                applySourceTransform();
            }
        });

        sourceWindow.addEventListener("pointerup", event => {
            if (!dragging) return;
            event.stopPropagation();
            dragging = false;
            sourceWindow.classList.remove("is-grabbing");
            sourceWindow.releasePointerCapture(event.pointerId);
            const selectedCard = event.target.closest("[data-source-card]");
            if (!moved && sourceWindow.classList.contains("overview") && selectedCard) {
                const selectedIndex = [...track.children].indexOf(selectedCard);
                sourceWindow.classList.remove("overview");
                sourceZoom = 1;
                updateSourceModeSwitch();
                requestAnimationFrame(() => {
                    panX = -selectedIndex * sourceWindow.clientWidth;
                    applySourceTransform();
                });
            }
        });

        sourceWindow.addEventListener("pointercancel", () => {
            dragging = false;
            sourceWindow.classList.remove("is-grabbing");
        });

        const zoomSourceWindow = (nextZoom, pointerX = sourceWindow.clientWidth / 2) => {
            const previousZoom = sourceZoom;
            sourceZoom = Math.max(0.55, Math.min(1, nextZoom));
            sourceWindow.classList.toggle("overview", sourceZoom < 0.9);
            panX = pointerX - (pointerX - panX) * (sourceZoom / previousZoom);
            const minPan = Math.min(0, sourceWindow.clientWidth - track.scrollWidth * sourceZoom);
            panX = Math.max(minPan, Math.min(0, panX));
            applySourceTransform();
            updateSourceModeSwitch();
        };

        function updateSourceModeSwitch() {
            if (!modeSwitch) return;
            const overview = sourceWindow.classList.contains("overview");
            modeSwitch.textContent = overview ? "⛶" : "▦";
            modeSwitch.setAttribute("aria-label", overview ? "Show focus in this window" : "Show overview in this window");
            modeSwitch.title = overview ? "Show focus" : "Show overview";
        }

        sourceWindow.querySelectorAll("[data-source-zoom]").forEach(button => {
            button.addEventListener("click", event => {
                event.stopPropagation();
                zoomSourceWindow(sourceZoom + (button.dataset.sourceZoom === "in" ? 0.1 : -0.1));
            });
        });

        modeSwitch?.addEventListener("click", event => {
            event.stopPropagation();
            zoomSourceWindow(sourceWindow.classList.contains("overview") ? 1 : 0.62);
        });
        updateSourceModeSwitch();

    });

    const heatmapChecks = [...document.querySelectorAll(".heatmap-check")];
    const heatmapStats = [...document.querySelectorAll(".heatmap-stat")];
    const heatmapSelectedCount = document.getElementById("heatmapSelectedCount");

    const updateHeatmapStatistics = () => {
        if (!heatmapChecks.length) return;
        const selectedIds = heatmapChecks.filter(check => check.checked).map(check => check.value);
        const totals = new Map();

        selectedIds.forEach(strategyId => {
            document.querySelectorAll(`[data-heatmap-row="${strategyId}"] [data-coverage-axis]`).forEach(cell => {
                const key = `${cell.dataset.coverageAxis}:${cell.dataset.coverageKey}`;
                totals.set(key, (totals.get(key) || 0) + 1);
            });
        });

        if (heatmapSelectedCount) heatmapSelectedCount.textContent = selectedIds.length;
        heatmapStats.forEach(stat => {
            const key = `${stat.dataset.statAxis}:${stat.dataset.statKey}`;
            const count = totals.get(key) || 0;
            stat.textContent = selectedIds.length ? `${count}/${selectedIds.length}` : "0";
            stat.classList.toggle("covered", count > 0);
            stat.title = `${count} of ${selectedIds.length} selected LSCs cover this column`;
        });
    };

    heatmapChecks.forEach(check => check.addEventListener("change", async () => {
        const selected = check.checked;
        updateHeatmapStatistics();
        check.disabled = true;
        try {
            const body = new URLSearchParams({ selected: selected ? "1" : "0" });
            const response = await fetch(check.dataset.selectionUrl, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
                body,
            });
            if (!response.ok) throw new Error("Selection could not be saved");
        } catch (error) {
            check.checked = !selected;
            updateHeatmapStatistics();
            window.alert("The LSC selection could not be saved. Please try again.");
        } finally {
            check.disabled = false;
        }
    }));
    updateHeatmapStatistics();

    const scalePoints = [...document.querySelectorAll(".scale-point")];
    const scaleDefinition = document.getElementById("scaleDefinition");
    const scaleDefinitionLabel = document.getElementById("scaleDefinitionLabel");
    if (scalePoints.length && scaleDefinition && scaleDefinitionLabel) {
        const definitions = new Map(scalePoints.map(point => [point.dataset.scaleValue, point.dataset.definition || ""]));
        let activeScale = document.querySelector('.scale-point input:checked')?.value || "0";

        scalePoints.forEach(point => {
            point.querySelector("input").addEventListener("change", event => {
                definitions.set(activeScale, scaleDefinition.value);
                const previousCard = document.querySelector(`.scale-point[data-scale-value="${activeScale}"] .scale-anchor-card`);
                if (previousCard) previousCard.textContent = scaleDefinition.value;
                activeScale = event.target.value;
                scaleDefinition.value = definitions.get(activeScale) || "";
                scaleDefinitionLabel.textContent = `What should be the explanation for Scale ${activeScale}?`;
            });
        });
    }

    const viewport = document.querySelector(".board-viewport");
    const board = document.getElementById("stickyBoard");
    const activeQuestion = document.getElementById("activeQuestion");
    const zoomOut = document.getElementById("zoomOut");
    const zoomIn = document.getElementById("zoomIn");
    const zoomLevel = document.getElementById("zoomLevel");
    let viewZoom = null;
    let boardPanX = 0;
    let boardPanY = 0;
    let boardIsPanning = false;
    let boardPointerX = 0;
    let boardPointerY = 0;
    let hasFocused = false;

    const focusZoomLevel = () => {
        const mobile = window.matchMedia("(max-width: 560px)").matches;
        const tablet = window.matchMedia("(max-width: 900px)").matches;
        return mobile ? 0.96 : (tablet ? 0.98 : 1);
    };

    const updateBoardTransform = () => {
        if (!viewport || !board || viewZoom === null) return;
        const focusZoom = focusZoomLevel();
        const balance = Math.max(0, Math.min(1, (focusZoom - viewZoom) / (focusZoom - 0.35)));
        board.style.setProperty("--board-balance", balance.toFixed(3));
        if (activeQuestion?.dataset.focusHeight) {
            const focusHeight = Number(activeQuestion.dataset.focusHeight);
            const balancedHeight = 420;
            const currentHeight = focusHeight - (focusHeight - balancedHeight) * balance;
            activeQuestion.style.height = `${currentHeight}px`;
            activeQuestion.style.minHeight = `${currentHeight}px`;
            activeQuestion.style.maxHeight = `${currentHeight}px`;
        }
        board.style.transform = `translate(${boardPanX}px, ${boardPanY}px) scale(${viewZoom})`;
        viewport.classList.toggle("overview", viewZoom < focusZoom - 0.05);
        if (zoomLevel) zoomLevel.textContent = `${Math.round(viewZoom * 100)}%`;
    };

    const focusQuestion = () => {
        if (!viewport || !board || !activeQuestion) {
            return;
        }

        const focusZoom = focusZoomLevel();
        if (viewZoom === null) viewZoom = focusZoom;
        const availableCardHeight = Math.max(320, viewport.clientHeight / focusZoom - 150);
        activeQuestion.dataset.focusHeight = String(availableCardHeight);
        activeQuestion.style.height = `${availableCardHeight}px`;
        activeQuestion.style.minHeight = `${availableCardHeight}px`;
        activeQuestion.style.maxHeight = `${availableCardHeight}px`;
        boardPanX = viewport.clientWidth / 2 - (activeQuestion.offsetLeft + activeQuestion.offsetWidth / 2) * viewZoom;
        boardPanY = viewport.clientHeight / 2 - (activeQuestion.offsetTop + activeQuestion.offsetHeight / 2) * viewZoom;
        if (!hasFocused) board.style.transition = "none";
        updateBoardTransform();
        if (!hasFocused) {
            hasFocused = true;
            requestAnimationFrame(() => { board.style.transition = ""; });
        }
    };

    window.addEventListener("load", focusQuestion);
    window.addEventListener("resize", focusQuestion);

    zoomOut?.addEventListener("click", () => {
        viewZoom = Math.max(0.35, (viewZoom ?? 1) - 0.2);
        focusQuestion();
    });

    zoomIn?.addEventListener("click", () => {
        const focusZoom = focusZoomLevel();
        viewZoom = Math.min(focusZoom, (viewZoom ?? focusZoom) + 0.2);
        focusQuestion();
    });

    viewport?.addEventListener("pointerdown", (event) => {
        if (event.target.closest("form, button, a, textarea, input, select")) return;
        boardIsPanning = true;
        boardPointerX = event.clientX;
        boardPointerY = event.clientY;
        viewport.classList.add("is-panning");
        viewport.setPointerCapture(event.pointerId);
    });

    viewport?.addEventListener("pointermove", (event) => {
        if (!boardIsPanning) return;
        boardPanX += event.clientX - boardPointerX;
        boardPanY += event.clientY - boardPointerY;
        boardPointerX = event.clientX;
        boardPointerY = event.clientY;
        updateBoardTransform();
    });

    const stopBoardPanning = (event) => {
        if (!viewport || !boardIsPanning) return;
        boardIsPanning = false;
        viewport.classList.remove("is-panning");
        if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
    };

    viewport?.addEventListener("pointerup", stopBoardPanning);
    viewport?.addEventListener("pointercancel", stopBoardPanning);

    document.querySelectorAll("[data-direction]").forEach((link) => {
        link.addEventListener("click", (event) => {
            if (!viewport || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
            event.preventDefault();
            viewport.classList.add(`is-leaving-${link.dataset.direction}`);
            window.setTimeout(() => { window.location.href = link.href; }, 220);
        });

    });
