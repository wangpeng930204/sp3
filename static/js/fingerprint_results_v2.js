const chartTopFraction = 0.40;

const host = document.getElementById('fingerprint-chart');
const data = JSON.parse(document.getElementById('fingerprint-data').textContent);
const missingEvaluationDetails = data.some(row =>
    ['userId', 'user', 'confidence', 'comments'].some(field => row[field] == null));
if (missingEvaluationDetails) {
    const notice = document.createElement('p');
    notice.textContent = 'Some evaluation details are missing from the server response. Restart the app with the latest app.py, then refresh this page.';
    notice.setAttribute('role', 'status');
    Object.assign(notice.style, {
        position: 'absolute', top: '8px', left: '16px', maxWidth: '70%',
        margin: '0', padding: '10px', background: '#fff3cd', color: '#664d03', fontSize: '13px',
    });
    host.appendChild(notice);
}
data.forEach(row => {
    row.user = row.user ?? 'Name unavailable';
    row.comments = row.comments ?? 'Comments unavailable';
});
const confidenceText = row => row.confidence == null ? 'Unavailable' : `${row.confidence}%`;
const users = Array.from(d3.group(data, row => row.userId), ([id, rows]) => ({ id, name: rows[0].user }))
    .sort((a, b) => d3.ascending(a.id, b.id));
const products = Array.from(d3.group(data, row => row.productId), ([id, rows]) => ({
    id,
    name: rows[0].product,
})).sort((a, b) => d3.ascending(a.id, b.id));
// Equivalent to sns.color_palette("tab10"); repeats after ten categories.
const tab10Palette = [
    '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd',
    '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf',
];

const productShortNames = new Map(products.map((product, index) => {
    let suffix = '';
    for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) {
        suffix = String.fromCharCode(65 + (value - 1) % 26) + suffix;
    }
    return [product.id, `P${suffix}`];
}));

const criteria = Array.from(d3.group(data, row => row.criterionId), ([id, rows]) => ({
    id,
    name: rows[0].criterion,
    ratings: rows,
    products: Array.from(d3.group(rows, row => row.productId), ([productId, ratings]) => ({
        id: productId,
        name: ratings[0].product,
    })),
}));
let overviewBars;
let totalOverviewBars;
const criterionNames = new Map(criteria.map(criterion => [criterion.id, criterion.name]));
let selectedRating = data.find(row => row.userId === users[0]?.id) ?? null;
let selectedOverviewRows = null;
let confidenceMin = 0;
let confidenceMax = 100;
const svg = d3.select(host).append('svg')
    .attr('role', 'group')
    .attr('aria-label', 'Y values from 0 to 9, with evaluated products grouped by LSC criterion on the X-axis');

function getChartLayout(width, height) {
    const margin = {
        // Reserve the upper area for overview charts.
        top: height * chartTopFraction,
        // Leave a dedicated column on the right for the chart legend.
        right: Math.min(300, width * 0.2),
        bottom: Math.min(110, height * 0.26),
        left: Math.min(220, width * 0.25),
    };
    const overviewHeight = Math.min(250, height * 0.25);
    const legendWidth = Math.min(250, width * 0.2);
    const bottom = height - margin.bottom;
    const right = Math.max(margin.left + 1, width - margin.right);
    // Shared endpoint for the top boundary and horizontal axis line.
    const boundaryRight = right + legendWidth;
    return { width, height, margin, overviewHeight, legendWidth, bottom, right, boundaryRight };
}

