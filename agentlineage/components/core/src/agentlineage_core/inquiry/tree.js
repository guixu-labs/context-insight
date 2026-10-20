/* The report and manual explorer share this temporal evidence tree.
 * Coordinates remain lossless strings: Date rounds microseconds.
 * A row is a historical upstream -> downstream edge, not a click direction.
 */
(function (global) {
  "use strict";
  const scopeIdentity = n => JSON.stringify([n.kind, n.key, n.at, n.since ?? null]);
  const validCoordinate = n => n && ["file", "agent"].includes(n.kind) &&
    typeof n.key === "string" && n.key.length && typeof n.at === "string" && n.at.length;
  // A human-view policy only: the MCP/index retain every candidate.
  const visibleRelation = row => Boolean(row && !row.time_unknown &&
    (row.strength === "confirmed" || (row.source === "model_review" && row.evidence?.length)));
  class EvidenceTreeModel {
    constructor(root) {
      if (!validCoordinate(root)) throw Error("开树需要文件或 Agent 的完整身份及截止时间。");
      this.nodes = new Map();
      this.sequence = 0;
      this.root = this.makeNode(root, null, null, "root");
      this.rights = [];
      this.downstream = { loaded: false, loading: false, next: null, error: "" };
      this.unclosed = [];
    }
    makeNode(coordinate, parent, row, origin) {
      const node = {
        id: "tree-" + this.sequence++, coordinate: { ...coordinate },
        parent, row, children: [], claims: [], anchors: [], repairAnchors: [], origins: new Set([origin]),
        collapsed: false, loaded: false, loading: false, next: null,
        error: "", reference: null, modelSeen: false,
      };
      if (parent) {
        for (let ancestor = parent; ancestor; ancestor = ancestor.parent) {
          if (scopeIdentity(ancestor.coordinate) === scopeIdentity(coordinate) ||
              (row && ancestor.row && ancestor.row.id === row.id)) {
            node.reference = ancestor.id;
            break;
          }
        }
      }
      this.nodes.set(node.id, node);
      return node;
    }
    insert(parent, row, origin = "manual", direction = "upstream") {
      if (!row || !row.id || !validCoordinate(row.node) ||
          !["read", "write", "dispatch"].includes(row.relation) ||
          !["confirmed", "candidate"].includes(row.strength)) return null;
      if (!visibleRelation(row)) return null;
      // Neither a report nor a click can promote a candidate to confirmed.
      const key = JSON.stringify([row.id, scopeIdentity(row.node), row.strength, row.source]);
      if (direction === "downstream" && parent !== this.root) return null;
      const siblings = direction === "downstream" ? this.rights : parent.children;
      let child = siblings.find(n => n.edgeKey === key);
      if (child) { child.origins.add(origin); return child; }
      child = this.makeNode(row.node, parent, { ...row }, origin);
      child.edgeKey = key;
      child.isRight = direction === "downstream";
      siblings.push(child);
      parent.collapsed = false;
      return child;
    }
    seed(graph, finding = "") {
      const byId = new Map((graph.nodes || []).map(n => [n.id, n]));
      // Context arms use the very same checked edges, without being counted
      // as problem-node closure or upgrading a normal input to an origin.
      for (const path of [...(graph.tree?.paths || []), ...(graph.tree?.context_paths || [])]) {
        if (finding && path.finding !== finding) continue;
        if (path.repair_anchor) {
          const row = path.repair_anchor;
          const key = JSON.stringify([row.id, row.strength, row.source, scopeIdentity(row.node)]);
          let anchor = this.root.repairAnchors.find(a => a.key === key);
          if (!anchor) {
            anchor = { key, row, findings: new Set() };
            this.root.repairAnchors.push(anchor);
          }
          anchor.findings.add(path.finding);
        }
        if (path.status === "unclosed") { this.unclosed.push(path); continue; }
        const steps = path.steps || [];
        if (steps.some(row => !visibleRelation(row))) {
          this.unclosed.push({ ...path, diagnostic: "路径含尚未由模型复核的候选关系，本页暂不画出。" });
          continue;
        }
        const coordinates = new Set([scopeIdentity(this.root.coordinate)]);
        const operations = new Set();
        const invalid = steps.some((row, index) => {
          if (!row?.id || !validCoordinate(row.node) ||
              !["read", "write", "dispatch"].includes(row.relation) ||
              !["confirmed", "candidate"].includes(row.strength)) return true;
          const identity = scopeIdentity(row.node);
          const repeated = coordinates.has(identity) || operations.has(row.id);
          coordinates.add(identity);
          operations.add(row.id);
          return repeated && index < steps.length - 1;
        });
        if (invalid) {
          this.unclosed.push({ ...path, diagnostic: path.diagnostic || "路径包含无效关系或未闭合的循环。" });
          continue;
        }
        let node = this.root;
        let closed = true;
        for (const row of path.steps || []) {
          if (node.reference) { closed = false; break; }
          const child = this.insert(node, row, "report");
          if (!child) { closed = false; break; }
          node = child;
        }
        if (!closed) {
          this.unclosed.push({ ...path, diagnostic: path.diagnostic || "路径包含无法展开的引用或无效关系。" });
          continue;
        }
        const claim = byId.get(path.node);
        if (claim && !node.claims.some(n => n.id === claim.id)) node.claims.push(claim);
        if (path.anchor) node.anchors.push({ row: path.anchor, finding: path.finding, claim: path.node, status: path.status });
      }
      // Only exact coordinates can share additional report claims. The path's
      // terminal claim above keeps its original, possibly wider query scope.
      for (const node of this.nodes.values()) {
        for (const claim of graph.nodes || []) {
          if ((!finding || claim.finding === finding) && claim.exists === true &&
              !this.unclosed.some(path => path.node === claim.id) &&
              scopeIdentity(node.coordinate) === scopeIdentity(claim) &&
              !node.claims.some(n => n.id === claim.id)) node.claims.push(claim);
        }
      }
      if (!graph.tree) this.unclosed.push({ diagnostic: "此报告未提供可核的时间路径，请从根节点手动展开。" });
    }
    visible() {
      const rows = [];
      const visit = (node, depth) => {
        rows.push({ node, depth });
        if (!node.collapsed && !node.reference) node.children.forEach(n => visit(n, depth + 1));
      };
      visit(this.root, 0);
      if (!this.root.collapsed) this.rights.forEach(n => rows.push({ node: n, depth: -1 }));
      return rows;
    }
  }

  // Data projection only. The sole renderer is the original prototype in viewer.js.
  const exported = { EvidenceTreeModel, scopeIdentity, visibleRelation };
  if (typeof module !== "undefined" && module.exports) module.exports = exported;
  else global.InquiryEvidenceTree = exported;
})(typeof globalThis !== "undefined" ? globalThis : this);
