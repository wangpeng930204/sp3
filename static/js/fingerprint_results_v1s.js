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
    const overviewHeight = Math.min(250, overviewCanvasHeight * 0.2);
    // Let totals extend higher while leaving room above the chart.
    const totalOverviewHeight = Math.min(overviewHeight * 1.5, Math.max(1, margin.top - 24));
    const legendWidth = Math.min(250, margin.right - 28);
    // Give the scale distribution a useful minimum height even with many products.
    height = Math.max(height, margin.top + 440 + margin.bottom);
    const bottom = height - margin.bottom;
    const right = Math.max(margin.left + 1, width - margin.right);
    // Shared endpoint for the top boundary and horizontal axis line.
    const boundaryRight = right + legendWidth;
    return { width, height, margin, overviewHeight, totalOverviewHeight, legendWidth, bottom, right, boundaryRight };
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
    requestAnimationFrame(fitLegendHeight);
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

function drawBoundaries({ margin, overviewHeight, totalOverviewHeight, bottom, right, boundaryRight }, x) {
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
        .attr('y1', margin.top - totalOverviewHeight)
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
        .attr('y', axisBottom + margin.bottom - 20)
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
        .style('font-weight', '600').style('margin-top', '16px').style('margin-bottom', '8px')
        .text('User Summary:');
    const summary = container.append('div').attr('class', 'user-summary')
        .attr('role', 'status').attr('aria-live', 'polite').attr('aria-atomic', 'true')
        .style('min-height', '82px')
        .style('box-sizing', 'border-box')
        .style('padding', '12px')
        .style('line-height', '1.5').style('overflow-wrap', 'anywhere');
    summary.append('div').attr('class', 'user-summary-name').style('font-weight', '600');
    summary.append('div').attr('class', 'user-summary-rating')
        .attr('title', 'Average rating across evaluations for this user. Missing ratings are excluded.');
    updateUserSummary();
}