function renderChart() {
    const width = host.clientWidth;
    const height = host.clientHeight;
    if (!width || !height) return;

    const layout = getChartLayout(width, height);
    const { margin, bottom, right } = layout;
    // Pad the scale at both ends so scores 0 and 9 clear the chart boundaries.
    const y = d3.scaleLinear().domain([-0.5, 9.5]).range([bottom, margin.top]);
    const x = d3.scaleBand().domain(criteria.map(criterion => criterion.id))
        .range([margin.left, right]).paddingInner(0.15).paddingOuter(0.05);
    const narrowestProduct = d3.min(criteria, criterion => x.bandwidth() / criterion.products.length) || 45;
    layout.markerArea = Math.PI * Math.pow(Math.max(3, Math.min(9, narrowestProduct * 0.2)), 2);
    svg.attr('width', width).attr('height', height).attr('viewBox', `0 0 ${width} ${height}`);
    svg.selectAll('*').remove();

    drawOverview(layout, x);
    drawTotalOverview(layout);
    styleBarAxes(layout);
    drawBoundaries(layout, x);
    drawAxes(layout, x, y);
    svg.append('g')
        .attr('class', 'user-connections')
        .attr('aria-hidden', 'true')
        .attr('pointer-events', 'none');
    drawRatings(layout, x, y);
    drawSelectedUserConnection();
    drawLegend(layout);
    drawOverviewSelection();
}

function bindOverviewSelection(segments) {
    segments.attr('class', 'overview-segment')
        .attr('role', 'button')
        .style('cursor', 'pointer')
        .on('click', (event, segment) => selectOverviewSegment(segment))
        .on('keydown', (event, segment) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                selectOverviewSegment(segment);
            }
        });
}

function selectOverviewSegment(segment) {
    selectedOverviewRows = selectedOverviewRows === segment.rows ? null : segment.rows;
    drawOverviewSelection();
}

function drawOverviewSelection() {
    const matchingRows = new Set(selectedOverviewRows || []);
    const isSelected = row => matchesConfidence(row) && matchingRows.has(row);
    const markers = svg.selectAll('.rating-points > circle, .rating-points > path');
    markers.classed('overview-highlight', isSelected)
        .style('fill', row => !matchesConfidence(row) ? 'none' : null)
        .style('stroke', row => !matchesConfidence(row) ? '#9ca3af' : isSelected(row) ? '#17212b' : null)
        .style('stroke-width', row => !matchesConfidence(row) ? 1.5 : isSelected(row) ? 3 : null)
        .style('pointer-events', 'all')
        .style('opacity', row => !matchesConfidence(row) ? 1
            : selectedOverviewRows === null ? null : isSelected(row) ? 1 : 0.15);
    // Bring selected markers in front of other overlapping scores.
    markers.filter(isSelected).raise();
    svg.selectAll('.overview-segment')
        .attr('aria-pressed', segment => segment.rows === selectedOverviewRows)
        .style('stroke', segment => segment.rows === selectedOverviewRows ? '#17212b' : null)
        .style('stroke-width', segment => segment.rows === selectedOverviewRows ? 2 : null);
}

function drawBoundaries({ margin, overviewHeight, bottom, right, boundaryRight }, x) {
    const dividerPositions = criteria.slice(1).map((criterion, index) =>
        (x(criteria[index].id) + x.bandwidth() + x(criterion.id)) / 2
    );
    svg.append('line')
        .attr('x1', margin.left)
        .attr('x2', boundaryRight)
        .attr('y1', margin.top)
        .attr('y2', margin.top)
        .attr('class', 'chart-top-line chart-boundary');
    svg.append('line')
        .attr('class', 'chart-right-line chart-boundary')
        .attr('x1', right)
        .attr('x2', right)
        .attr('y1', margin.top - overviewHeight)
        .attr('y2', bottom);
    svg.append('g')
        .attr('class', 'criterion-dividers')
        .attr('stroke', '#cbd5e1')
        .selectAll('line')
        .data(dividerPositions)
        .join('line')
        .attr('x1', position => position)
        .attr('x2', position => position)
        .attr('y1', margin.top - overviewHeight)
        .attr('y2', bottom);
}

