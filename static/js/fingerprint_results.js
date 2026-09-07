const host = document.getElementById('fingerprint-chart');
const data = JSON.parse(document.getElementById('fingerprint-data').textContent);
const criteria = Array.from(d3.group(data, row => row.criterionId), ([id, rows]) => ({
    id,
    name: rows[0].criterion,
    products: Array.from(d3.group(rows, row => row.productId), ([productId, ratings]) => ({
        id: productId,
        name: ratings[0].product,
    })),
}));
const svg = d3.select(host).append('svg')
    .attr('role', 'img')
    .attr('aria-label', 'Y values from 0 to 9, with evaluated products grouped by LSC criterion on the X-axis');

function drawAxes() {
    const margin = { top: 300, right: 400, bottom: 100, left: 200 };
    const overviewHeight = 160;
    const groupWidth = Math.max(180, d3.max(criteria, criterion => criterion.products.length * 100 + 40) || 0);
    const width = Math.max(host.clientWidth, margin.left + margin.right + criteria.length * groupWidth);
    const height = Math.max(margin.top + margin.bottom + 160, window.innerHeight);
    const bottom = height - margin.bottom;
    const right = Math.max(margin.left + 1, width - margin.right);
    const y = d3.scaleLinear().domain([0, 9]).range([bottom, margin.top]);
    const x = d3.scaleBand().domain(criteria.map(criterion => criterion.id))
        .range([margin.left, right]).paddingInner(0.15).paddingOuter(0.05);
    const dividerPositions = criteria.slice(1).map((criterion, index) =>
        (x(criteria[index].id) + x.bandwidth() + x(criterion.id)) / 2
    );    
    svg.attr('width', width).attr('height', height);
    svg.selectAll('*').remove();
    svg.append('line')
        .attr('class', 'chart-top-line')
        .attr('x1', margin.left)
        .attr('x2', right)
        .attr('y1', y(9))
        .attr('y2', y(9))
        .attr('stroke', '#333');

    svg.append('g')
        .attr('class', 'criterion-dividers')
        .attr('stroke', '#999')     // add this below if want a dash dot line .attr('stroke-dasharray', '5 5')
        .selectAll('line')
        .data(dividerPositions)
        .join('line')
        .attr('x1', position => position)
        .attr('x2', position => position)
        .attr('y1', margin.top-overviewHeight)
        .attr('y2', bottom);
    svg.append('g')
        .attr('class', 'axis')
        .attr('transform', `translate(${margin.left},0)`)
        .call(d3.axisLeft(y).tickValues(d3.range(10)).tickFormat(d3.format('d')).tickSize(0).tickPadding(9))
        .select('.domain')
        .attr('stroke', '#999')
        .attr('stroke-dasharray', '5 5');
    svg.append('g')
        .attr('class', 'axis')
        .attr('transform', `translate(0,${bottom})`)
        .call(d3.axisBottom(x).tickSize(0).tickPadding(30)
            .tickFormat(id => criteria.find(criterion => criterion.id === id).name))
        .selectAll('.tick text')
        .each(function () {
            const label = d3.select(this);
            const words = label.text().split(/\s+/);
            label.text(null);
            let line = '';
            let span = label.append('tspan').attr('x', 0).attr('dy', '0em');
            words.forEach(word => {
                const next = line ? `${line} ${word}` : word;
                span.text(next);
                if (line && span.node().getComputedTextLength() > x.bandwidth()) {
                    span.text(line);
                    span = label.append('tspan').attr('x', 0).attr('dy', '1.2em').text(word);
                    line = word;
                } else {
                    line = next;
                }
            });
        });

    criteria.forEach(criterion => {
        const productX = d3.scaleBand().domain(criterion.products.map(product => product.id))
            .range([x(criterion.id), x(criterion.id) + x.bandwidth()]);
        svg.append('g')
            .attr('fill', '#333')
            .attr('font-size', 13)
            .attr('text-anchor', 'middle')
            .selectAll('text')
            .data(criterion.products)
            .join('text')
            .attr('x', product => productX(product.id) + productX.bandwidth() / 2)
            .attr('y', bottom + 15)
            .text(product => product.name);
    });
}

drawAxes();
window.addEventListener('resize', drawAxes);
