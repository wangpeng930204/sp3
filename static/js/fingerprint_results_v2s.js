const chartTopFraction = 0.30;

const host = document.getElementById('fingerprint-chart');
// Keep overview dimensions stable when the lower area grows to fit the legend.
const initialChartHeight = host.clientHeight;
const data = JSON.parse(document.getElementById('fingerprint-data').textContent);
const missingEvaluationDetails = data.some(row =>
    ['userId', 'user', 'comments'].some(field => row[field] == null));
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
let selectedRating = null;
let selectedOverviewRows = null;
const svg = d3.select(host).append('svg')
    .attr('role', 'group')
    .attr('aria-label', 'Y values from 0 to 9, with evaluated products grouped by LSC criterion on the X-axis');

function getChartLayout(width, height) {
    const overviewCanvasHeight = Math.min(height, initialChartHeight);
    const margin = {
        // Reserve the upper area for overview charts.
        top: overviewCanvasHeight * chartTopFraction,
        // Leave a dedicated column on the right for the chart legend.
        right: Math.max(278, Math.min(300, width * 0.2)),
        bottom: Math.min(110, height * 0.26),
        left: Math.min(100, width * 0.12),
    };
    // Fit the overview into the initial canvas before growing the panel.
    // Keep enough room per row for the bars and their two-line axis labels.
    const overviewBudget = Math.max(0, overviewCanvasHeight - 440 - margin.bottom - 24);
    const preferredOverviewHeight = Math.max(products.length * 100, Math.min(250, overviewCanvasHeight * 0.2));
    const overviewHeight = Math.max(products.length * 64, Math.min(preferredOverviewHeight, overviewBudget));
    margin.top = Math.max(margin.top, overviewHeight + 24);
    const legendWidth = Math.min(250, margin.right - 28);
    // Give the scale distribution a useful minimum height even with many products.
    height = Math.max(height, margin.top + 440 + margin.bottom);
    const bottom = height - margin.bottom;
    const right = Math.max(margin.left + 1, width - margin.right);
    // Shared endpoint for the top boundary and horizontal axis line.
    const boundaryRight = right + legendWidth;
    return { width, height, margin, overviewHeight, legendWidth, bottom, right, boundaryRight };
}