function drawAxes({ margin, bottom, boundaryRight, axisBottom = bottom }, x, y) {
    svg.append('text').attr('class', 'axis-title')
        .attr('transform', `translate(${margin.left - 48},${(margin.top + bottom) / 2}) rotate(-90)`)
        .attr('text-anchor', 'middle').text('Individual rating');
    svg.append('g')
        .attr('class', 'axis')
        .attr('transform', `translate(${margin.left},0)`)
        .call(d3.axisLeft(y).tickValues(d3.range(10)).tickFormat(d3.format('d')).tickSize(0).tickPadding(9))
        .select('.domain')
        .attr('stroke', '#999')
        .attr('stroke-dasharray', '5 5');
    const horizontalAxis = svg.append('g')
        .attr('class', 'axis')
        .attr('transform', `translate(0,${axisBottom})`)
        .call(d3.axisBottom(x).tickSize(0).tickPadding(30)
            .tickFormat(id => criterionNames.get(id)));
    horizontalAxis.select('.domain')
        .classed('chart-boundary', true)
        .attr('d', `M${margin.left},0.5H${boundaryRight}`);
    svg.selectAll('.chart-boundary')
        .attr('stroke', '#17212b')
        .attr('stroke-width', 2)
        .attr('stroke-linecap', 'square');
    const maxLines = Math.max(1, Math.floor((margin.bottom - 36) / 16));
    horizontalAxis.selectAll('.tick text')
        .attr('fill', '#17212b')
        .style('font-weight', 600)
        .each(function () {
            wrapLabel(this, x.bandwidth(), maxLines);
        });
}

function wrapLabel(node, availableWidth, maxLines) {
    const label = d3.select(node);
    const words = label.text().split(/\s+/);
    label.text(null);
    let line = '';
    let span = label.append('tspan').attr('x', 0).attr('dy', '0em');
    let lines = 1;
    words.forEach(word => {
        const next = line ? `${line} ${word}` : word;
        span.text(next);
        if (line && span.node().getComputedTextLength() > availableWidth && lines < maxLines) {
            lines += 1;
            span.text(line);
            span = label.append('tspan').attr('x', 0).attr('dy', '1.2em').text(word);
            line = word;
        } else {
            line = next;
        }
    });
    label.selectAll('tspan').each(function () { fitLabel(this, availableWidth); });
    label.append('title').text(words.join(' '));
}

