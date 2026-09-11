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
const productColor = d3.scaleOrdinal().domain(products.map(product => product.id))
    .range(products.map((product, index) => products.length <= 10
        ? d3.schemeTableau10[index] : d3.interpolateRainbow(index / products.length)));
// Keep zero-confidence ratings visible while making high confidence more opaque.
const confidenceOpacity = d3.scaleLinear().domain([0, 100]).range([0.2, 1]).clamp(true);
const criteria = Array.from(d3.group(data, row => row.criterionId), ([id, rows]) => ({
    id,
    name: rows[0].criterion,
    ratings: rows,
    products: Array.from(d3.group(rows, row => row.productId), ([productId, ratings]) => ({
        id: productId,
        name: ratings[0].product,
    })),
}));
const overviewBars = buildOverviewBars(criteria);
const totalOverviewBars = buildOverviewBars([{ id: null, ratings: data }]);
const criterionNames = new Map(criteria.map(criterion => [criterion.id, criterion.name]));
const userIds = users.map(user => user.id);
let selectedRating = null;
const svg = d3.select(host).append('svg')
    .attr('role', 'group')
    .attr('aria-label', 'Y values from 0 to 9, with evaluated products grouped by LSC criterion on the X-axis');

function getChartLayout(width, height) {
    const margin = {
        // Reserve the upper area for overview charts.
        top: height * 0.30,
        // Leave a dedicated column on the right for the chart legend.
        right: Math.min(220, width * 0.2),
        bottom: Math.min(110, height * 0.26),
        left: Math.min(100, width * 0.12),
    };
    const overviewHeight = Math.min(200, height * 0.2);
    const legendWidth = Math.min(150, width * 0.2);
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
    svg.attr('width', width).attr('height', height).attr('viewBox', `0 0 ${width} ${height}`);
    svg.selectAll('*').remove();

    drawOverview(layout, x);
    drawTotalOverview(layout);
    drawBoundaries(layout, x);
    drawAxes(layout, x, y);
    svg.append('g')
        .attr('class', 'user-connections')
        .attr('aria-hidden', 'true')
        .attr('pointer-events', 'none');
    drawRatings(layout, x, y);
    drawSelectedUserConnection();
    drawLegend(layout);
}

// Each confidence group contributes its sum of ratings to the product's stack.
function buildOverviewBars(criteria) {
    return criteria.flatMap(criterion =>
        Array.from(d3.group(criterion.ratings, row => row.productId), ([productId, ratings]) => {
            // Stack highest confidence at the bottom; unknown confidence goes on top.
            const groups = Array.from(d3.group(ratings, row => row.confidence ?? null))
                .sort(([a], [b]) => a === b ? 0 : a === null ? 1 : b === null ? -1 : b - a);
            let total = 0;
            const segments = groups.map(([confidence, rows]) => {
                const value = d3.sum(rows, row => row.value);
                const start = total;
                total += value;
                return { confidence, value, count: rows.length, start, end: total };
            });
            return { criterionId: criterion.id, productId, product: ratings[0].product, segments, total };
        })
    );
}

function drawOverview({ margin, overviewHeight }, x) {
    const top = margin.top - overviewHeight;
    const overviewY = d3.scaleLinear()
        .domain([0, d3.max(overviewBars, bar => bar.total) || 1])
        .nice()
        .range([margin.top, top]);
    const overview = svg.append('g').attr('class', 'overview');
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
            .attr('fill-opacity', segment => segment.confidence === null ? 1 : confidenceOpacity(segment.confidence))
            .attr('tabindex', 0)
            .attr('role', 'img')
            .attr('aria-label', segment => overviewSegmentText(bar, segment))
            .append('title')
            .text(segment => overviewSegmentText(bar, segment));
    });
}

function drawTotalOverview({ margin, overviewHeight, right, legendWidth }) {
    const overviewLeft = right + 14;
    // Share the legend width, reserving space inside it for the Y-axis labels.
    const left = overviewLeft + 22;
    const chartRight = Math.max(left + 1, overviewLeft + legendWidth);
    const top = margin.top - overviewHeight;
    // Totals across criteria need their own labeled scale.
    const totalY = d3.scaleLinear()
        .domain([0, d3.max(totalOverviewBars, bar => bar.total) || 1])
        .nice().range([margin.top, top]);
    const productX = d3.scaleBand().domain(products.map(product => product.id))
        .range([left, chartRight]).padding(0.25);
    const overview = svg.append('g').attr('class', 'total-overview');
    overview.append('text')
        .attr('x', overviewLeft).attr('y', top - 12)
        .attr('fill', '#17212b').attr('font-size', 12).attr('font-weight', 600)
        .each(function () { fitLabel(this, legendWidth); })
        .append('title').text('Sum of ratings across all criteria, by product');
    // Reuse the vertical divider as the totals axis, with labels on its right.
    overview.append('g')
        .attr('class', 'axis total-overview-axis')
        .attr('transform', `translate(${right},0)`)
        .call(d3.axisRight(totalY).ticks(Math.max(2, Math.floor(overviewHeight / 40)))
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
            .attr('fill-opacity', segment => segment.confidence === null ? 1 : confidenceOpacity(segment.confidence))
            .attr('tabindex', 0).attr('role', 'img')
            .attr('aria-label', segment => overviewSegmentText(bar, segment))
            .append('title').text(segment => overviewSegmentText(bar, segment));
        group.append('text')
            .attr('x', productX(bar.productId) + productX.bandwidth() / 2)
            .attr('y', margin.top + 13)
            .attr('text-anchor', 'middle').attr('font-size', 10).attr('fill', '#17212b')
            .text(bar.product)
            .each(function () { fitLabel(this, productX.bandwidth()); })
            .append('title').text(`${bar.product}: total rating ${bar.total}`);
    });
}