function renderChart() {
    const width = host.clientWidth;
    let height = host.clientHeight;
    if (!width || !height) return;

    const layout = getChartLayout(width, height);
    height = layout.height;
    if (host.clientHeight < height) host.style.height = `${height}px`;
    const { margin, bottom, right } = layout;
    // Pad the scale at both ends so scores 0 and 9 clear the chart boundaries.
    // Add breathing room inside Scale without moving panel borders.
    const y = d3.scaleLinear().domain([-0.5, 9.5]).range([bottom, margin.top + 40]);
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
    const isSelected = row => matchingRows.has(row);
    const markers = svg.selectAll('.rating-points > circle, .rating-points > path');
    markers.classed('overview-highlight', isSelected)
        .style('stroke', row => isSelected(row) ? '#17212b' : null)
        .style('stroke-width', row => isSelected(row) ? 3 : null)
        .style('pointer-events', 'all')
        .style('opacity', row => selectedOverviewRows === null ? null : isSelected(row) ? 1 : 0.15);
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
    svg.append('text').attr('class', 'axis-title individual-rating-title')
        .attr('transform', `translate(${margin.left - 48},${(margin.top + bottom) / 2}) rotate(-90)`)
        .attr('text-anchor', 'middle').text('Individual Rating');
    svg.append('g')
        .attr('class', 'axis')
        .attr('transform', `translate(${margin.left},0)`)
        .call(d3.axisLeft(y).tickValues(d3.range(10)).tickFormat(d3.format('d')).tickSize(0).tickPadding(9))
        .select('.domain')
        // Keep the dashed axis full-height while the plotted scale has top padding.
        .attr('d', `M0.5,${bottom}V${margin.top}`)
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
    svg.append('text').attr('class', 'axis-title criteria-axis-title')
        .attr('x', (x.range()[0] + x.range()[1]) / 2)
        .attr('y', axisBottom + margin.bottom - 35)
        .attr('text-anchor', 'middle').attr('fill', '#17212b')
        .text('Leading Sustainability Criteria');
    // Reserve room below wrapped criterion names for the axis title.
    const maxLines = Math.max(1, Math.floor((margin.bottom - 60) / 16));
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

// Average all valid ratings for the selected user.
function averageUserRating(userId) {
    const values = data.filter(row => row.userId === userId &&
        typeof row.value === 'number' && Number.isFinite(row.value))
        .map(row => row.value);
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function drawUserSummary(container) {
    container.append('div').attr('class', 'legend-heading')
        .style('font-weight', '600').style('margin-top', '8px').style('margin-bottom', '4px')
        .text('User Summary:');
    const summary = container.append('div').attr('class', 'user-summary')
        .attr('role', 'status').attr('aria-live', 'polite').attr('aria-atomic', 'true')
        .style('min-height', '66px')
        .style('box-sizing', 'border-box')
        .style('padding', '8px')
        .style('line-height', '1.5').style('overflow-wrap', 'anywhere');
    summary.append('div').attr('class', 'user-summary-name').style('font-weight', '600');
    summary.append('div').attr('class', 'user-summary-rating')
        .attr('title', 'Average rating across evaluations for this user. Missing ratings are excluded.');
    updateUserSummary();
}

function updateUserSummary() {
    const summary = svg.select('.user-summary');
    summary.select('.user-summary-name')
        .text(selectedRating === null ? 'User: -' : `User: ${selectedRating.user}`);
    const averageRating = selectedRating === null ? null : averageUserRating(selectedRating.userId);
    summary.select('.user-summary-rating').text(selectedRating === null
        ? 'Average rating: -'
        : `Average rating: ${averageRating === null ? 'No evaluations' : averageRating.toFixed(1)}`);

}

function deselectUserOnBackground(event) {
    if (selectedRating === null || !event.target.matches(
        'body, #fingerprint-frame, #fingerprint-chart, #fingerprint-chart > svg, .chart-panels, .chart-panels *'
    )) return;
    selectedRating = null;
    drawSelectedUserConnection();
    updateUserSummary();
}

function selectRatingUser(row) {
    selectedRating = selectedRating !== null && selectedRating.userId === row.userId ? null : row;
    drawSelectedUserConnection();
    updateUserSummary();
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
    document.addEventListener('click', deselectUserOnBackground);
    overviewBars = buildOverviewBars(criteria);
    totalOverviewBars = buildOverviewBars([{ id: null, ratings: data }]);
    renderChart();
    new ResizeObserver(renderChart).observe(host);
}

// User colors and fixed-size product shapes.
const userColor = d3.scaleOrdinal().domain(users.map(user => user.id))
    .range(tab10Palette);
const productShape = d3.scaleOrdinal().domain(products.map(product => product.id))
    .range([d3.symbolTriangle, d3.symbolSquare, d3.symbolCircle,
        d3.symbolDiamond, d3.symbolCross, d3.symbolStar, d3.symbolWye]);
// Sum ratings by product and user.
function buildOverviewBars(criteria) {
    return criteria.flatMap(criterion =>
        Array.from(d3.group(criterion.ratings, row => row.productId), ([productId, ratings]) => {
            const total = d3.sum(ratings, row => row.value);
            let offset = 0;
            const segments = Array.from(d3.group(ratings, row => row.userId))
                .sort(([a], [b]) => d3.ascending(a, b))
                .map(([userId, rows]) => {
                    const value = d3.sum(rows, row => row.value);
                    const start = offset;
                    offset += value;
                    return { rows, userId, user: rows[0].user, value, count: rows.length, start, end: offset };
                });
            return { criterionId: criterion.id, productId, product: ratings[0].product, segments, total };
        })
    );
}

// Blocks are adjacent along X, ordered by user, with equal heights.
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
    svg.selectAll('.overview .axis line').remove();
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
    const arrowY = bottom + 6;
    const key = parent.append('g').attr('class', 'overview-directions')
        .attr('aria-label', `${ratingLabel} increases rightward`);
    key.append('g').attr('stroke', '#17212b').attr('stroke-width', 2)
        .selectAll('line').data([
            { x1: start, y1: arrowY, x2: end, y2: arrowY },
        ]).join('line').attr('x1', d => d.x1).attr('y1', d => d.y1)
        .attr('x2', d => d.x2).attr('y2', d => d.y2)
        .attr('marker-end', 'url(#overview-direction-arrow)');
    const label = key.append('text').attr('class', 'axis-title').attr('fill', '#17212b')
        .attr('x', (start + end) / 2).attr('y', arrowY + 12)
        .attr('text-anchor', 'middle').text(ratingLabel);
    if (label.node().getComputedTextLength() > end - start) {
        label.text(null).selectAll('tspan').data(ratingLabel.split(' ')).join('tspan')
            .attr('x', (start + end) / 2).attr('dy', (_, index) => index ? 12 : 0)
            .text(word => word);
    }
    label.append('title').text(ratingLabel);
}

function drawHorizontalOverview({ margin, overviewHeight, right, legendWidth }, bars, panelFor, className) {
    const top = margin.top - overviewHeight;
    const rowHeight = overviewHeight / Math.max(1, products.length);
    const barHeight = Math.max(1, (rowHeight - 40) * 2 / 3);
    const maximum = d3.max(bars, bar => bar.total) || 1;

    const overview = svg.append('g').attr('class', className);
    // One product label per row serves every overview panel.
    if (className === 'overview') {
        products.forEach((product, index) => {
            const rowTop = top + index * rowHeight;
            overview.append('text').attr('class', 'shared-product-label')
                .attr('x', margin.left - 48).attr('y', rowTop + rowHeight - 36 - barHeight / 2)
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
        // Reserve 36px for the arrow, two compact label lines, and border clearance.
        const baseline = rowTop + rowHeight - 36;
        const inset = className === 'total-overview' ? 36 : 0;
        const ratingX = d3.scaleLinear().domain([0, maximum]).nice()
            .range([left + inset + 4, left + Math.max(inset + 5, width - 8)]);
        const group = overview.append('g');
        if (className === 'total-overview' || bar.criterionId === criteria[0]?.id) {
            drawOverviewDirections(group, left, left + width, rowTop + 4, baseline,
                className === 'overview' ? 'Group Rating' : 'Overall Rating', inset);
        }
        group.selectAll('rect').data(horizontalSegments(bar)).join('rect')
            .attr('x', segment => ratingX(segment.start))
            .attr('y', baseline - barHeight)
            .attr('width', segment => ratingX(segment.end) - ratingX(segment.start))
            .attr('height', barHeight)
            .attr('fill', segment => userColor(segment.userId))
            .attr('stroke', '#17212b').attr('stroke-width', 0.5)
            .attr('tabindex', 0).attr('role', 'img')
            .attr('aria-label', segment => overviewSegmentText(bar, segment))
            .call(bindOverviewSelection)
            .append('title').text(segment => overviewSegmentText(bar, segment));
    });
}

function overviewSegmentText(bar, segment) {
    return `${bar.criterionId === null ? 'All criteria' : criterionNames.get(bar.criterionId)} / ${bar.product}, User: ${segment.user}, Sum of ratings: ${segment.value}, Ratings: ${segment.count}`;
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
                .size(markerArea))
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
            .attr('aria-label', row => `Product: ${row.product}, User: ${row.user}, Rating: ${row.value} / 9, Comments: ${row.comments || 'No comments'}`)
            .call(attachRatingTooltip);
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
        dots.filter(row => row.userId === selectedRating.userId)
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
    const legendTop = margin.top + 8;
    const legendBottomMargin = 20;
    const legendHeight = Math.max(1, bottom - legendTop - legendBottomMargin);
    const legendContainer = svg.append('foreignObject').attr('class', 'chart-legend')
        .attr('x', right + 14).attr('y', legendTop)
        .attr('width', legendWidth)
        .attr('height', legendHeight)
        .append('xhtml:div')
        .style('min-height', `${legendHeight}px`).style('transform-origin', 'top left')
        .style('display', 'flex').style('flex-direction', 'column')
        .style('justify-content', 'space-between').style('gap', '8px')
        .style('box-sizing', 'border-box').style('padding-bottom', '4px')
        .style('font-size', '12px').style('color', '#17212b');
    legendContainer.style('width', `${legendWidth}px`);
    // Like V1, keep product keys together at their natural height.
    // Distribute spare space between sections, never between individual products.
    const legend = legendContainer.append('div')
        .style('flex', '0 0 auto').style('line-height', '1.5')
        .style('display', 'flex').style('flex-direction', 'column').style('gap', '12px');
    const productLegend = legend.append('div').attr('class', 'product-legend')
        .style('display', 'flex').style('flex-direction', 'column').style('gap', '12px');
    products.forEach(product => {
        const row = productLegend.append('div').style('flex', '0 0 auto');
        row.append('div').attr('class', 'legend-heading').style('font-weight', '600')
            .style('overflow-wrap', 'anywhere').text(product.name);
        const key = row.append('svg:svg').attr('width', legendWidth).attr('height', 28)
            .attr('role', 'img').attr('aria-label', `${product.name}: product shape`);
        key.append('path').attr('transform', 'translate(26,14)')
            .attr('d', d3.symbol().type(productShape(product.id)).size(markerArea)())
            .attr('fill', '#17212b').attr('stroke', '#475569').attr('stroke-width', 1);
    });
    const userSection = legend.append('div').style('flex', '0 0 auto');
    userSection.append('div').attr('class', 'legend-heading').style('font-weight', '700').text('Users');
    const userLegend = userSection.append('div').attr('class', 'user-legend legend-inset')
        .style('display', 'flex').style('flex-wrap', 'wrap').style('gap', '4px 12px')
        .style('margin-top', '4px');
    users.forEach(user => {
        const row = userLegend.append('div').style('display', 'flex').style('align-items', 'center')
            .style('gap', '6px').style('max-width', '100%');
        row.append('span').style('flex', '0 0 12px').style('height', '12px')
            .style('border-radius', '50%').style('background', userColor(user.id));
        row.append('span').style('overflow-wrap', 'anywhere').text(user.name);
    });
    const summarySection = legendContainer.append('div').style('flex', '0 0 auto');
    drawUserSummary(summarySection);
    fitLegendContent(legendContainer.node(), legendHeight);
}

let legendContentObserver;
function fitLegendContent(content, availableHeight) {
    // Preserve normal font and marker sizes whenever the natural layout fits.
    // For unusually long content, scale the whole legend rather than clip or scroll it.
    const fit = () => {
        const scale = Math.min(1, availableHeight / Math.max(1, content.scrollHeight));
        content.style.transform = scale < 1 ? `scale(${scale})` : '';
    };
    if (legendContentObserver) legendContentObserver.disconnect();
    legendContentObserver = new ResizeObserver(fit);
    legendContentObserver.observe(content);
    fit();
}

startChart();