// Average this user's available confidence values within the active filter range.
function averageUserConfidence(userId) {
    const values = data.filter(row => row.userId === userId && matchesConfidence(row) &&
        typeof row.confidence === 'number' && Number.isFinite(row.confidence))
        .map(row => row.confidence);
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function drawUserSummary(container) {
    const summary = container.append('div').attr('class', 'user-summary')
        .attr('role', 'status').attr('aria-live', 'polite').attr('aria-atomic', 'true')
        .style('min-height', '90px')
        .style('box-sizing', 'border-box').style('overflow-y', 'auto')
        .style('margin-top', '12px').style('padding', '8px 0')
        .style('line-height', '1.5').style('overflow-wrap', 'anywhere');
    summary.append('div').style('font-weight', '600').style('margin-bottom', '8px')
        .text('Confidence summary');
    summary.append('div').attr('class', 'user-summary-name').style('font-weight', '600');
    summary.append('div').attr('class', 'user-summary-confidence')
        .attr('title', 'Average across evaluations for this user within the selected confidence range. Missing confidence values are excluded.');
    updateUserSummary();
}

function updateUserSummary() {
    const summary = svg.select('.user-summary');
    summary.select('.user-summary-name')
        .text(selectedRating === null ? '' : selectedRating.user);
    const average = selectedRating === null ? null : averageUserConfidence(selectedRating.userId);
    summary.select('.user-summary-confidence').text(selectedRating === null
        ? 'Select a point in Scale to view confidence.'
        : `Average confidence: ${average === null ? 'No evaluations in range' : `${average.toFixed(1)}%`}`);
}

function selectRatingUser(row) {
    selectedRating = selectedRating !== null && selectedRating.userId === row.userId ? null : row;
    drawSelectedUserConnection();
    updateUserSummary();
}

function matchesConfidence(row) {
    // Preserve unavailable confidence only while the full range is selected.
    return row.confidence == null ? confidenceMin === 0 && confidenceMax === 100
        : row.confidence >= confidenceMin && row.confidence <= confidenceMax;
}

function updateConfidenceFilter(layout) {
    const filtered = data.filter(matchesConfidence);
    overviewBars = buildOverviewBars(criteria.map(criterion => ({
        ...criterion, ratings: criterion.ratings.filter(matchesConfidence),
    })));
    totalOverviewBars = buildOverviewBars([{ id: null, ratings: filtered }]);
    selectedOverviewRows = null;
    svg.selectAll('.overview, .total-overview').remove();
    const x = d3.scaleBand().domain(criteria.map(criterion => criterion.id))
        .range([layout.margin.left, layout.right]).paddingInner(0.15).paddingOuter(0.05);
    drawOverview(layout, x);
    drawTotalOverview(layout);
    styleBarAxes(layout);
    drawOverviewSelection();
    drawSelectedUserConnection();
    updateUserSummary();
}

function drawConfidenceFilter(container, layout) {
    const panel = container.append('div').style('flex', '0 0 auto')
        .style('padding-top', '10px').style('border-top', '1px solid #cbd5e1');
    panel.append('div').attr('class', 'confidence-filter-title')
        .text('Select Confidence Range: ');
    const width = Math.max(40, layout.legendWidth);
    const scale = d3.scaleLinear().domain([0, 100]).range([10, width - 10]).clamp(true);
    const track = panel.append('svg:svg').attr('width', width).attr('height', 40)
        .style('display', 'block').style('touch-action', 'none');
    track.append('line').attr('x1', scale(0)).attr('x2', scale(100))
        .attr('y1', 20).attr('y2', 20).attr('stroke', '#cbd5e1').attr('stroke-width', 4);
    const selected = track.append('line').attr('y1', 20).attr('y2', 20)
        .attr('stroke', '#08739d').attr('stroke-width', 4);
    const handles = track.selectAll('circle').data(['min', 'max']).join('circle')
        .attr('cy', 20).attr('r', 8).attr('fill', '#fff')
        .attr('stroke', '#08739d').attr('stroke-width', 2)
        .attr('tabindex', 0).attr('role', 'slider').attr('aria-orientation', 'horizontal')
        .attr('aria-label', bound => `${bound === 'min' ? 'Minimum' : 'Maximum'} confidence`)
        .style('cursor', 'ew-resize');
    const labels = panel.append('div')
        .style('display', 'flex').style('justify-content', 'space-between')
        .style('font-size', '12px');
    const minLabel = labels.append('span');
    const maxLabel = labels.append('span');
    function refresh() {
        minLabel.text(`${confidenceMin}%`);
        maxLabel.text(`${confidenceMax}%`);
        selected.attr('x1', scale(confidenceMin)).attr('x2', scale(confidenceMax));
        handles.attr('cx', bound => scale(bound === 'min' ? confidenceMin : confidenceMax))
            .attr('aria-valuemin', bound => bound === 'min' ? 0 : confidenceMin)
            .attr('aria-valuemax', bound => bound === 'min' ? confidenceMax : 100)
            .attr('aria-valuenow', bound => bound === 'min' ? confidenceMin : confidenceMax)
            .attr('aria-valuetext', bound => `${bound === 'min' ? confidenceMin : confidenceMax}%`);
    }
    function change(bound, value) {
        value = Math.max(0, Math.min(100, Math.round(value)));
        if (bound === 'min') confidenceMin = Math.min(value, confidenceMax);
        else confidenceMax = Math.max(value, confidenceMin);
        refresh();
        updateConfidenceFilter(layout);
    }
    handles.call(d3.drag().on('drag', (event, bound) => change(bound, scale.invert(event.x))))
        .on('keydown', (event, bound) => {
            let value = bound === 'min' ? confidenceMin : confidenceMax;
            if (['ArrowLeft', 'ArrowDown'].includes(event.key)) value -= 1;
            else if (['ArrowRight', 'ArrowUp'].includes(event.key)) value += 1;
            else if (event.key === 'Home') value = bound === 'min' ? 0 : confidenceMin;
            else if (event.key === 'End') value = bound === 'min' ? confidenceMax : 100;
            else return;
            event.preventDefault();
            change(bound, value);
        });
    refresh();
    if (data.some(row => row.confidence == null)) {
        panel.append('div').style('font-size', '12px')
            .text('Unknown confidence included only at 0?100%.');
    }
    drawUserSummary(panel);
}

function fitLabel(node, availableWidth) {
    const label = d3.select(node);
    let text = label.text();
    while (text.length && node.getComputedTextLength() > Math.max(0, availableWidth)) {
        text = text.slice(0, -1);
        label.text(text ? `${text}…` : '');
    }
}

// Start only after the scales and renderers are initialized.
function startChart() {
    overviewBars = buildOverviewBars(criteria);
    totalOverviewBars = buildOverviewBars([{ id: null, ratings: data }]);
    renderChart();
    new ResizeObserver(renderChart).observe(host);
}

// User colors, product shapes, and confidence-based marker sizes.
const userColor = d3.scaleOrdinal().domain(users.map(user => user.id))
    .range(tab10Palette);
const productShape = d3.scaleOrdinal().domain(products.map(product => product.id))
    .range([d3.symbolTriangle, d3.symbolSquare, d3.symbolCircle,
        d3.symbolDiamond, d3.symbolCross, d3.symbolStar, d3.symbolWye]);
// Scale symbol area linearly; keep 0% visible. Unknown confidence uses the minimum size.
const confidenceArea = d3.scaleLinear().domain([0, 100]).range([0.12, 1]).clamp(true);
function markerSize(confidence, maxArea) {
    return confidenceArea(confidence ?? 0) * maxArea;
}

// Each confidence group contributes its sum of ratings to the product's stack.
function buildOverviewBars(criteria) {
    return criteria.flatMap(criterion =>
        Array.from(d3.group(criterion.ratings, row => row.productId), ([productId, ratings]) => {
            // Stack highest confidence at the bottom; unknown confidence goes on top.
            const groups = Array.from(d3.group(ratings, row => row.confidence ?? null))
                .sort(([a], [b]) => a === b ? 0 : a === null ? 1 : b === null ? -1 : b - a);
            let total = 0;
            const segments = groups.flatMap(([confidence, rows]) =>
                Array.from(d3.group(rows, row => row.userId))
                    .sort(([a], [b]) => d3.ascending(a, b))
                    .map(([userId, ratings]) => {
                        const value = d3.sum(ratings, row => row.value);
                        const start = total;
                        total += value;
                        return { confidence, rows: ratings, userId, user: ratings[0].user,
                            value, count: ratings.length, start, end: total };
                    })
            );
            return { criterionId: criterion.id, productId, product: ratings[0].product, segments, total };
        })
    );
}

// Blocks are adjacent along X, ordered by confidence, with heights measured from zero.
function horizontalSegments(bar) {
    let total = 0;
    return bar.segments.map(segment => {
        const start = total;
        total += segment.value;
        return { ...segment, start, end: total };
    });
}

function styleBarAxes(layout) {
    // Keep value and product labels while hiding Global axis strokes.
    svg.selectAll('.total-overview .axis line').remove();
    svg.selectAll('.overview .domain, .total-overview .domain').attr('stroke', 'none');
    svg.selectAll('.overview .axis, .total-overview .axis').attr('color', '#17212b');
    svg.selectAll('.overview .tick line, .total-overview .tick line')
        .attr('stroke', '#17212b').attr('stroke-width', 2);
    svg.selectAll('.overview .axis:not(.shared-confidence-axis) line').remove();
}

function drawOverview(layout, x) {
    drawHorizontalOverview(layout, overviewBars,
        bar => ({ left: x(bar.criterionId), width: x.bandwidth() }), 'overview');
}

function drawTotalOverview(layout) {
    drawHorizontalOverview(layout, totalOverviewBars,
        () => ({ left: layout.right + 4, width: layout.legendWidth + 10 }), 'total-overview');
}

// Direction keys describe the encoding without adding axes to individual bars.
function drawOverviewDirections(parent, left, right, top, bottom, ratingLabel, inset = 0) {
    if (svg.select('#overview-direction-arrow').empty()) {
        svg.append('defs').append('marker').attr('id', 'overview-direction-arrow')
            .attr('viewBox', '0 0 8 8').attr('refX', 7).attr('refY', 4)
            .attr('markerWidth', 5).attr('markerHeight', 5).attr('orient', 'auto')
            .append('path').attr('d', 'M0,0 L8,4 L0,8 Z').attr('fill', '#17212b');
    }
    const start = left + inset + 8;
    const end = right - 8;
    const arrowX = left + inset - 12;
    const arrowY = bottom + 8;
    const key = parent.append('g').attr('class', 'overview-directions')
        .attr('aria-label', `Confidence increases upward; ${ratingLabel} increases rightward`);
    key.append('g').attr('stroke', '#17212b').attr('stroke-width', 2)
        .selectAll('line').data([
            { x1: arrowX, y1: bottom - 4, x2: arrowX, y2: top + 4 },
            { x1: start, y1: arrowY, x2: end, y2: arrowY },
        ]).join('line').attr('x1', d => d.x1).attr('y1', d => d.y1)
        .attr('x2', d => d.x2).attr('y2', d => d.y2)
        .attr('marker-end', 'url(#overview-direction-arrow)');
    key.append('text').attr('class', 'axis-title').attr('fill', '#17212b')
        .attr('transform', `translate(${arrowX - 8},${(top + bottom) / 2}) rotate(-90)`)
        .attr('text-anchor', 'middle').text('Confidence')
        .each(function () { fitLabel(this, bottom - top); });
    key.append('text').attr('class', 'axis-title').attr('fill', '#17212b')
        .attr('x', (start + end) / 2).attr('y', arrowY + 14)
        .attr('text-anchor', 'middle').text(ratingLabel)
        .each(function () { fitLabel(this, right - left - inset - 8); });
}

function drawHorizontalOverview({ margin, overviewHeight, right, legendWidth }, bars, panelFor, className) {
    const top = margin.top - overviewHeight;
    const rowHeight = overviewHeight / Math.max(1, products.length);
    const maximum = d3.max(bars, bar => bar.total) || 1;

    const overview = svg.append('g').attr('class', className);
    // One shared confidence axis per product row serves every overview panel.
    if (className === 'overview') {
        products.forEach((product, index) => {
            const rowTop = top + index * rowHeight;
            overview.append('text').attr('class', 'shared-product-label')
                .attr('x', margin.left - 48).attr('y', rowTop + rowHeight * 0.35)
                .attr('text-anchor', 'end').attr('dominant-baseline', 'middle')
                .attr('font-size', 12).attr('fill', '#17212b')
                .text(productShortNames.get(product.id))
                .attr('aria-label', product.name)
                .each(function () { fitLabel(this, Math.max(0, margin.left - 64)); })
                .append('title').text(product.name);
        });
    }
    bars.forEach(bar => {
        const { left, width } = panelFor(bar);
        const rowIndex = products.findIndex(product => product.id === bar.productId);
        const rowTop = top + rowIndex * rowHeight;
        const baseline = rowTop + rowHeight * 0.7;
        const inset = className === 'total-overview' ? 36 : 0;
        const ratingX = d3.scaleLinear().domain([0, maximum]).nice()
            .range([left + inset + 4, left + Math.max(inset + 5, width - 8)]);
        const confidenceY = d3.scaleLinear().domain([0, 100]).clamp(true)
            .range([baseline, rowTop + 4]);
        const group = overview.append('g');
        if (className === 'total-overview' || bar.criterionId === criteria[0]?.id) {
            drawOverviewDirections(group, left, left + width, rowTop + 4, baseline,
                className === 'overview' ? 'Group Rating' : 'Overall Rating', inset);
        }
        group.selectAll('rect').data(horizontalSegments(bar)).join('rect')
            .attr('x', segment => ratingX(segment.start))
            .attr('y', segment => confidenceY(segment.confidence ?? 0))
            .attr('width', segment => ratingX(segment.end) - ratingX(segment.start))
            .attr('height', segment => baseline - confidenceY(segment.confidence ?? 0))
            .attr('fill', segment => userColor(segment.userId))
            .attr('stroke', '#17212b').attr('stroke-width', 0.5)
            .attr('tabindex', 0).attr('role', 'img')
            .attr('aria-label', segment => overviewSegmentText(bar, segment))
            .call(bindOverviewSelection)
            .append('title').text(segment => overviewSegmentText(bar, segment));
    });
}

function overviewSegmentText(bar, segment) {
    return `${bar.criterionId === null ? 'All criteria' : criterionNames.get(bar.criterionId)} / ${bar.product}, User: ${segment.user}, Confidence: ${confidenceText(segment)}, Sum of ratings: ${segment.value}, Ratings: ${segment.count}`;
}

function drawRatings({ bottom, markerArea }, x, y) {
    criteria.forEach(criterion => {
        const productX = d3.scaleBand().domain(criterion.products.map(product => product.id))
            .range([x(criterion.id), x(criterion.id) + x.bandwidth()]);
        const ratingOffsets = new Map();
        // Center each score on its bar; fan out only ratings sharing that score.
        d3.group(criterion.ratings, row => row.productId, row => row.value)
            .forEach(scores => scores.forEach(rows => {
                const step = Math.min(15, productX.bandwidth() * 0.6 / Math.max(1, rows.length - 1));
                rows.forEach((row, index) => {
                    ratingOffsets.set(row, (index - (rows.length - 1) / 2) * step);
                });
            }));

        svg.append('g').attr('class', 'rating-points')
            .selectAll('path').data(criterion.ratings)
            .join('path')
            .attr('class', 'rating-marker')
            .attr('data-x', row => productX(row.productId) + productX.bandwidth() / 2 + ratingOffsets.get(row))
            .attr('data-y', row => y(row.value))
            .attr('transform', function () {
                return `translate(${this.getAttribute('data-x')},${this.getAttribute('data-y')})`;
            })
            .attr('d', d3.symbol().type(row => productShape(row.productId))
                .size(row => markerSize(row.confidence, markerArea)))
            .attr('fill', row => userColor(row.userId))
            .attr('stroke', row => userColor(row.userId)).attr('stroke-width', 1)
            .attr('tabindex', 0)
            .attr('role', 'button')
            .style('cursor', 'pointer')
            .on('click', (event, row) => selectRatingUser(row))
            .on('keydown', (event, row) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    selectRatingUser(row);
                }
            })
            .attr('aria-label', row => `Product: ${row.product}, User: ${row.user}, Rating: ${row.value} / 9, Confidence: ${confidenceText(row)}, Comments: ${row.comments || 'No comments'}`)
            .call(attachRatingTooltip, confidenceText);
        svg.append('g')
            .attr('fill', '#17212b')
            .attr('font-size', 12)
            .attr('text-anchor', 'middle')
            .selectAll('text')
            .data(criterion.products)
            .join('text')
            .attr('x', product => productX(product.id) + productX.bandwidth() / 2)
            .attr('y', bottom + 15)
            .text(product => productShortNames.get(product.id))
            .attr('aria-label', product => product.name)
            .each(function () { fitLabel(this, productX.bandwidth() - 4); })
            .append('title').text(product => product.name);
    });
}

