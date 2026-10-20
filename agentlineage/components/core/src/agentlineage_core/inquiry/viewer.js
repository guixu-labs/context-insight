/* Port of migbot-server's original fixchain.html, not a replacement renderer.
 * Presentation functions are retained verbatim; time/query adapters are below.
 * The query kernel and report attribution contract are unchanged.
 */
(function () {
    "use strict";
    var config = window.INQUIRY_CONFIG || {}, DATA = {fixes: [], fixers: [], reports: []};
    var IDX = null, XT = null, curRootKey = null, selTid = null, report = null;
    var navigation = 0, detailEpoch = 0, activeFinding = "", hiddenPaths = [], timeScope = null;
    var treeFrozen = false, expansionEpoch = 0;
    var dataReady = false, agentById = {}, chainByFile = {}, fixerIds = {};
    var chips = document.getElementById("chips"), rail = document.getElementById("rail");
    var railBody = document.getElementById("railbody"), qInput = document.getElementById("q");
    var railState = {q: "", closedSec: {}, closedKind: {spec: 1, src: 1, other: 1}, open: {}};
    var clearBtn = document.getElementById("clear"), side = document.getElementById("side");
    var scopeIdentity = InquiryEvidenceTree.scopeIdentity, visibleRelation = InquiryEvidenceTree.visibleRelation;
    function el(tag, cls, text) {
      var n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    }

    function baseName(path) { return String(path || "").replace(/\\/g, "/").split("/").pop(); }
    function agentKey(id) { return String(id || ""); }
    function agentLabelOf(id) { return (agentById[id] || {}).label || String(id || "未知").split(":").pop().replace(/-[0-9a-f]{16,}$/i, ""); }
    function shortTime(at) { return String(at || "").slice(11, 19); }
    function dateTime(at) { return String(at || "").slice(5, 19).replace("T", " "); }
    function isFixAt(id, at) { return !!(report && report.nodes.some(n => n.role === "repaired" && n.kind === "agent" && n.key === id && n.at === at)); }
    function hit(text) { return !railState.q || String(text || "").toLowerCase().includes(railState.q); }
    function nodeScope(node) { return node.scope; }
    function atom(scope, extra) { const {kind, ...rest} = scope; return {op: kind, ...rest, ...extra}; }
    async function api(route, data) {
      const res = await fetch((config.api_base || "") + route, {method: data === undefined ? "GET" : "POST",
        headers: {"Content-Type": "application/json"}, body: data === undefined ? undefined : JSON.stringify(data)});
      const value = await res.json(); if (!res.ok) throw Error(value.error || "读取失败"); return value;
    }
    function query(q) { return api("/api/query", q); }
    function view(scope, name, extra) { return api("/api/view", {...scope, view: name, ...extra}); }
    function fail(error, host) { (host || side).appendChild(el("div", "kv error", error.message || String(error))); }
    function guard(fn) { return Promise.resolve().then(fn).catch(error => fail(error, document.querySelector("dialog[open]"))); }
    function setUrl(scope, reportId) {
      try {
        const url = new URL(location.href);
        ["report", "report_id", "probe"].forEach(name => url.searchParams.delete(name));
        url.hash = "";
        if (reportId) url.searchParams.set("report", reportId);
        else if (scope) url.hash = new URLSearchParams({kind: scope.kind, key: scope.key, at: scope.at,
          ...(scope.since ? {since: scope.since} : {}), ...(scope.operation ? {operation: scope.operation} : {})}).toString();
        history.replaceState(null, "", url);
      } catch (_) {}
    }
    function asScope(spec) { return {kind: spec.kind, key: spec.key || spec.path || spec.id,
      at: spec.at || (IDX && IDX.at), since: spec.since || null}; }
    function pill(t, cls) { return el("span", "pill " + (cls || ""), t); }
    function rsec(title, count, key, body) {
      var s = el("div", "rsec" + (railState.closedSec[key] ? " closed" : ""));
      var h = el("div", "rsh");
      h.appendChild(el("span", null, title));
      h.appendChild(el("span", "n", "(" + count + ")"));
      h.appendChild(el("span", "chev", railState.closedSec[key] ? "▸" : "▾"));
      h.addEventListener("click", function () { railState.closedSec[key] = !railState.closedSec[key]; renderRail(); });
      s.appendChild(h);
      var list = el("div", "rlist");
      body(list);
      s.appendChild(list);
      return s;
    }
    function ritem(key, labelNode, pills, onExpand) {
      var it = el("div", "ritem" + (railState.open[key] ? " open" : "") + (curRootKey === key ? " on" : ""));
      var row = el("div", "rrow");
      row.appendChild(labelNode);
      (pills || []).forEach(function (p) { if (p) row.appendChild(p); });
      it.appendChild(row);
      var vers = el("div", "vers");
      it.appendChild(vers);
      row.addEventListener("click", function () {
        railState.open[key] = !railState.open[key];
        it.classList.toggle("open", !!railState.open[key]);
        if (railState.open[key] && !vers.childNodes.length) { vers.textContent = "装配中…"; onExpand(vers); }
      });
      if (railState.open[key]) { vers.textContent = "装配中…"; onExpand(vers); }
      return it;
    }
    function vline(vn, text, cls, onClick) {
      var v = el("div", "vline " + (cls || ""));
      v.appendChild(el("span", "vn", vn));
      v.appendChild(el("span", "t", text));
      v.title = text;
      v.addEventListener("click", function (ev) { ev.stopPropagation(); onClick(); });
      return v;
    }

    var KIND_LABEL = {ets: "ArkTS 源码 (.ets)", spec: "Spec / 配置 (.md .json)", src: "安卓源码 (.java .kt .xml)", other: "其它"};
    async function atomTimes(vers, kind, key, offset) {
      var scope = {kind: kind, key: key, at: IDX.at};
      try {
        var page = await view(scope, "history", {category: "changes", limit: 100, offset: offset || 0});
        if (!offset) {
          vers.textContent = "";
          vers.appendChild(vline("最新", "截至 " + dateTime(IDX.at) + " · 全部历史", "", function () { guard(() => openRoot(scope)); }));
        }
        page.rows.forEach(function (row) {
          var label = row.label + " · " + (kind === "file" ? agentLabelOf(row.agent) : baseName(row.file));
          var line = vline(shortTime(row.at), label, "", function () {
            guard(() => openRoot({kind: kind, key: key, at: row.at, operation: row.id}));
          });
          line.title = row.at + " · " + label; vers.appendChild(line);
        });
        if (page.next != null) {
          var more = lnk("继续展开时间记录", "more", function () { more.remove(); atomTimes(vers, kind, key, page.next); });
          vers.appendChild(more);
        }
      } catch (error) { vers.textContent = error.message; }
    }
    function fileVersLines(vers, path) { atomTimes(vers, "file", path); }
    function agentVersLines(vers, id) { atomTimes(vers, "agent", id); }
    async function migrationEntries() {
      if (Array.isArray(config.fixed_files)) return config.fixed_files.map(f=>typeof f==="string"?{id:f,label:baseName(f)}:f);
      if (!config.fixchain_data_url) return [];
      var response=await fetch(config.fixchain_data_url),data=await response.json();
      if(!response.ok)throw Error(data.error||"返修入口读取失败");
      var byFile=new Map();
      (data.chains||[]).forEach(c=>{var file=c.file_abs||c.file;if(file&&!byFile.has(file))byFile.set(file,{id:file,label:baseName(file)});});
      return [...byFile.values()];
    }
    async function refreshReports(meta) {
      meta=meta||await api("/api/view",{view:"overview"});
      var rows=(meta.reports||[]).slice(),next=meta.reports_next;
      while(next!=null){var page=await api("/api/view",{view:"reports",offset:next,limit:100});rows.push(...page.rows);next=page.next;}
      DATA.reports=rows;renderRail();
    }
    function attributionSection() {
      var rows=DATA.reports.filter(r=>hit(r.file)||hit(r.title));
      var section=rsec("模型归因",rows.length,"reports",function(list){
        rows.forEach(function(r){
          var item=el("div","attribution-row"),label=el("span","lab mono",baseName(r.file));
          item.dataset.reportId=r.id;item.dataset.file=r.file;label.title=r.file+"\n"+r.title;
          var button=el("button","attribution-load",report?.report_id===r.id?"已载入":"载入");
          button.type="button";button.setAttribute("aria-label","载入 "+baseName(r.file)+" 的归因链");
          button.onclick=function(){guard(async()=>{button.disabled=true;try{await loadReport(r.id);}finally{button.disabled=false;}});};
          item.appendChild(label);item.appendChild(button);list.appendChild(item);
        });
        if(!rows.length)list.appendChild(el("div","rempty",railState.q?"无匹配归因":"本次迁移暂无归因结果"));
        var action=lnk(report?"查看当前归因详情":"导入归因结果","more",()=>guard(reportsDialog));
        action.id="load";action.classList.add("attribution-details");list.appendChild(action);
      });
      section.id="attributions";return section;
    }
    function renderRail() {
      railBody.innerHTML = "";
      if (!dataReady && !IDX) { railBody.appendChild(el("div", "rempty", "账本装配中…")); return; }
      railBody.appendChild(attributionSection());
      // 返修入口
      if (dataReady) {
        var fx = (DATA.fixes || []).filter(function (f) { return hit(f.label) || hit(f.id); });
        var fr = (DATA.fixers || []).filter(function (f) { return hit(f.label) || hit(f.id); });
        var repairSection=rsec("返修入口", fx.length + fr.length, "fix", function (list) {
          fx.forEach(function (f) {
            var lab = el("span", "lab mono", "★ " + f.label);
            list.appendChild(ritem("F:" + f.id, lab, [pill("被修", "warn")], function (vers) { fileVersLines(vers, f.id); }));
          });
          fr.forEach(function (f) {
            var lab = el("span", "lab", f.label);
            lab.style.color = "var(--c-fix)";
            list.appendChild(ritem("A:agent-" + agentKey(f.id), lab, [pill("修复方", "warn")], function (vers) { agentVersLines(vers, f.id); }));
          });
          if (DATA.fixesError) {list.appendChild(el("div","rempty error",DATA.fixesError));
            list.appendChild(lnk("重试读取返修入口","more",()=>guard(async()=>{DATA.fixes=await migrationEntries();DATA.fixesError=null;indexRepairEntries();renderRail();})));}
          else if (!fx.length && !fr.length) list.appendChild(el("div", "rempty",railState.q?"无匹配":"暂无返修入口"));
        });repairSection.id="repair-entries";railBody.appendChild(repairSection);
      }
      if (!IDX) { railBody.appendChild(el("div", "rempty", "目录装配中…")); return; }
      // agent:按会话、按派发层级缩进
      var ags = IDX.agents || [];
      var kids = {};
      ags.forEach(function (a) { (kids[a.parent || ""] = kids[a.parent || ""] || []).push(a); });
      var shown = 0, visited = {};
      var agBox = rsec("Agent", ags.length, "ag", function (list) {
        function emit(a, depth) {
          if (visited[a.id]) return null; visited[a.id] = true;
          var m = hit(a.label) || hit(a.id) || hit(a.kind) || hit(a.session);
          var sub = kids[a.id] || [];
          var childNodes = [];
          sub.forEach(function (c) { var n = emit(c, depth + 1); if (n) childNodes.push(n); });
          if (!m && !childNodes.length) return null;
          var lab = el("span", "lab");
          if (depth) lab.appendChild(el("span", "ind", "└ ".padStart(depth * 2 + 2, "　")));
          lab.appendChild(document.createTextNode(a.label));
          lab.title = a.id + (a.kind ? " · " + a.kind : "");
          var ps = [pill("写 " + a.n_events)];
          if (fixerIds[agentKey(a.id)]) ps.push(pill("修复方", "warn"));
          var it = ritem("A:" + a.id, lab, ps, function (vers) { agentVersLines(vers, a.id); });
          shown += 1;
          var frag = document.createDocumentFragment();
          frag.appendChild(it);
          childNodes.forEach(function (n) { frag.appendChild(n); });
          return frag;
        }
        (kids[""] || []).forEach(function (a) { var n = emit(a, 0); if (n) list.appendChild(n); });
        ags.forEach(function(a) { if (!visited[a.id]) { var n = emit(a, 0); if(n) list.appendChild(n); } });
        if (!shown) list.appendChild(el("div", "rempty", "无匹配"));
      });
      railBody.appendChild(agBox);
      // 文件:按类型分组,被修的 ★
      var files = (IDX.files || []).filter(function (f) { return hit(baseName(f.path)) || hit(f.path); });
      railBody.appendChild(rsec("文件", files.length, "fl", function (list) {
        ["ets", "spec", "src", "other"].forEach(function (kind) {
          var fs = files.filter(function (f) { return f.kind === kind; });
          if (!fs.length) return;
          fs.sort(function (a, b) {
            var fa = chainByFile[a.path] ? 0 : 1, fb = chainByFile[b.path] ? 0 : 1;
            if (fa !== fb) return fa - fb;
            var wa = a.has_writer ? 0 : 1, wb = b.has_writer ? 0 : 1;
            if (wa !== wb) return wa - wb;
            return baseName(a.path).localeCompare(baseName(b.path));
          });
          var closed = !!railState.closedKind[kind] && !railState.q;
          var kh = el("div", "rkind" + (closed ? " closed" : ""));
          kh.appendChild(el("span", null, KIND_LABEL[kind]));
          kh.appendChild(el("span", null, "(" + fs.length + ")"));
          kh.appendChild(el("span", "chev", closed ? "▸" : "▾"));
          kh.addEventListener("click", function () { railState.closedKind[kind] = !railState.closedKind[kind]; renderRail(); });
          list.appendChild(kh);
          var kl = el("div", "rklist");
          fs.slice(0, 400).forEach(function (f) {
            var lab = el("span", "lab mono", (chainByFile[f.path] ? "★ " : "") + baseName(f.path));
            lab.title = f.path;
            var ps = [pill("写 " + f.n_events), f.has_writer ? null : pill("未见写入", "via")];
            kl.appendChild(ritem("F:" + f.path, lab, ps, function (vers) { fileVersLines(vers, f.path); }));
          });
          if (fs.length > 400) kl.appendChild(el("div", "rempty", "还有 " + (fs.length - 400) + " 个,搜索缩小范围"));
          list.appendChild(kl);
        });
        if (!files.length) list.appendChild(el("div", "rempty", "无匹配"));
      }));
    }

    function indexRepairEntries() {
      chainByFile={};DATA.fixes.forEach(f=>chainByFile[f.id]={});
      var count=document.getElementById("repairCount");if(count)count.textContent=DATA.fixes.length+" 个返修入口";
    }


    // Native time relations are adapted into the original prototype's XT nodes.
    function xtNode(kind, props) {
      var n = { tid: "t" + (XT.seq++), kind: kind, children: null, expanded: false,
                depth: 0, parent: null, busy: false, badges: [] };
      Object.keys(props).forEach(function (k) { n[k] = props[k]; });
      XT.byId[n.tid] = n;
      return n;
    }
    function addKid(node, kid) {
      kid.parent = node.tid;
      kid.depth = node.depth + 1;
      node.children.push(kid.tid);
      return kid;
    }
    function addRight(root, kid) {
      kid.parent = root.tid;
      kid.depth = -1;
      kid.isRight = true;
      XT.rights.push(kid.tid);
      return kid;
    }
    function collapse(node) {
      (node.children || []).forEach(function (tid) {
        var kid = XT.byId[tid];
        if (kid) { collapse(kid); delete XT.byId[tid]; }
      });
      node.children = null;
      node.expanded = false;
    }

    function decorateScope(scope, extra) {
      var name = scope.kind === "file" ? baseName(scope.key) : agentLabelOf(scope.key);
      return xtNode(scope.kind, {scope: {...scope}, path: scope.kind === "file" ? scope.key : null,
        aid: scope.kind === "agent" ? scope.key : null, at: scope.at,
        label: name + " @" + shortTime(scope.at), claims: [], rows: [], ...extra});
    }
    function rowKey(row) { return JSON.stringify([row.id, scopeIdentity(row.node), row.strength, row.source]); }
    function relationNode(parent, row, downstream) {
      if (!visibleRelation(row) || !row.id || !row.node || !["file","agent"].includes(row.node.kind)) return null;
      var siblings = downstream ? XT.rights : (parent.children || (parent.children = []));
      var existing = siblings.map(id => XT.byId[id]).find(n => n.row && rowKey(n.row) === rowKey(row));
      if (existing) {
        if(row.groupRows) { existing.groupRows=row.groupRows; existing.badges=existing.badges.filter(b=>!b.group);
          if(row.groupRows.length>1)existing.badges.push({t:row.groupRows.length+" 次写入",cls:"",group:true}); }
        return existing;
      }
      var cycle = null;
      for (var n = parent; n; n = XT.byId[n.parent]) {
        if (scopeIdentity(n.scope) === scopeIdentity(row.node) || n.row && n.row.id === row.id) { cycle = n.tid; break; }
      }
      var node = decorateScope(row.node, {row: row, groupRows: row.groupRows || [row], isDispatch: row.relation === "dispatch", reference: cycle,
        operation: row.source === "indexed" && row.id.startsWith("native:") ? row.id.slice(7) : null});
      if (node.isDispatch) node.label = "⇠ 派发 " + node.label;
      if(node.groupRows.length>1)node.badges.push({t:node.groupRows.length+" 次写入",cls:"",group:true});
      if (cycle) node.badges.push({t: "已展开", cls: ""});
      return downstream ? addRight(parent, node) : addKid(parent, node);
    }
    async function expandRelations(node, direction, done) {
      if (treeFrozen) return;
      var epoch = expansionEpoch;
      var tree = XT, state = direction === "downstream" ? (node.downstream || (node.downstream = {})) : node;
      if (state.loaded && state.next == null) { node.busy = false; if(done)done(); return; }
      state.error = ""; node.busy = true;
      try {
        const q = atom(node.scope, {view: "neighbors", direction: direction, limit: 100});
        if (state.next != null) q.offset = state.next;
        if (report) { q.report_id = report.report_id; if (activeFinding) q.finding = activeFinding; }
        var page;
        do {
          page = await query(q); if (XT !== tree || epoch !== expansionEpoch) return;
          if (page.rows.some(visibleRelation) || page.next == null) break;
          q.offset = page.next;
        } while (true);
        // Continuations are controls, never relation-bearing leaves.
        var prior = (node.children || []).map(id => XT.byId[id]).find(n => n.moreFor);
        if (prior) { node.children = node.children.filter(id => id !== prior.tid); delete XT.byId[prior.tid]; }
        // Original file->writer grouping. Keep every native event in the group;
        // the node opens the writer at the last of those writes, not a new event.
        var groups=new Map(), rows=[];
        page.rows.forEach(function(row) {
          if(node.kind==="file" && direction==="upstream" && row.relation==="write" && row.strength==="confirmed" && row.source==="indexed") {
            var group=groups.get(row.node.key); if(!group){group=[];groups.set(row.node.key,group);} group.push(row);
          } else rows.push(row);
        });
        groups.forEach(function(group){var latest=group.reduce((a,b)=>a.node.at<b.node.at?b:a);rows.push({...latest,groupRows:group});});
        rows.forEach(row => relationNode(node, row, direction === "downstream"));
        state.loaded = true; state.next = page.next; state.total = page.total; node.expanded = true;
        if (page.next != null && direction === "upstream") {
          addKid(node, xtNode("leaf", {label: "+ 继续展开", moreFor: node.tid, noEdge: true}));
        }
      } catch (error) { if (epoch === expansionEpoch) state.error = error.message; }
      finally { if(XT === tree) { node.busy = false; if(direction === "upstream")expansionFeedback(node); if(done)done(state.error); } }
    }
    function expandFile(node, done) { return expandRelations(node, "upstream", done); }
    function expandAgent(node, done) { return expandRelations(node, "upstream", done); }
    function setFrozen(value) {
      treeFrozen = Boolean(value); ++expansionEpoch;
      var button = document.getElementById("freeze");
      button.disabled = !XT;
      button.setAttribute("aria-pressed", String(treeFrozen));
      button.textContent = treeFrozen ? "已冻结" : "冻结展开";
      button.title = treeFrozen ? "点击解冻，允许展开和收起；当前点击节点只查看详情。" : "冻结当前树，点击节点只查看详情。";
      graphEl.classList.toggle("tree-frozen", treeFrozen);
      document.getElementById("summary").hidden = !report;
    }
    function inspectNode(tid) {
      var node = XT?.byId[tid]; if (!node || node.kind === "leaf") return;
      selTid = tid;
      Object.keys(nodeEls).forEach(id => nodeEls[id].classList.toggle("sel", id === tid));
      side.scrollTop = 0;
      if(node.kind === "file") drawerFile(node); else drawerAgent(node);
    }
    function onNode(tid) {
      var node = XT.byId[tid]; if(!node)return;
      if(node.moreFor) { if(treeFrozen)return; const parent=XT.byId[node.moreFor]; parent.busy=true; expandRelations(parent, "upstream", ()=>renderTree(treeFrozen?null:parent.tid)); return; }
      inspectNode(tid);
      if(treeFrozen)return;
      if(node.busy || node.kind === "leaf" || node.isRight || node.reference) { renderTree(tid); return; }
      if(node.loaded && node.next == null && !(node.children || []).length && !node.error) { renderTree(tid); return; }
      if(node.expanded && !node.error) { collapse(node); node.loaded=false; node.next=null; renderTree(tid); return; }
      node.busy = true;
      renderTree(tid);
      var done = function() { renderTree(treeFrozen?null:tid); };
      if(node.kind === "file") expandFile(node, done); else expandAgent(node, done);
    }
    function rootLabel(node) {
      curRootKey = (node.kind === "file" ? "F:" : "A:") + node.scope.key;
      var label = document.getElementById("rootlbl"); label.innerHTML = "从 <b></b> 出发";
      label.querySelector("b").textContent = node.label; label.title = node.scope.key + "\n" + node.scope.at;
      clearBtn.classList.add("show"); renderRail();
    }
    async function openRoot(spec) {
      var epoch = ++navigation, scope = asScope(spec);
      const resolved = await view(scope, "history", {limit: 1}); if(epoch !== navigation)return;
      scope = resolved.scope; report = null; activeFinding = ""; hiddenPaths = [];
      XT = {byId: {}, seq: 0, root: null, rights: [], rootKind: scope.kind};
      setFrozen(false);
      var root = decorateScope(scope, {isRoot: true, operation: spec.operation}); XT.root=root.tid;
      selTid=root.tid; autoFit=true; rootLabel(root);
      root.busy=true; renderTree(root.tid);
      if(scope.kind==="file")drawerFile(root);else drawerAgent(root);
      await Promise.all([expandRelations(root,"upstream"),expandRelations(root,"downstream")]);
      if(epoch!==navigation)return; renderTree(root.tid); setUrl({...scope,operation:spec.operation});
    }
    function nodeCls(node) {
      var c = node.kind === "agent" ? node.isDispatch ? "dispatch" : (isFixAt(node.aid,node.at) ? "fix" : "gen") : node.kind === "leaf" ? "leaf" : "file";
      if (node.isRoot) c += " root"; if(node.isRight)c += " down";
      if (node.row && node.row.source === "model_review") c += " reviewed";
      if (!node.isRoot && (node.claims||[]).some(n => ["origin","propagated","problem"].includes(n.role))) c += " problem";
      return c;
    }
    var NODE_W = 196, NODE_H = 30, GAP_Y = 8, GAP_X = 74, TOP = 34;
    function measure(n) {
      var kids = (n.children || []).map(function (t) { return XT.byId[t]; }).filter(Boolean);
      if (!kids.length) { n.ext = NODE_H; return n.ext; }
      var total = 0;
      kids.forEach(function (k) { total += measure(k); });
      total += GAP_Y * (kids.length - 1);
      n.ext = Math.max(NODE_H, total);
      return n.ext;
    }
    function place(n, y0) {
      n.y = y0 + (n.ext - NODE_H) / 2;
      var kids = (n.children || []).map(function (t) { return XT.byId[t]; }).filter(Boolean);
      if (!kids.length) return;
      var total = 0;
      kids.forEach(function (k) { total += k.ext; });
      total += GAP_Y * (kids.length - 1);
      var cy = y0 + (n.ext - total) / 2;
      kids.forEach(function (k) { place(k, cy); cy += k.ext + GAP_Y; });
    }
    var svg = document.getElementById("wires");
    var canvas = document.getElementById("canvas");
    var graphEl = document.getElementById("graph");
    var nodeEls = {};
    var zoom = 1;
    var autoFit = true;
    var layoutSize = { w: 0, h: 0 };
    var spacer = el("div", null, "");
    spacer.style.position = "relative";
    spacer.style.pointerEvents = "none";
    graphEl.appendChild(spacer);
    canvas.style.position = "absolute";
    canvas.style.left = "0";
    var toolbarEl = graphEl.querySelector(".toolbar");
    function canvasTop() { return toolbarEl.offsetHeight + 6; }   // 图例可能折行,列头不能被盖住
    function applyZoom(z, keepAuto) {
      zoom = Math.max(0.08, Math.min(2.5, z));
      if (!keepAuto) autoFit = false;
      canvas.style.top = canvasTop() + "px";
      canvas.style.transform = "scale(" + zoom + ")";
      canvas.style.width = layoutSize.w + "px";
      canvas.style.height = layoutSize.h + "px";
      spacer.style.width = (layoutSize.w * zoom) + "px";
      spacer.style.height = (layoutSize.h * zoom) + "px";
    }
    // 自动适应有下限:树长大后不再一味缩小,到 MIN_AUTO 停住、靶点滚进视野;"适应"按钮不受下限约束
    var MIN_AUTO = 0.62;
    function fitView(floor) {
      var gw = graphEl.clientWidth - 8, gh = graphEl.clientHeight - canvasTop() - 8;
      var k = Math.min(gw / (layoutSize.w || 1), gh / (layoutSize.h || 1), 1);
      if (floor != null) k = Math.max(k, floor);
      applyZoom(k, true);
      autoFit = true;
      if (floor == null) { graphEl.scrollLeft = 0; graphEl.scrollTop = 0; }
    }
    function renderTree(focusTid) {
      var root = XT.byId[XT.root];
      measure(root);
      var rightsH = XT.rights.length ? XT.rights.length * (NODE_H + GAP_Y) - GAP_Y : 0;
      var top = TOP + Math.max(0, (rightsH - root.ext) / 2);
      place(root, top);
      var maxD = 0;
      Object.keys(XT.byId).forEach(function (tid) { var n = XT.byId[tid]; if (n.depth > maxD) maxD = n.depth; });
      var colX = function (d) { return 24 + (maxD - d) * (NODE_W + GAP_X); };
      var rightsX = colX(0) + NODE_W + GAP_X;
      var totalH = Math.max(root.ext, rightsH) + TOP + 40;
      var totalW = (XT.rights.length ? rightsX + NODE_W : colX(0) + NODE_W) + 30;
      layoutSize = { w: totalW, h: totalH };
      nodeEls = {};
      canvas.innerHTML = "";
      canvas.appendChild(svg);
      svg.setAttribute("width", totalW); svg.setAttribute("height", totalH);
      svg.style.width = totalW + "px"; svg.style.height = totalH + "px";
      for (var d = 0; d <= maxD; d++) {
        var title = d === 0 ? (root.kind === "file" ? "ROOT · 文件" : "ROOT · agent") : "上游 " + d;
        var h = el("div", "colhead" + (d === 0 ? (root.kind === "file" ? " root" : " rootA") : ""), title);
        h.style.left = colX(d) + "px"; h.style.width = NODE_W + "px";
        canvas.appendChild(h);
      }
      if (XT.rights.length) {
        var hf = el("div", "colhead down", root.kind === "file" ? "下游 · 读者" + (XT.rights.some(function (t) { return XT.byId[t].isFixer; }) ? " / 修复方" : "") : "下游 · 产出");
        hf.style.left = rightsX + "px"; hf.style.width = NODE_W + "px";
        canvas.appendChild(hf);
        var ry = root.y + NODE_H / 2 - rightsH / 2;
        XT.rights.forEach(function (tid) { var n = XT.byId[tid]; n.x = rightsX; n.y = Math.max(TOP, ry); ry += NODE_H + GAP_Y; });
      }
      Object.keys(XT.byId).forEach(function (tid) {
        var n = XT.byId[tid];
        if (n.depth >= 0) n.x = colX(n.depth);
        addTreeNode(n);
      });
      drawEdges();
      if (autoFit) fitView(MIN_AUTO);
      else applyZoom(zoom);
      if (focusTid && nodeEls[focusTid]) {
        var n0 = XT.byId[focusTid];
        var kids = (n0.children || []).map(function (t) { return XT.byId[t]; }).filter(Boolean);
        var tgt = kids.length ? kids[0] : n0;
        var cx = (tgt.x + NODE_W / 2) * zoom, cy = (tgt.y + NODE_H / 2) * zoom + canvasTop();
        var vw = graphEl.clientWidth, vh = graphEl.clientHeight;
        if (cx < graphEl.scrollLeft + 40 || cx > graphEl.scrollLeft + vw - 40) graphEl.scrollLeft = Math.max(0, cx - vw / 2);
        if (cy < graphEl.scrollTop + 60 || cy > graphEl.scrollTop + vh - 40) graphEl.scrollTop = Math.max(0, cy - vh / 2);
      }
    }
    function addTreeNode(node) {
      var d = el("div", "node " + nodeCls(node) + (node.tid === selTid ? " sel" : ""));
      d.style.left = node.x + "px"; d.style.top = node.y + "px"; d.style.width = NODE_W + "px";
      d.dataset.tid = node.tid;
      if (node.scope) { d.dataset.key=node.scope.key; d.dataset.at=node.scope.at; }
      var suffix = node.at ? " @" + shortTime(node.at) : null;
      if (suffix && String(node.label).endsWith(suffix)) {
        var caption = el("span", "node-caption");
        caption.appendChild(el("span", "node-name", String(node.label).slice(0, -suffix.length)));
        caption.appendChild(el("span", "node-version", suffix));
        d.appendChild(caption);
      } else d.appendChild(document.createTextNode(node.label));
      (node.badges || []).forEach(function (b) { d.appendChild(el("span", "badge " + (b.cls || ""), b.t)); });
      var ended = node.loaded && node.next == null && !(node.children || []).length;
      if (node.kind !== "leaf" && !node.isRight) d.appendChild(el("span", "chev", node.busy ? "…" : node.error ? "!" : node.reference ? "↗" : ended ? "·" : node.expanded ? "▾" : "▸"));
      d.title = (node.kind === "file" ? node.path : node.kind === "agent" ? node.aid : node.label)
              + ((node.badges || []).length ? "  [" + node.badges.map(function (b) { return b.t; }).join(" · ") + "]" : "")
              + (node.isRight ? "  (下游节点:抽屉里可「以此为根」)" : "");
      if(node.scope)d.title += "\n截至 " + node.scope.at;
      if(node.error)d.title += "\n查询失败，可点击重试";
      else if(ended)d.title += "\n此时间范围内未找到可展开的已确认上游；仍可查看原文。";
      d.addEventListener("click", function (ev) { ev.stopPropagation(); onNode(node.tid); });
      d.addEventListener("mouseenter", function () { hiliteEdges(node.tid, true); });
      d.addEventListener("mouseleave", function () { hiliteEdges(node.tid, false); });
      canvas.appendChild(d);
      nodeEls[node.tid] = d;
    }
    var wireByTid = {};
    function drawEdges() {
      svg.innerHTML = "";
      wireByTid = {};
      var frag = document.createDocumentFragment();
      Object.keys(XT.byId).forEach(function (tid) {
        var n = XT.byId[tid];
        if (!n.parent || n.noEdge) return;
        var p = XT.byId[n.parent];
        if (!p) return;
        var a, b;
        if (n.x < p.x) { a = n; b = p; } else { a = p; b = n; }
        var x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2, x2 = b.x, y2 = b.y + NODE_H / 2;
        var mx = (x1 + x2) / 2;
        var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", "M" + x1 + "," + y1 + " C" + mx + "," + y1 + " " + mx + "," + y2 + " " + x2 + "," + y2);
        path.setAttribute("class", "wire" + (n.row && n.row.source==="model_review" ? " reviewed" : ""));
        if(n.row) {path.dataset.edge=n.row.id;path.dataset.source=n.row.source;path.dataset.strength=n.row.strength;}
        frag.appendChild(path);
        (wireByTid[tid] = wireByTid[tid] || []).push(path);
        (wireByTid[n.parent] = wireByTid[n.parent] || []).push(path);
      });
      svg.appendChild(frag);
    }
    function hiliteEdges(tid, on) {
      (wireByTid[tid] || []).forEach(function (p) { p.classList.toggle("on", on); });
    }
    window.addEventListener("resize", function () { if (XT && autoFit) fitView(MIN_AUTO); });

    function head(cls, tag, title, sub, rootSpec) {
      var h = el("div", "head " + cls);
      h.appendChild(el("div", "tag", tag));
      h.appendChild(el("h3", cls === "file" ? "mono" : "", title));
      if (sub) h.appendChild(el("div", "sub", sub));
      if (rootSpec) {
        var b = el("button", "rootbtn", "以此为根开树 →");
        b.addEventListener("click", function () { openRoot(rootSpec); });
        h.appendChild(b);
      }
      return h;
    }
    function sec(label) {
      var s = el("div", "sec");
      if (label) s.appendChild(el("b", null, label));
      return s;
    }
    function kv(k, v) {
      var d = el("div", "kv");
      d.appendChild(el("span", "k", k));
      d.appendChild(document.createTextNode(v));
      return d;
    }
    function pills(items) {
      var p = el("div", "pills");
      items.forEach(function (it) { if (it) p.appendChild(el("span", "pill " + (it.cls || ""), it.t)); });
      return p;
    }
    function lnk(text, cls, fn) {
      var a = el("span", "lnk " + (cls || ""), text);
      a.addEventListener("click", function (ev) { ev.stopPropagation(); fn(); });
      return a;
    }
    function quote(cls, label, text) {
      var q = el("div", "quote " + cls);
      q.appendChild(el("b", null, label));
      q.appendChild(document.createTextNode(text));
      return q;
    }
    function quoteLong(cls, label, text) {
      text = String(text || "");
      if (text.length <= 360) return quote(cls, label, text);
      var q = el("div", "quote " + cls);
      q.appendChild(el("b", null, label));
      var body = document.createTextNode(text.slice(0, 360) + "…");
      q.appendChild(body);
      var more = el("span", "more", " 展开全文(" + text.length + " 字)");
      more.addEventListener("click", function () { body.textContent = text; more.remove(); });
      q.appendChild(more);
      return q;
    }

    // Same drawer elements as the prototype; exact observations replace replay.
    function foldSection(title, parent, loader) {
      var box=sec("▸ "+title), loaded=false; box.classList.add("folded","foldable");
      box.firstChild.onclick=function() {
        box.classList.toggle("folded"); box.firstChild.textContent=(box.classList.contains("folded")?"▸ ":"▾ ")+title;
        if(!loaded&&!box.classList.contains("folded")){loaded=true; Promise.resolve(loader(box)).catch(error=>{loaded=false;fail(error,box);});}
      }; parent.appendChild(box); return box;
    }
    function rawLink(parent, ref, scope, title) {
      var pre=null, link=lnk(title||"原文", "more", async function() {
        if(pre){pre.remove();pre=null;link.textContent=title||"原文";return;}
        pre=el("pre","diffblock","加载原文…");parent.appendChild(pre);link.textContent="收起";
        const panel=pre; // A closed/reopened disclosure belongs to a new request.
        try {
          var raw=await query({op:"open",ref:ref,at:scope.at,...(scope.since?{since:scope.since}:{})});
          if(pre===panel&&panel.isConnected)panel.textContent=raw.text;
        } catch(error){if(pre===panel&&panel.isConnected){panel.textContent=error.message;panel.classList.add("error");}}
      });parent.appendChild(link);return link;
    }
    function paintOriginal(parent, text) {
      var lines=text.replace(/\n$/, "").split("\n"),pre=el("pre","srcblock");
      function paint(n){pre.innerHTML="";lines.slice(0,n).forEach(function(line){pre.appendChild(el("span","ln",line));});}
      paint(80); parent.appendChild(pre);
      if(lines.length>80) {var more=lnk("展开全部 "+lines.length+" 行","more",function(){paint(lines.length);more.remove();});parent.appendChild(more);}
    }
    async function contentSection(holder, scope, operation) {
      holder.textContent="";var box=sec("原文观察"+(operation?" · 此次调用":""));
      if(operation)holder.dataset.shownOperation=operation;
      holder.appendChild(box);
      if(!operation){box.appendChild(kv("状态","从下方选择一次写入或读取，查看记录中的原文；不推演时刻之间的完整文件。"));return;}
      try {
        var data=await view(scope,"operation",{id:operation});
        box.firstChild.textContent="原文观察 · "+dateTime(data.at);
        box.appendChild(pills([{cls:data.content!=null?"ok":"warn",t:data.content_kind==="write_body"?"这次写入的全文":data.content_kind==="read_observation"?"Read 返回 · 可能是片段":data.content_kind==="command_read_observation"?"命令读取回执 · 可能含多个文件":"只有修改片段，完整内容未知"}]));
        if(data.content!=null)paintOriginal(box,data.content);
        else {
          var parts=data.changes.filter(x=>x.kind!=="snapshot_folded");
          if(parts.length){var patch=el("pre","diffblock");box.appendChild(patch);paintDiff(patch,parts);}
        }
        box.appendChild(kv("边界",data.note));
        var raw=sec("原始调用与回执");box.appendChild(raw);
        data.originals.forEach(function(ref){rawLink(raw,ref.ref,scope,ref.source.split("/").pop()+":"+ref.line);raw.appendChild(document.createTextNode(" "));});
      }catch(error){fail(error,box);}
    }
    function paintDiff(holder, parts) {
      holder.textContent="";
      parts.map(x=>x.text).join("\n").split("\n").forEach(function(ln){
        var row=document.createElement("span");row.textContent=ln;
        row.className=ln.charAt(0)==="+"?"dl-add":ln.charAt(0)==="-"?"dl-del":ln.charAt(0)==="@"?"dl-ctx":"";
        holder.appendChild(row);holder.appendChild(document.createTextNode("\n"));
      });
    }
    async function diffInto(holder, scope, operation) {
      holder.textContent="加载 diff…";
      try {
        var data=await view(scope,"operation",{id:operation}),parts=data.changes.filter(x=>x.kind!=="snapshot_folded");
        if(!parts.length){holder.textContent="整文件写入；没有可核的前态差异。点「原文」看这次提交的全文。";return;}
        paintDiff(holder,parts);
      }catch(error){holder.textContent=error.message;holder.classList.add("error");}
    }
    function revealHistoryRow(row) {
      // Scroll this drawer only, never the graph/page. A late response from a
      // previous click must not steal focus from the currently inspected row.
      if(!row.isConnected||side.dataset.historyFocus!==row.dataset.operation)return;
      var bounds=side.getBoundingClientRect(),header=side.querySelector(".head");
      var top=bounds.top+(header?header.getBoundingClientRect().height:0)+8,rect=row.getBoundingClientRect();
      var preview=Math.min(240,Math.max(80,(bounds.bottom-top)/2));
      if(rect.top<top||rect.bottom+preview>bounds.bottom)side.scrollTop+=rect.top-top;
    }
    function setHistoryDisclosure(control, open) {
      var original=control.dataset.historyView==="original";
      control.textContent=open?(original?"收起原文":"收起 diff"):(original?"原文":"diff");
      control.setAttribute("aria-expanded",String(open));
    }
    async function historyRows(parent, scope, category, holder, offset) {
      try {
        var data=await view(scope,"history",{category:category,offset:offset||0,limit:20});
        if(!offset)parent.appendChild(pills([{t:data.total+" 次"+(category==="reads"?"读取":"写入 / 删除")}]));
        data.rows.forEach(function(event) {
          var row=el("div","vrow"+(event.at===scope.at?" anchor":""));row.dataset.operation=event.id;
          row.appendChild(lnk(String(event.number),"vn",function(){guard(()=>openRoot({...scope,at:event.at,operation:event.id}));}));
          var mid=el("span"),other={kind:scope.kind==="file"?"agent":"file",key:scope.kind==="file"?event.agent:event.file,at:event.at};
          if(other.key)mid.appendChild(lnk(other.kind==="agent"?agentLabelOf(other.key):baseName(other.key),"who",function(){guard(()=>openRoot(other));}));
          else mid.appendChild(el("span","who ext","未记录归属"));
          mid.appendChild(el("span","meta",dateTime(event.at)+" · "+event.label+(event.at===scope.at?" · ◀ 走访锚点":"")));
          mid.title=event.at;row.appendChild(mid);
          var act=el("span","act");
          var original=lnk("原文","",async function(){
            side.dataset.historyFocus=event.id;
            var closing=holder.isConnected&&holder.dataset.shownOperation===event.id;
            // This drawer has one original observation. Release its previous
            // control when switching records, or remove it when toggled closed.
            if(holder.originalControl)setHistoryDisclosure(holder.originalControl,false);
            holder.originalControl=null;holder.remove();holder.textContent="";
            delete holder.dataset.shownOperation;
            if(closing)return;
            row.after(holder);holder.originalControl=original;setHistoryDisclosure(original,true);
            var loading=contentSection(holder,scope,event.id);revealHistoryRow(row);
            await loading;
            if(holder.dataset.shownOperation===event.id)revealHistoryRow(row);
          });
          original.dataset.historyView="original";
          var active=holder.isConnected&&holder.dataset.shownOperation===event.id;
          if(active)holder.originalControl=original;
          setHistoryDisclosure(original,active);act.appendChild(original);
          if(category!=="reads"){act.appendChild(document.createTextNode(" · "));var pre=null;
            var diff=lnk("diff","",async function(){
              side.dataset.historyFocus=event.id;
              if(pre){pre.remove();pre=null;setHistoryDisclosure(diff,false);return;}
              pre=el("pre","diffblock");row.after(pre);setHistoryDisclosure(diff,true);
              const panel=pre,loading=diffInto(panel,scope,event.id);revealHistoryRow(row);
              await loading;if(pre===panel&&panel.isConnected)revealHistoryRow(row);
            });
            diff.dataset.historyView="diff";setHistoryDisclosure(diff,false);
            act.appendChild(diff);}
          row.appendChild(act);parent.appendChild(row);
        });
        if(!data.total)parent.appendChild(kv("","(没有可确认的"+(category==="reads"?"读取":"写入")+"记录)"));
        if(data.next!=null){var more=lnk("继续展开","more",function(){more.remove();historyRows(parent,scope,category,holder,data.next);});parent.appendChild(more);}
      }catch(error){fail(error,parent);}
    }
    function fileVersionSection(container, scope, holder) {
      var box=sec("写入脊柱 · 点写者 → 以它当时的时间为根");container.appendChild(box);
      historyRows(box,scope,"changes",holder);
      foldSection("读取观察 · 已知时刻的返回原文",container,box=>historyRows(box,scope,"reads",holder));
    }
    function claimsSection(node, body) {
      if((node.claims||[]).some(n=>n.existence_basis==="model_review"))
        body.appendChild(quoteLong("inbox","文件节点 · 模型复核补充",
          "本节点由所载卡片的原始调用证据支持，未进入全局确定读写索引；文件效应仍是模型复核判断。"));
      (node.claims||[]).filter(n=>!n.generated_context).forEach(function(claim) {
        var q=quoteLong(["origin","propagated","problem"].includes(claim.role)?"cause":"inbox",
          "模型判断 · "+({origin:"问题进入",propagated:"问题保留",problem:"有问题 · 具体归因见原因",context:"输入与背景",repaired:"修复",unknown:"未知"}[claim.role]||claim.role),claim.reason);
        body.appendChild(q);
        foldSection("原始依据",q,function(box){
          if(claim.evidence_basis)box.appendChild(kv("关系依据","由系统绑定相邻读写；不自动认证以上原因。"));
          (claim.evidence||[]).forEach(ref=>{rawLink(box,ref,{at:claim.at,since:claim.since},"查看原文");box.appendChild(document.createTextNode(" "));});});
      });
      if(node.row&&node.row.source==="model_review"){
        var q=quoteLong("inbox","虚线 · 模型复核补充",node.row.claim);body.appendChild(q);
        (node.row.evidence||[]).forEach(ref=>rawLink(q,ref,XT.byId[node.parent]?.scope||node.scope));
      }
    }
    function expansionFeedback(node) {
      if (side.dataset.node !== node.tid || selTid !== node.tid) return;
      var body=side.querySelector(".body");if(!body)return;
      var note=body.querySelector(".expansion-note");
      if(!note){note=el("div","kv expansion-note");body.prepend(note);}
      note.textContent="";note.hidden=true;
      if(node.error){
        note.hidden=false;note.appendChild(el("span","error","上游查询失败："+node.error+" "));
        note.appendChild(lnk("重试","more",function(){onNode(node.tid);}));
      } else if(node.reference){
        note.hidden=false;note.textContent="该关系已在当前路径中出现。可用「以此为根」单独查看，树上不重复递归。";
      } else if(node.loaded && node.next == null && !(node.children || []).length){
        note.hidden=false;
        note.textContent=(node.kind==="file"?"截至这个时刻，当前索引未找到已确认的写者。":"截至这个时刻，未找到可展开的已确认上游。")
          +(node.total?" 未确认关系按展示设置不画边。":"")
          +(node.kind==="file"?"这不代表从未写入；仍可查看读到的原文与相关调用。":"仍可在下方查看任务和原始调用。");
      }
    }
    function timedHead(node, cls, tag, title, sub) {
      var h=head(cls,tag+" · 截至 "+dateTime(node.scope.at),title,sub,node.isRoot?null:node.scope);
      h.querySelector(".tag").title=node.scope.at+" · 点击换一个时刻";h.querySelector(".tag").style.cursor="pointer";
      h.querySelector(".tag").onclick=function(){timeScope=node.scope;document.getElementById("timeName").textContent=node.scope.key;
        document.getElementById("at").value=node.scope.at;document.getElementById("timeDialog").showModal();};
      return h;
    }
    function actionRow(row, scope) {
      var r=el("div","arow");r.appendChild(el("span","vn","#"+row.line));
      r.appendChild(document.createTextNode(" "+(row.tools||[]).join(" / ")+" · "+row.excerpt));
      var pre=null,link=lnk(" 原文","more",async function(){
        if(pre){pre.remove();pre=null;link.textContent=" 原文";return;}
        pre=el("pre","diffblock","加载原文…");r.appendChild(pre);link.textContent=" 收起";
        const panel=pre;
        try {
          const refs=[row.cite||row.ref,...(row.results||[])],texts=await Promise.all(refs.map(ref=>query({op:"open",ref,at:scope.at,...(scope.since?{since:scope.since}:{})})));
          if(pre!==panel||!panel.isConnected)return;
          panel.textContent="";texts.forEach(function(data,i){panel.appendChild(el("span","dl-ctx",(i?"── 返回 ──":"── 原始记录 ──")+"\n"));panel.appendChild(document.createTextNode(data.text+"\n"));});
        }catch(error){if(pre===panel&&panel.isConnected){panel.textContent=error.message;panel.classList.add("error");}}
      });r.appendChild(link);return r;
    }
    async function rawRows(container, scope, name, terms, offset) {
      var data=await query(atom(scope,{view:name,terms:terms||[],offset:offset||0,limit:20,...(name==="calls"?{include_reads:true}:{})}));
      if(!offset)container.appendChild(kv("记录",data.total+" 条"));
      var tl=el("div","tl");container.appendChild(tl);
      data.rows.forEach(function(record){
        var row=el("div","trow"),mid=el("div"),at=el("span","vn","·");at.title=record.at;row.appendChild(at);
        mid.appendChild(el("div","eff",dateTime(record.at)+" · "+(record.tools||[]).join(" / ")));
        mid.appendChild(actionRow(record,scope));row.appendChild(mid);tl.appendChild(row);
      });
      if(data.next!=null){var more=lnk("继续展开记录","more",function(){more.remove();rawRows(container,scope,name,terms,data.next).catch(error=>fail(error,container));});container.appendChild(more);}
    }
    function searchSection(body, scope) {
      foldSection(scope.kind==="file"?"片段来源 / 搜索历史":"搜索历史",body,function(box){
        var input=el("input"),result=el("div");input.placeholder="代码片段或关键词";box.appendChild(input);
        box.appendChild(lnk(" 查找","more",async function(){
          result.textContent="";if(!input.value.trim())return;var terms=[input.value.trim()];
          try {
            if(scope.kind==="file"){
              var data=await query({op:"blame",key:scope.key,at:scope.at,...(scope.since?{since:scope.since}:{}),terms:terms,limit:20});
              data.rows.forEach(function(row){var q=quote("inbox",dateTime(row.at)+" · "+agentLabelOf(row.agent),(row.term_deltas||[]).map(h=>"OLD\n"+h.old_lines.join("\n")+"\nNEW\n"+h.new_lines.join("\n")).join("\n"));result.appendChild(q);});
              if(data.next!=null)result.appendChild(kv("范围","先列20条片段命中，原始历史可继续展开。"));
            }
            await rawRows(result,scope,"records",terms);
          }catch(error){fail(error,result);}
        }));box.appendChild(result);
      });
    }
    function drawerFile(node) {
      ++detailEpoch;side.innerHTML="";side.dataset.node=node.tid;
      side.appendChild(timedHead(node,"file","文件原子",baseName(node.scope.key),node.scope.key));
      var body=el("div","body");side.appendChild(body);expansionFeedback(node);claimsSection(node,body);
      var holder=el("div");body.appendChild(holder);contentSection(holder,node.scope,node.operation);
      fileVersionSection(body,node.scope,holder);
      foldSection("相关调用与记录",body,box=>rawRows(box,node.scope,"calls"));searchSection(body,node.scope);
    }
    async function drawerAgent(node) {
      var epoch=++detailEpoch,scope=node.scope;side.innerHTML="";side.dataset.node=node.tid;
      side.appendChild(timedHead(node,"gen","Agent 原子",agentLabelOf(scope.key),scope.key));
      var body=el("div","body");side.appendChild(body);expansionFeedback(node);claimsSection(node,body);
      var identity=sec("身份");identity.appendChild(pills([{t:"会话 "+scope.key.split(":")[0].slice(0,8)}]));body.appendChild(identity);
      try {
        var relation=await query(atom(scope,{view:"relations",limit:1}));if(epoch!==detailEpoch)return;
        var dispatches=relation.dispatches.filter(d=>d.child===scope.key&&d.strength==="confirmed");
        dispatches.forEach(function(d){
          var s=sec("派发自");s.appendChild(lnk(agentLabelOf(d.parent)+" @"+shortTime(d.at),"",function(){guard(()=>openRoot({kind:"agent",key:d.parent,at:d.at}));}));
          rawLink(s,d.request,scope," · 派发指令");body.appendChild(s);
        });
        var observed=el("div");body.appendChild(observed);
        var reads=sec("已确认读取 · 点文件 → 以读取时刻为根");body.appendChild(reads);historyRows(reads,scope,"reads",observed);
        foldSection("产出时间线",body,box=>historyRows(box,scope,"changes",observed));
        foldSection("任务与收件",body,box=>rawRows(box,scope,"messages"));
        foldSection("逐时刻调用明细",body,box=>rawRows(box,scope,"calls"));
        foldSection("其它工具返回",body,box=>rawRows(box,scope,"returns"));searchSection(body,scope);
      }catch(error){fail(error,body);}
    }

    function applyReport(graph, finding) {
      // Use the existing checked path projection, then hand it to the old renderer.
      // This is not a second active UI state or a reconstruction of model thoughts.
      var projection=new InquiryEvidenceTree.EvidenceTreeModel(graph.tree.root);
      projection.seed(graph,finding);hiddenPaths=projection.unclosed;
      XT={byId:{},seq:0,root:null,rights:[],rootKind:projection.root.coordinate.kind};
      setFrozen(true);
      function copy(original,parent){
        var n=decorateScope(original.coordinate,{isRoot:!parent,claims:original.claims.slice(),row:original.row,
          isDispatch:original.row?.relation==="dispatch",reference:original.reference,expanded:original.children.length>0,
          operation:original.row?.source==="indexed"&&original.row.id.startsWith("native:")?original.row.id.slice(7):null});
        if(n.isDispatch)n.label="⇠ 派发 "+n.label;
        if(parent)addKid(parent,n);else XT.root=n.tid;
        n.children=[];original.children.forEach(child=>copy(child,n));return n;
      }
      var root=copy(projection.root,null);selTid=root.tid;autoFit=true;rootLabel(root);renderTree(root.tid);
      if(root.kind==="file")drawerFile(root);else drawerAgent(root);
    }
    async function loadReport(id) {
      var epoch=++navigation,graph=await api("/api/report?id="+encodeURIComponent(id));if(epoch!==navigation)return;
      report=graph;activeFinding="";applyReport(graph,"");setUrl(null,id);
      var select=document.getElementById("finding");select.innerHTML="";var all=el("option",null,"全部问题");all.value="";select.appendChild(all);
      graph.document.findings.forEach(function(f){var opt=el("option",null,f.id+" · "+f.title);opt.value=f.id;select.appendChild(opt);});
      document.getElementById("reportsDialog").close();reportNotes();
      renderRail();
    }
    function findingLinks(parent, ids) {
      var links=el("div","kv");links.appendChild(document.createTextNode("对应问题："));
      (ids||[]).forEach(function(id,index){
        var f=report.document.findings.find(f=>f.id===id);if(!f)return;
        if(index)links.appendChild(document.createTextNode(" · "));
        links.appendChild(lnk(f.title,"lnk",function(){activeFinding=id;document.getElementById("finding").value=id;
          applyReport(report,id);reportNotes();document.getElementById("reportsDialog").close();}));
      });parent.appendChild(links);
    }
    function narrativeSection(host) {
      var doc=report.document;
      if(doc.summary){
        var section=sec("文件级总结 · 模型主张");section.id="card-summary";
        if(typeof doc.summary==="string"){
          section.appendChild(quoteLong("inbox","生成期原因、后续修复与未查明",doc.summary));host.appendChild(section);
        }else{
        section.appendChild(quote("inbox","生成期问题总结",doc.summary.generation));
        section.appendChild(quote("inbox","后续修复与结果",doc.summary.repair));
        if(doc.summary.unknown.length)section.appendChild(quote("inbox","尚未查明",doc.summary.unknown.join("\n")));
        findingLinks(section,doc.summary.findings);host.appendChild(section);
        }
      }
      if(doc.recommendations?.length){
        var section=sec("优化建议 · 效果待验证");section.id="card-recommendations";
        doc.recommendations.forEach(function(r){
          if(typeof r==="string"){section.appendChild(quoteLong("inbox","建议与验证",r));return;}
          var item=el("div","quote inbox");item.appendChild(el("b",null,r.target));
          item.appendChild(kv("具体改动",r.action));item.appendChild(kv("为什么",r.reason));
          item.appendChild(kv("如何验证",r.validation));section.appendChild(item);findingLinks(section,r.findings);
        });host.appendChild(section);
      }
    }
    function reportNotes() {
      var host=document.getElementById("reportNotes");host.textContent="";if(!report)return;
      narrativeSection(host);
      if(hiddenPaths.length){var details=el("details");details.appendChild(el("summary",null,hiddenPaths.length+" 个报告节点尚未接入树"));
        hiddenPaths.forEach(p=>details.appendChild(kv((p.purpose==="context"?"参考材料 · ":"问题节点 · ")+p.node,p.diagnostic)));host.appendChild(details);}
      var details=el("details");details.appendChild(el("summary",null,"本次调查结论"));
      details.appendChild(kv("核验",(report.mechanical_status==="valid"?"引用与关系机检通过":"引用与关系仍需复核")+"；节点原因是模型判断，不是机检认证。"));
      if(report.coverage&&!report.coverage.complete)details.appendChild(kv("调查范围","修改对账尚未完成，保留未决项；此卡不能视为完整归因。"));
      report.document.findings.filter(f=>!activeFinding||f.id===activeFinding).forEach(function(f){
        details.appendChild(quoteLong("cause",f.title,f.reason));
        if(f.boundary)details.appendChild(quoteLong("inbox","停止上溯依据 · "+({supported_input:"模型认为输入充分",not_generation_error:"模型认为非生成错误",unresolved:"尚未查明"}[f.boundary.status]||f.boundary.status),f.boundary.reason));
        (f.checks||[]).forEach(function(c){
          var bound=(report.check_results||[]).find(r=>r.finding===f.id&&r.request===c.request&&r.result===c.result&&r.node===f.id+":"+c.node);
          var q=quoteLong("inbox",bound?"检查调用 · 配对可核，效果未认证":"检查调用 · 尚未核回",c.claim);
          if(bound)q.appendChild(kv("实际调用",c.tool+" · "+bound.request_at+" → "+bound.result_at));
          rawLink(q,c.request,{at:report.target.at},"原始命令");q.appendChild(document.createTextNode(" "));
          rawLink(q,c.result,{at:report.target.at},"原始回执");details.appendChild(q);
        });
        [["unknown","尚未查明"],["hypothesis","机制假设 · 未认证"],["recommendation","改进建议 · 效果待验证"]].forEach(function(pair){
          var value=f[pair[0]];if(value==null||value===""||(Array.isArray(value)&&!value.length))return;
          var text=Array.isArray(value)?value.map(v=>typeof v==="string"?v:JSON.stringify(v)).join("\n"):typeof value==="string"?value:JSON.stringify(value);
          details.appendChild(quoteLong("cause",pair[1],text));
        });
      });
      if(report.document.unexplained?.length)details.appendChild(quoteLong("cause","未解释的修改或效应",Array.isArray(report.document.unexplained)?report.document.unexplained.join("\n"):String(report.document.unexplained)));
      host.appendChild(details);host.appendChild(lnk("退出调查，手动查看此文件","more",function(){var scope=XT.byId[XT.root].scope;document.getElementById("reportsDialog").close();guard(()=>openRoot(scope));}));
    }
    async function reportsDialog() {
      reportNotes();document.getElementById("finding").hidden=!report;
      var dialog=document.getElementById("reportsDialog");dialog.showModal();
      dialog.scrollTop=0; // Native autofocus on the lower selector must not hide the file summary.
    }
    function renderEmptyCanvas() {
      XT=null;nodeEls={};canvas.innerHTML="";canvas.appendChild(svg);svg.innerHTML="";layoutSize={w:600,h:200};
      var m=el("div","cvempty");m.innerHTML="从左栏选一个<b>文件的某个时刻</b>或<b>agent 的某个时刻</b>当根，树就从这里开始生长。<br>返修入口是常用起点；spec、安卓源码和脚本也都能当根。";
      canvas.appendChild(m);applyZoom(1,true);
    }
    function reset() {
      ++navigation;++detailEpoch;report=null;activeFinding="";clearBtn.classList.remove("show");curRootKey=null;
      document.getElementById("rootlbl").textContent="两原子探索树 —— 文件 × agent，任何一个时刻都能当根";
      setUrl();renderEmptyCanvas();renderRail();side.innerHTML="";side.appendChild(el("div","placeholder","左栏选文件或 agent，再选一个时刻当根。"));
      setFrozen(false);
    }
    rail.querySelector(".tog").onclick=function(){rail.classList.toggle("closed");this.textContent=rail.classList.contains("closed")?"▸":"◂";};
    qInput.oninput=function(){railState.q=qInput.value.trim().toLowerCase();renderRail();};
    document.getElementById("zi").addEventListener("click",function(){applyZoom(zoom*1.25);});
    document.getElementById("zo").addEventListener("click",function(){applyZoom(zoom/1.25);});
    document.getElementById("zf").addEventListener("click",function(){fitView();});
    document.getElementById("z1").addEventListener("click",function(){applyZoom(1);});
    document.getElementById("freeze").onclick=function(){setFrozen(!treeFrozen);};
    document.getElementById("summary").onclick=()=>guard(reportsDialog);
    graphEl.addEventListener("wheel",function(ev){if(!ev.ctrlKey)return;ev.preventDefault();applyZoom(zoom*(ev.deltaY<0?1.15:0.87));},{passive:false});
    clearBtn.addEventListener("click",reset);
    document.getElementById("closeReports").onclick=()=>document.getElementById("reportsDialog").close();
    document.getElementById("closeTime").onclick=()=>document.getElementById("timeDialog").close();
    document.getElementById("applyTime").onclick=()=>guard(async()=>{await openRoot({...timeScope,at:document.getElementById("at").value});document.getElementById("timeDialog").close();});
    document.getElementById("finding").onchange=function(){if(report){activeFinding=this.value;applyReport(report,activeFinding);reportNotes();document.getElementById("reportsDialog").close();}};
    document.getElementById("importReport").onchange=async function(){
      if(!this.files[0])return;document.getElementById("reportError").textContent="";
      try{var graph=await api("/api/report",{document:await this.files[0].text()});await refreshReports();await loadReport(graph.report_id);}
      catch(error){document.getElementById("reportError").textContent=error.message;}
    };
    window.migloopViewer={loadReport,openRoot,
      get tree(){return XT;},get zoom(){return zoom;},get report(){return report;},get hiddenPaths(){return hiddenPaths;},
      get frozen(){return treeFrozen;},select:inspectNode,
      expand:async function(tid,direction){var tree=XT,n=tree.byId[tid];await expandRelations(n,direction||"upstream");if(XT===tree)renderTree(treeFrozen?null:tid);},
      get layout(){return layoutSize;}};
    renderEmptyCanvas();
    guard(async function(){
      var data=await Promise.all([api("/api/view",{view:"catalog"}),api("/api/view",{view:"overview"}),
        migrationEntries().catch(error=>{DATA.fixesError=error.message;return []})]);
      IDX=data[0];IDX.agents.forEach(a=>{agentById[a.id]=a;});
      IDX.files.forEach(f=>{var ext=f.path.split(".").pop().toLowerCase();f.kind=ext==="ets"?"ets":["md","json","yaml","yml"].includes(ext)?"spec":["kt","java","xml"].includes(ext)?"src":"other";f.has_writer=f.n_events>0;});
      DATA.fixes=data[2];indexRepairEntries();await refreshReports(data[1]);dataReady=true;
      if(config.project)chips.appendChild(el("span","chip",config.project));
      var count=el("span","chip",DATA.fixes.length+" 个返修入口");count.id="repairCount";chips.appendChild(count);
      chips.appendChild(el("span","chip","目录 · "+IDX.files.length+" 个文件 · "+IDX.agents.length+" 个 agent"));
      document.getElementById("wrap").hidden=false;renderRail();applyZoom(1,true);
      var q=new URLSearchParams(location.search),h=new URLSearchParams(location.hash.slice(1));
      var id=q.get("report")||q.get("report_id")||(!(h.get("key")||h.get("file"))&&config.report_id);
      if(id)await loadReport(id);
      else if(h.get("key")||h.get("file")||h.get("agent"))await openRoot({kind:h.get("kind")||(h.get("agent")?"agent":"file"),key:h.get("key")||h.get("file")||h.get("agent"),at:h.get("at")||IDX.at,since:h.get("since"),operation:h.get("operation")});
      if(q.has("probe")){await reportsDialog();document.getElementById("reportError").textContent="旧格式调查尚未载入，请选择或导入当前结果。";}
    });
})();
