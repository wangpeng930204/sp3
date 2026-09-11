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
const userColor = d3.scaleOrdinal().domain(users.map(user => user.id))
    .range(users.map((user, index) => users.length <= 10
        ? d3.schemeTableau10[index] : d3.interpolateRainbow(index / users.length)));
const productShape = d3.scaleOrdinal().domain(products.map(product => product.id))
    .range([d3.symbolTriangle, d3.symbolSquare, d3.symbolCircle,
        d3.symbolDiamond, d3.symbolCross, d3.symbolStar, d3.symbolWye]);
// Scale symbol area linearly; keep 0% visible. Unknown confidence uses the minimum size.
const confidenceArea = d3.scaleLinear().domain([0, 100]).range([0.12, 1]).clamp(true);
function markerSize(confidence, maxArea) {
    return confidenceArea(confidence ?? 0) * maxArea;
}
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
        top: height * 0.40,
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
    const narrowestProduct = d3.min(criteria, criterion => x.bandwidth() / criterion.products.length) || 45;
    layout.markerArea = Math.PI * Math.pow(Math.max(3, Math.min(9, narrowestProduct * 0.2)), 2);
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
            const segments = groups.flatMap(([confidence, rows]) =>
                Array.from(d3.group(rows, row => row.userId))
                    .sort(([a], [b]) => d3.ascending(a, b))
                    .map(([userId, ratings]) => {
                        const value = d3.sum(ratings, row => row.value);
                        const start = total;
                        total += value;
                        return { confidence, userId, user: ratings[0].user,
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

function drawOverview(layout, x) {
    drawHorizontalOverview(layout, overviewBars,
        bar => ({ left: x(bar.criterionId), width: x.bandwidth() }), 'overview');
}

function drawTotalOverview(layout) {
    drawHorizontalOverview(layout, totalOverviewBars,
        () => ({ left: layout.right + 4, width: layout.legendWidth + 10 }), 'total-overview');
}

function drawHorizontalOverview({ margin, overviewHeight, right, legendWidth }, bars, panelFor, className) {
    const top = margin.top - overviewHeight;
    const rowHeight = overviewHeight / Math.max(1, products.length);
    const maximum = d3.max(bars, bar => bar.total) || 1;
    const overview = svg.append('g').attr('class', className);
    // One shared confidence axis per product row serves every overview panel.
    if (className === 'overview') {
        overview.append('text').attr('class', 'shared-rating-label')
            .attr('x', (margin.left + right + 14 + legendWidth) / 2)
            .attr('y', top - 8)
            .attr('text-anchor', 'middle').attr('font-size', 10).attr('fill', '#475569')
            .text('Group rating');
        products.forEach((product, index) => {
            const rowTop = top + index * rowHeight;
            overview.append('text').attr('class', 'shared-product-label')
                .attr('x', margin.left - 4).attr('y', rowTop + rowHeight * 0.35)
                .attr('text-anchor', 'end').attr('dominant-baseline', 'middle')
                .attr('font-size', 10).attr('fill', '#17212b')
                .text(product.name)
                .each(function () { fitLabel(this, Math.max(0, margin.left - 8)); })
                .append('title').text(product.name);
            const confidenceY = d3.scaleLinear().domain([0, 100])
                .range([rowTop + rowHeight * 0.7, rowTop + 4]);
            overview.append('g').attr('class', 'axis shared-confidence-axis')
                .attr('transform', `translate(${margin.left},0)`)
                .call(d3.axisLeft(confidenceY).tickValues([0, 100])
                    .tickFormat(value => `${value}%`).tickSize(2).tickPadding(4))
                .selectAll('text').style('font-size', '8px');
        });
    }
    bars.forEach(bar => {
        const { left, width } = panelFor(bar);
        const rowIndex = products.findIndex(product => product.id === bar.productId);
        const rowTop = top + rowIndex * rowHeight;
        const baseline = rowTop + rowHeight * 0.7;
        const ratingX = d3.scaleLinear().domain([0, maximum]).nice()
            .range([left + 4, left + Math.max(5, width - 8)]);
        const confidenceY = d3.scaleLinear().domain([0, 100]).clamp(true)
            .range([baseline, rowTop + 4]);
        const group = overview.append('g');
        group.append('g').attr('class', 'axis')
            .attr('transform', `translate(0,${baseline})`)
            .call(d3.axisBottom(ratingX).tickValues([0, ratingX.domain()[1]])
                .tickSize(2).tickPadding(2))
            .selectAll('text').style('font-size', '8px');
        group.selectAll('rect').data(horizontalSegments(bar)).join('rect')
            .attr('x', segment => ratingX(segment.start))
            .attr('y', segment => confidenceY(segment.confidence ?? 0))
            .attr('width', segment => ratingX(segment.end) - ratingX(segment.start))
            .attr('height', segment => baseline - confidenceY(segment.confidence ?? 0))
            .attr('fill', segment => userColor(segment.userId))
            .attr('stroke', '#17212b').attr('stroke-width', 0.5)
            .attr('tabindex', 0).attr('role', 'img')
            .attr('aria-label', segment => overviewSegmentText(bar, segment))
            .append('title').text(segment => overviewSegmentText(bar, segment));
    });
}

function overviewSegmentText(bar, segment) {
    return `${bar.criterionId === null ? 'All criteria' : criterionNames.get(bar.criterionId)} / ${bar.product}, User: ${segment.user}, Confidence: ${confidenceText(segment)}, Sum of ratings: ${segment.value}, Ratings: ${segment.count}`;
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

function drawRatings({ bottom, markerArea }, x, y) {
    criteria.forEach(criterion => {
        const productX = d3.scaleBand().domain(criterion.products.map(product => product.id))
            .range([x(criterion.id), x(criterion.id) + x.bandwidth()]);
        const userX = d3.scalePoint().domain(userIds)
            .range([-productX.bandwidth() * 0.3, productX.bandwidth() * 0.3]);

        svg.append('g').attr('class', 'rating-points')
            .selectAll('path').data(criterion.ratings)
            .join('path')
            .attr('class', 'rating-marker')
            .attr('data-x', row => productX(row.productId) + productX.bandwidth() / 2 + userX(row.userId))
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
            .append('title')
            .text(row => `Product: ${row.product}, User: ${row.user}\nRating: ${row.value} / 9\nConfidence: ${confidenceText(row)}\nComments: ${row.comments || 'No comments'}`);
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

function drawLegend({ margin, right, bottom, legendWidth, markerArea }) {
    const legendTop = margin.top + 20;
    const legend = svg.append('foreignObject')
        .attr('x', right + 14).attr('y', legendTop)
        .attr('width', legendWidth)
        .attr('height', Math.max(1, bottom - legendTop))
        .append('xhtml:div')
        .style('height', '100%').style('overflow-y', 'auto')
        .style('font-size', '12px').style('color', '#17212b');
    legend.append('div').style('font-weight', '700').text('Products / confidence');
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
        [0, 100].forEach(confidence => {
            const position = confidence === 0 ? startX : endX;
            key.append('path').attr('transform', `translate(${position},18)`)
                .attr('d', d3.symbol().type(productShape(product.id))
                    .size(markerSize(confidence, markerArea))())
                .attr('fill', '#475569').attr('stroke', '#475569').attr('stroke-width', 1);
            key.append('text').attr('x', position).attr('y', 44)
                .attr('text-anchor', 'middle').attr('font-size', 10).attr('fill', '#475569')
                .text(`${confidence}%`);
        });
    });
    legend.append('div').style('font-weight', '700').style('margin-top', '20px').text('Users');
    users.forEach(user => {
        const row = legend.append('div').style('display', 'flex').style('gap', '8px').style('margin-top', '10px');
        row.append('span').style('flex', '0 0 12px').style('height', '12px')
            .style('border-radius', '50%').style('background', userColor(user.id));
        row.append('span').style('overflow-wrap', 'anywhere').text(user.name);
    });
    if (data.some(row => row.confidence == null)) {
        legend.append('div').style('margin-top', '16px')
            .text('Unavailable confidence uses the smallest marker; see rating details.');
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