function drawSelectedUserConnection() {
    const dots = svg.selectAll('.rating-points .rating-marker');
    dots.attr('aria-pressed', row => selectedRating !== null && row.userId === selectedRating.userId);

    // Group rendered centers by product, including product and user offsets.
    const pointsByProduct = new Map();
    if (selectedRating !== null) {
        dots.filter(row => row.userId === selectedRating.userId && matchesConfidence(row))
            .each(function (row) {
                if (!pointsByProduct.has(row.productId)) {
                    pointsByProduct.set(row.productId, []);
                }
                pointsByProduct.get(row.productId).push([
                    Number(this.getAttribute('data-x')),
                    Number(this.getAttribute('data-y')),
                ]);
            });
    }
    const connections = Array.from(pointsByProduct, ([productId, points]) => ({
        productId,
        points: points.sort((a, b) => a[0] - b[0]),
    })).filter(connection => connection.points.length > 1);
    const line = d3.line();

    svg.select('.user-connections').selectAll('path')
        .data(connections, connection => connection.productId)
        .join('path')
        .attr('d', connection => line(connection.points))
        .attr('fill', 'none')
        .attr('stroke', selectedRating === null ? 'none' : userColor(selectedRating.userId))
        .attr('stroke-width', 2)
        .attr('stroke-linejoin', 'round')
        .attr('stroke-linecap', 'round');
}