function updateUserSummary() {
    requestAnimationFrame(fitLegendHeight);
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

// Measure natural legend content, independent of the foreignObject height.
// Grow only the lower area; ResizeObserver redraws the scale to the new height.
function fitLegendHeight() {
    const legend = svg.select('.chart-legend').node();
    if (!legend || !legend.firstElementChild) return;
    const available = Number(legend.getAttribute('height'));
    const required = legend.firstElementChild.scrollHeight;
    // scrollHeight is rounded to whole CSS pixels; SVG heights can be fractional.
    // Ignore that rounding difference rather than triggering another resize.
    if (required > Math.ceil(available)) {
        host.style.height = `${host.clientHeight + Math.ceil(required - available) + 8}px`;
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

// Product colors and interactions.
const productColor = d3.scaleOrdinal().domain(products.map(product => product.id))
    .range(tab10Palette);

function buildOverviewBars(criteria) {
    return criteria.flatMap(criterion =>
        Array.from(d3.group(criterion.ratings, row => row.productId), ([productId, ratings]) => {
            const total = d3.sum(ratings, row => row.value);
            const segments = [{ rows: ratings, value: total, count: ratings.length, start: 0, end: total }];
            return { criterionId: criterion.id, productId, product: ratings[0].product, segments, total };
        })
    );
}

function overviewSegmentText(bar, segment) {
    return `${bar.criterionId === null ? 'All criteria' : criterionNames.get(bar.criterionId)} / ${bar.product}, Sum of ratings: ${segment.value}, Ratings: ${segment.count}`;
}

function drawRatings({ bottom, labelBottom = bottom }, x, y) {
    criteria.forEach(criterion => {
        const productX = d3.scaleBand().domain(criterion.products.map(product => product.id))
            .range([x(criterion.id), x(criterion.id) + x.bandwidth()]);
        const ratingOffsets = new Map();
        // Center each score on its bar; fan out only ratings sharing that score.
        d3.group(criterion.ratings, row => row.productId, row => row.value)
            .forEach(scores => scores.forEach(rows => {
                const step = Math.min(12, productX.bandwidth() * 0.6 / Math.max(1, rows.length - 1));
                rows.forEach((row, index) => {
                    ratingOffsets.set(row, (index - (rows.length - 1) / 2) * step);
                });
            }));

        svg.append('g').attr('class', 'rating-points')
            .selectAll('circle').data(criterion.ratings)
            .join('circle')
            .attr('cx', row => productX(row.productId) + productX.bandwidth() / 2 + ratingOffsets.get(row))
            .attr('cy', row => y(row.value))
            .attr('r', Math.max(2, Math.min(9, productX.bandwidth() * 0.2)))
            .attr('fill', row => productColor(row.productId))
            .attr('opacity', 1)
            .attr('stroke', row => productColor(row.productId)).attr('stroke-width', 1)
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
            .attr('aria-label', row => `User: ${row.user}, Rating: ${row.value} / 9, Comments: ${row.comments || 'No comments'}`)
            .call(attachRatingTooltip);
        svg.append('g')
            .attr('fill', '#17212b')
            .attr('font-size', 12)
            .attr('text-anchor', 'middle')
            .selectAll('text')
            .data(criterion.products)
            .join('text')
            .attr('x', product => productX(product.id) + productX.bandwidth() / 2)
            .attr('y', labelBottom + 15)
            .text(product => productShortNames.get(product.id))
            .attr('aria-label', product => product.name)
            .each(function () { fitLabel(this, productX.bandwidth() - 4); })
            .append('title').text(product => product.name);
    });
}

function drawSelectedUserConnection() {
    const dots = svg.selectAll('.rating-points circle');
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
                    Number(this.getAttribute('cx')),
                    Number(this.getAttribute('cy')),
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
        .attr('stroke', connection => productColor(connection.productId))
        .attr('stroke-width', 2)
        .attr('stroke-linejoin', 'round')
        .attr('stroke-linecap', 'round');
}

function drawLegend(layout) {
    const { margin, right, bottom, legendWidth } = layout;
    const legendTop = layout.legendTop ?? margin.top + 20;
    const legendContainer = svg.append('foreignObject').attr('class', 'chart-legend')
        .attr('x', layout.legendLeft ?? right + 14).attr('y', legendTop)
        .attr('width', legendWidth)
        .attr('height', layout.legendHeight ?? Math.max(1, bottom - legendTop))
        .append('xhtml:div')
        .style('display', 'flex').style('flex-direction', 'column')
        .style('font-size', '12px').style('color', '#17212b');
    legendContainer.style('width', `${legendWidth - 16}px`);
    const legend = legendContainer.append('div')
        .style('flex', '0 0 auto').style('line-height', '1.5');
    drawUserSummary(legendContainer);
    products.forEach(product => {
        const row = legend.append('div').style('margin-top', '12px')
            .style('width', '100%');
        row.append('div').attr('class', 'legend-heading')
            .style('font-weight', '600').style('overflow-wrap', 'anywhere')
            .style('margin-bottom', '6px').text(product.name);

        row.append('div')
            .attr('role', 'img').attr('aria-label', `${product.name}: product color`)
            .style('height', '12px').style('border-radius', '3px')
            .style('margin', '0 13px').style('background', productColor(product.id));
    });
}

// Original vertical overview layout.

function styleBarAxes(layout) {
    // Keep value and product labels while hiding Global axis strokes.
    svg.selectAll('.total-overview .axis line').remove();
    svg.selectAll('.overview .domain, .total-overview .domain').attr('stroke', 'none');
    svg.selectAll('.overview .axis, .total-overview .axis').attr('color', '#17212b');
    svg.selectAll('.overview .tick line, .total-overview .tick line')
        .attr('stroke', '#17212b').attr('stroke-width', 2);
    drawBarAxes(svg.select('.overview'), layout.margin.left, layout.right,
        layout.margin.top - layout.overviewHeight, layout.margin.top);
}

function drawBarAxes(parent, left, right, top, bottom) {
    parent.append('g').attr('class', 'bar-axis-lines').attr('pointer-events', 'none')
        .attr('stroke', '#17212b').attr('stroke-width', 2)
        .selectAll('line').data([
            { x: right, y: bottom }, { x: left, y: top },
        ]).join('line').attr('x1', left).attr('y1', bottom)
        .attr('x2', end => end.x).attr('y2', end => end.y);
}

function drawOverview({ margin, overviewHeight }, x) {
    const top = margin.top - overviewHeight;
    const overviewY = d3.scaleLinear().domain([0, d3.max(overviewBars, bar => bar.total) || 1]).nice()
        .range([margin.top, top]);
    const overview = svg.append('g').attr('class', 'overview');
    overview.append('text')
        .attr('class', 'axis-title')
        .attr('transform', `translate(${margin.left - 48},${(top + margin.top) / 2}) rotate(-90)`)
        .attr('text-anchor', 'middle').attr('fill', '#17212b')
        .text('Group Rating');
    overview.append('g')
        .attr('class', 'axis overview-axis')
        .attr('transform', `translate(${margin.left},0)`)
        .call(d3.axisLeft(overviewY).ticks(Math.max(2, Math.floor(overviewHeight / 40)))
            .tickSize(0).tickPadding(9));

    const productScales = new Map(criteria.map(criterion => [
        criterion.id,
        d3.scaleBand().domain(criterion.products.map(product => product.id))
            .range([x(criterion.id), x(criterion.id) + x.bandwidth()]),
    ]));
    overviewBars.forEach(bar => {
        const productX = productScales.get(bar.criterionId);
        const barWidth = productX.bandwidth() * 0.6;
        const group = overview.append('g');
        group.append('title').text(`${bar.product}: total rating ${bar.total}`);
        group.selectAll('rect')
            .data(bar.segments)
            .join('rect')
            .attr('x', productX(bar.productId) + (productX.bandwidth() - barWidth) / 2)
            .attr('y', segment => overviewY(segment.end))
            .attr('width', barWidth)
            .attr('height', segment => overviewY(segment.start) - overviewY(segment.end))
            .attr('fill', productColor(bar.productId))
            .attr('fill-opacity', 1)
            .attr('tabindex', 0)
            .attr('role', 'img')
            .attr('aria-label', segment => overviewSegmentText(bar, segment))
            .call(bindOverviewSelection)
            .append('title')
            .text(segment => overviewSegmentText(bar, segment));
    });
}

function drawTotalOverview({ margin, totalOverviewHeight, right, legendWidth }) {
    const overviewLeft = right + 10;
    // Share the legend width, reserving space inside it for the Y-axis labels.
    const left = overviewLeft + 22;
    const chartRight = Math.max(left + 1, overviewLeft + legendWidth);
    const top = margin.top - totalOverviewHeight;
    // Totals across criteria need their own labeled scale.
    const totalY = d3.scaleLinear().domain([0, d3.max(totalOverviewBars, bar => bar.total) || 1]).nice().range([margin.top, top]);
    const productX = d3.scaleBand().domain(products.map(product => product.id))
        .range([left, chartRight]).padding(0.25);
    const overview = svg.append('g').attr('class', 'total-overview');
    overview.append('text')
        .attr('x', overviewLeft + legendWidth / 2).attr('y', top - 12)
        .attr('text-anchor', 'middle')
        .attr('fill', '#17212b').attr('font-size', 12).attr('font-weight', 600)
        .text('Overall Rating')
        .each(function () { fitLabel(this, legendWidth); })
        .append('title').text('Sum of ratings across all criteria, by product');
    // Reuse the vertical divider as the totals axis, with labels on its right.
    overview.append('g')
        .attr('class', 'axis total-overview-axis')
        .attr('transform', `translate(${right},0)`)
        .call(d3.axisRight(totalY).ticks(Math.max(2, Math.floor(totalOverviewHeight / 40)))
            .tickSize(0).tickPadding(4))
        .select('.domain').remove();
    totalOverviewBars.forEach(bar => {
        const group = overview.append('g');
        group.selectAll('rect').data(bar.segments).join('rect')
            .attr('x', productX(bar.productId))
            .attr('y', segment => totalY(segment.end))
            .attr('width', productX.bandwidth())
            .attr('height', segment => totalY(segment.start) - totalY(segment.end))
            .attr('fill', productColor(bar.productId))
            .attr('fill-opacity', 1)
            .attr('tabindex', 0).attr('role', 'img')
            .attr('aria-label', segment => overviewSegmentText(bar, segment))
            .call(bindOverviewSelection)
            .append('title').text(segment => overviewSegmentText(bar, segment));
        group.append('text')
            .attr('x', productX(bar.productId) + productX.bandwidth() / 2)
            .attr('y', margin.top + 13)
            .attr('text-anchor', 'middle').attr('font-size', 12).attr('fill', '#17212b')
            .text(bar.product)
            .each(function () { fitLabel(this, productX.bandwidth()); })
            .append('title').text(`${bar.product}: total rating ${bar.total}`);
    });
}

startChart();
