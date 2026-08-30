// ============================================================
// src/store/visualize.ts
// Interactive HTML relationship graph visualizer builder.
// Generates a standalone D3.js force-directed graph HTML file.
// ============================================================

import { writeFileSync } from "fs";
import { getMetadataStore } from "./metadata.js";

/**
 * Reads all memories and relationship links and exports them into an
 * interactive force-directed graph visualization in a single standalone HTML page.
 */
export function exportVisualizerHTML(filePath: string): void {
  const metaStore = getMetadataStore();
  const memories = metaStore.getAll(); // Include archived to show full graph
  const links = metaStore.getAllLinks();

  const d3Links = links.map((l) => ({
    source: l.sourceId,
    target: l.targetId,
    relation: l.relation,
  }));

  const template = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Memory Relationship Graph</title>
  <script src="https://d3js.org/d3.v7.min.js"></script>
  <style>
    body {
      margin: 0;
      padding: 0;
      background-color: #0f172a;
      color: #f8fafc;
      font-family: 'Inter', -apple-system, sans-serif;
      overflow: hidden;
    }
    #header {
      position: absolute;
      top: 20px;
      left: 20px;
      z-index: 10;
      pointer-events: none;
    }
    #header h1 {
      margin: 0 0 5px 0;
      font-size: 24px;
      font-weight: 700;
      letter-spacing: -0.025em;
      background: linear-gradient(to right, #38bdf8, #818cf8);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    #header p {
      margin: 0;
      font-size: 14px;
      color: #64748b;
    }
    #search-box {
      position: absolute;
      top: 20px;
      right: 20px;
      z-index: 10;
    }
    #search-input {
      padding: 10px 16px;
      width: 250px;
      background-color: #1e293b;
      border: 1px solid #334155;
      border-radius: 8px;
      color: #f8fafc;
      font-size: 14px;
      outline: none;
      transition: border-color 0.2s;
    }
    #search-input:focus {
      border-color: #38bdf8;
    }
    #info-panel {
      position: absolute;
      bottom: 20px;
      left: 20px;
      width: 320px;
      background-color: rgba(30, 41, 59, 0.85);
      backdrop-filter: blur(12px);
      border: 1px solid rgba(51, 65, 85, 0.5);
      border-radius: 12px;
      padding: 20px;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.3);
      z-index: 10;
      transition: opacity 0.3s;
      opacity: 0;
      pointer-events: none;
    }
    #info-panel.visible {
      opacity: 1;
      pointer-events: auto;
    }
    #info-title {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #38bdf8;
      margin-bottom: 8px;
      font-weight: 600;
    }
    #info-content {
      font-size: 15px;
      line-height: 1.5;
      color: #e2e8f0;
      margin-bottom: 15px;
    }
    .meta-item {
      font-size: 13px;
      color: #94a3b8;
      margin-bottom: 4px;
    }
    .meta-value {
      color: #f1f5f9;
      font-weight: 500;
    }
    svg {
      width: 100vw;
      height: 100vh;
      cursor: grab;
    }
    svg:active {
      cursor: grabbing;
    }
    .node {
      stroke: #0f172a;
      stroke-width: 2px;
      transition: stroke-width 0.2s, r 0.2s;
    }
    .node:hover {
      stroke-width: 3px;
      cursor: pointer;
    }
    .link {
      stroke: #334155;
      stroke-opacity: 0.6;
      stroke-width: 1.5px;
      fill: none;
    }
    .link-label {
      font-size: 9px;
      fill: #475569;
      font-weight: 500;
      text-anchor: middle;
      pointer-events: none;
    }
    .node-label {
      font-size: 11px;
      fill: #94a3b8;
      pointer-events: none;
      text-anchor: middle;
    }
    /* Node colors by type */
    .node-fact { fill: #3b82f6; }
    .node-decision { fill: #10b981; }
    .node-event { fill: #8b5cf6; }
    .node-summary { fill: #f59e0b; }
    
    .node-highlighted {
      stroke: #f43f5e !important;
      stroke-width: 4px !important;
    }
  </style>
</head>
<body>
  <div id="header">
    <h1>Memory Relationship Graph</h1>
    <p>Interactive representation of stored memories and relationships</p>
  </div>
  <div id="search-box">
    <input type="text" id="search-input" placeholder="Search memories...">
  </div>
  <div id="info-panel">
    <div id="info-title">Memory Details</div>
    <div id="info-content">Select a node to view its content.</div>
    <div id="info-meta"></div>
  </div>

  <svg id="graph-svg"></svg>

  <script>
    const data = {
      nodes: $NODES_JSON$,
      links: $LINKS_JSON$
    };

    const width = window.innerWidth;
    const height = window.innerHeight;

    const svg = d3.select("#graph-svg")
      .attr("viewBox", [0, 0, width, height]);

    const g = svg.append("g");

    // Add zoom behavior
    svg.call(d3.zoom()
      .extent([[0, 0], [width, height]])
      .scaleExtent([0.1, 8])
      .on("zoom", ({transform}) => {
        g.attr("transform", transform);
      }));

    // Setup simulation
    const simulation = d3.forceSimulation(data.nodes)
      .force("link", d3.forceLink(data.links).id(d => d.id).distance(120))
      .force("charge", d3.forceManyBody().strength(-300))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("collision", d3.forceCollide().radius(40));

    // Arrow markers
    svg.append("defs").append("marker")
      .attr("id", "arrow")
      .attr("viewBox", "0 -5 10 10")
      .attr("refX", 25)
      .attr("refY", 0)
      .attr("markerWidth", 6)
      .attr("markerHeight", 6)
      .attr("orient", "auto")
      .append("path")
      .attr("d", "M0,-5L10,0L0,5")
      .attr("fill", "#334155");

    // Draw links
    const link = g.append("g")
      .selectAll("path")
      .data(data.links)
      .join("path")
      .attr("class", "link")
      .attr("marker-end", "url(#arrow)");

    // Draw link labels
    const linkLabel = g.append("g")
      .selectAll("text")
      .data(data.links)
      .join("text")
      .attr("class", "link-label")
      .text(d => d.relation.toUpperCase());

    // Draw nodes
    const node = g.append("g")
      .selectAll("circle")
      .data(data.nodes)
      .join("circle")
      .attr("r", d => d.type === "summary" ? 14 : 10)
      .attr("class", d => \`node node-\${d.type}\`)
      .call(drag(simulation));

    // Draw labels
    const label = g.append("g")
      .selectAll("text")
      .data(data.nodes)
      .join("text")
      .attr("class", "node-label")
      .attr("dy", d => d.type === "summary" ? 24 : 20)
      .text(d => d.content.length > 25 ? d.content.slice(0, 25) + "..." : d.content);

    // Click behavior
    node.on("click", (event, d) => {
      const panel = d3.select("#info-panel");
      d3.select("#info-title").text(d.type.toUpperCase());
      d3.select("#info-content").text(d.content);
      
      const metaHtml = \`
        <div class="meta-item">Importance: <span class="meta-value">\${d.importance || 5}/10</span></div>
        <div class="meta-item">Access Count: <span class="meta-value">\${d.access_count}</span></div>
        <div class="meta-item">Decay Weight: <span class="meta-value">\${(d.decay_weight * 100).toFixed(0)}%</span></div>
        <div class="meta-item">Source: <span class="meta-value">\${d.source}</span></div>
        <div class="meta-item">Created: <span class="meta-value">\${new Date(d.created_at).toLocaleString()}</span></div>
        \${d.tags && d.tags.length ? \`<div class="meta-item">Tags: <span class="meta-value">\${d.tags.join(', ')}</span></div>\` : ''}
        \${d.archived ? \`<div class="meta-item" style="color:#ef4444;font-weight:bold;">ARCHIVED (SOFT-DELETED)</div>\` : ''}
      \`;
      d3.select("#info-meta").html(metaHtml);
      panel.classed("visible", true);
      event.stopPropagation();
    });

    // Dismiss panel on svg click
    svg.on("click", () => {
      d3.select("#info-panel").classed("visible", false);
    });

    // Search function
    d3.select("#search-input").on("input", function() {
      const q = this.value.toLowerCase().trim();
      if (!q) {
        node.classed("node-highlighted", false);
        return;
      }
      node.classed("node-highlighted", d => d.content.toLowerCase().includes(q));
    });

    simulation.on("tick", () => {
      link.attr("d", d => {
        return \`M\${d.source.x},\${d.source.y} L\${d.target.x},\${d.target.y}\`;
      });

      linkLabel
        .attr("x", d => (d.source.x + d.target.x) / 2)
        .attr("y", d => (d.source.y + d.target.y) / 2 - 4);

      node
        .attr("cx", d => d.x)
        .attr("cy", d => d.y);

      label
        .attr("x", d => d.x)
        .attr("y", d => d.y);
    });

    function drag(simulation) {
      function dragstarted(event, d) {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      }
      
      function dragged(event, d) {
        d.fx = event.x;
        d.fy = event.y;
      }
      
      function dragended(event, d) {
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      }
      
      return d3.drag()
        .on("start", dragstarted)
        .on("drag", dragged)
        .on("end", dragended);
    }
  </script>
</body>
</html>`;

  const htmlContent = template
    .replace("$NODES_JSON$", JSON.stringify(memories))
    .replace("$LINKS_JSON$", JSON.stringify(d3Links));

  writeFileSync(filePath, htmlContent, "utf-8");
}