function drawLegend(layout) {
    const { margin, right, bottom, legendWidth, markerArea } = layout;
    const legendTop = margin.top + 20;
    const legendContainer = svg.append('foreignObject')
        .attr('x', right + 14).attr('y', legendTop)
        .attr('width', legendWidth)
        .attr('height', Math.max(1, bottom - legendTop))
        .append('xhtml:div')
        .style('height', '100%').style('display', 'flex').style('flex-direction', 'column')
        .style('font-size', '12px').style('color', '#17212b');
    const legend = legendContainer.append('div')
        .style('flex', '1 1 auto').style('min-height', '0').style('overflow-y', 'auto');
    drawConfidenceFilter(legendContainer, layout);
    products.forEach(product => {
        const row = legend.append('div').style('margin-top', '12px');
        row.append('div').style('font-weight', '600')
            .style('overflow-wrap', 'anywhere').text(product.name);
        const keyWidth = Math.max(60, legendWidth - 16);
        const startX = 15;
        const endX = keyWidth - 15;
        const key = row.append('svg:svg').attr('width', keyWidth).attr('height', 50)
            .attr('role', 'img')
            .attr('aria-label', `${product.name}: smaller shape means 0% confidence, larger shape means 100% confidence`);
        key.append('line').attr('x1', startX).attr('x2', endX)
            .attr('y1', 18).attr('y2', 18)
            .attr('stroke', '#94a3b8').attr('stroke-width', 1);
        key.append('text').attr('x', (startX + endX) / 2).attr('y', 44)
            .attr('text-anchor', 'middle').attr('font-size', 12).attr('fill', '#17212b')
            .text('confidence');
        [0, 100].forEach(confidence => {
            const position = confidence === 0 ? startX : endX;
            key.append('path').attr('transform', `translate(${position},18)`)
                .attr('d', d3.symbol().type(productShape(product.id))
                    .size(markerSize(confidence, markerArea))())
                .attr('fill', '#17212b').attr('stroke', '#475569').attr('stroke-width', 1);
            key.append('text').attr('x', position).attr('y', 44)
                .attr('text-anchor', 'middle').attr('font-size', 12).attr('fill', '#17212b')
                .text(`${confidence}%`);
        });
    });
    legend.append('div').style('font-weight', '700').style('margin-top', '20px').text('Users');
    const userLegend = legend.append('div').attr('class', 'user-legend')
        .style('display', 'flex').style('flex-wrap', 'wrap').style('gap', '8px 14px')
        .style('margin-top', '10px');
    users.forEach(user => {
        const row = userLegend.append('div').style('display', 'flex').style('align-items', 'center')
            .style('gap', '6px').style('max-width', '100%');
        row.append('span').style('flex', '0 0 12px').style('height', '12px')
            .style('border-radius', '50%').style('background', userColor(user.id));
        row.append('span').style('overflow-wrap', 'anywhere').text(user.name);
    });
    if (data.some(row => row.confidence == null)) {
        legend.append('div').style('margin-top', '16px')
            .text('Unavailable confidence uses the smallest marker; see rating details.');
    }
}

startChart();