function overviewSegmentText(bar, segment) {
    return `${bar.criterionId === null ? 'All criteria' : criterionNames.get(bar.criterionId)} / ${bar.product}, Confidence: ${confidenceText(segment)}, Sum of ratings: ${segment.value}, Ratings: ${segment.count}`;
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

function drawAxes({ margin, bottom, boundaryRight }, x, y) {
    svg.append('g')
        .attr('class', 'axis')
        .attr('transform', `translate(${margin.left},0)`)
        .call(d3.axisLeft(y).tickValues(d3.range(10)).tickFormat(d3.format('d')).tickSize(0).tickPadding(9))
        .select('.domain')
        .attr('stroke', '#999')
        .attr('stroke-dasharray', '5 5');
    const horizontalAxis = svg.append('g')
        .attr('class', 'axis')
        .attr('transform', `translate(0,${bottom})`)
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

function drawRatings({ bottom }, x, y) {
    criteria.forEach(criterion => {
        const productX = d3.scaleBand().domain(criterion.products.map(product => product.id))
            .range([x(criterion.id), x(criterion.id) + x.bandwidth()]);
        const userX = d3.scalePoint().domain(userIds)
            .range([-productX.bandwidth() * 0.3, productX.bandwidth() * 0.3]);

        svg.append('g').attr('class', 'rating-points')
            .selectAll('circle').data(criterion.ratings)
            .join('circle')
            .attr('cx', row => productX(row.productId) + productX.bandwidth() / 2 + userX(row.userId))
            .attr('cy', row => y(row.value))
            .attr('r', Math.max(2, Math.min(9, productX.bandwidth() * 0.2)))
            .attr('fill', row => productColor(row.productId))
            .attr('opacity', row => row.confidence == null ? 1 : confidenceOpacity(row.confidence))
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
            .attr('aria-label', row => `User: ${row.user}, Rating: ${row.value} / 9, Confidence: ${confidenceText(row)}, Comments: ${row.comments || 'No comments'}`)
            .append('title')
            .text(row => `User: ${row.user}\nRating: ${row.value} / 9\nConfidence: ${confidenceText(row)}\nComments: ${row.comments || 'No comments'}`);
        svg.append('g')
            .attr('fill', '#333')
            .attr('font-size', 11)
            .attr('text-anchor', 'middle')
            .selectAll('text')
            .data(criterion.products)
            .join('text')
            .attr('x', product => productX(product.id) + productX.bandwidth() / 2)
            .attr('y', bottom + 15)
            .text(product => product.name)
            .each(function () { fitLabel(this, productX.bandwidth() - 4); })
            .append('title').text(product => product.name);
    });
}

// Selecting the same user again clears the connection.
function selectRatingUser(row) {
    selectedRating = selectedRating !== null && selectedRating.userId === row.userId ? null : row;
    drawSelectedUserConnection();
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

function drawLegend({ margin, right, bottom, legendWidth }) {
    const legendTop = margin.top + 20;
    const legend = svg.append('foreignObject')
        .attr('x', right + 14).attr('y', legendTop)
        .attr('width', legendWidth)
        .attr('height', Math.max(1, bottom - legendTop))
        .append('xhtml:div')
        .style('height', '100%').style('overflow-y', 'auto')
        .style('font-size', '12px').style('color', '#17212b');
    products.forEach(product => {
        const row = legend.append('div').style('margin-top', '16px');
        row.append('div')
            .style('font-weight', '600').style('overflow-wrap', 'anywhere')
            .style('margin-bottom', '6px').text(product.name);

        // Match the opacity scale used by the dots and overview segments.
        const color = d3.color(productColor(product.id));
        color.opacity = confidenceOpacity(0);
        const lowConfidenceColor = color.formatRgb();
        color.opacity = confidenceOpacity(100);
        const highConfidenceColor = color.formatRgb();
        row.append('div')
            .attr('role', 'img')
            .attr('aria-label', `${product.name}: confidence from 100% (solid) to 0% (light)`)
            .style('height', '14px').style('border-radius', '3px')
            .style('background', `linear-gradient(to right, ${highConfidenceColor}, ${lowConfidenceColor})`);
        const labels = row.append('div')
            .style('display', 'flex').style('justify-content', 'space-between')
            .style('margin-top', '4px').style('font-size', '11px');
        labels.append('span').text('100%');
        labels.append('span').text('0%');
    });
    if (data.some(row => row.confidence == null)) {
        legend.append('div').style('margin-top', '16px')
            .text('Unavailable confidence uses full opacity; see rating details.');
    }
}

function fitLabel(node, availableWidth) {
    const label = d3.select(node);
    let text = label.text();
    while (text.length && node.getComputedTextLength() > Math.max(0, availableWidth)) {
        text = text.slice(0, -1);
        label.text(text ? `${text}…` : '');
    }
}

renderChart();
new ResizeObserver(renderChart).observe(host);
