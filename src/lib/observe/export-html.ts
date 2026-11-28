// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 离线导出装配单点（run 工作台自身即离线查看器）：gather 按工作台同一
// URL 构造器（runMemberUrlFor / run 级直连）取数存档——档案键与运行期
// fetch 请求按构造相等；成员富轮仓（member-turns 全量 + 三投影旗）是
// turns/search/by-index/turn-detail 四个动态合成器的单一数据源（见
// src/export-view/offline-kernel.ts）。对账结果（sessionStorage）迁移为
// 全局，挂载即读。

import { HTML_FILE, saveBlob } from "@/lib/observe/export-download";
import { BRAND_NAME } from "@/lib/branding"
import { runMemberRowsOf, type RunMemberRow } from "@/lib/run/member-rows"
import { runMemberUrlFor } from "@/lib/observe/member-url"
import type { OfflineMemberTurns } from "@/export-view/offline-kernel"

export function captureStylesheets(): string {
  const out: string[] = []
  for (let i = 0; i < document.styleSheets.length; i++) {
    const sheet = document.styleSheets[i]
    try {
      const rules = sheet.cssRules
      if (!rules || rules.length === 0) continue
      for (let j = 0; j < rules.length; j++) out.push(rules[j].cssText)
    } catch { /* 跨源样式表跳过 */ }
  }
  return out.join("\n")
}

// 规范化全 URL 为匹配 key（path + 排序后 query），与离线内核的匹配键一致
export function urlKeyOf(u: string): string {
  try {
    const parsed = new URL(u, "http://e")
    const params = [...parsed.searchParams.entries()].sort().map(([k, v]) => `${k}=${v}`).join("&")
    return params ? `${parsed.pathname}?${params}` : parsed.pathname
  } catch {
    return u.split("?")[0]
  }
}

export interface RunExportPayload {
  /** 静态档案：精确 URL 键 → 端点响应（gather 与 UI 用同一 URL 构造器） */
  archive: Record<string, unknown>
  /** 成员富轮仓：动态合成器的单一数据源 */
  memberTurns: OfflineMemberTurns[]
  /** 对账结果迁移（run-audit-<runId>-* 与 skill-audit-<taskId>-*，_html 剥离） */
  audits: Record<string, string>
}

interface MemberDetailProjection {
  /** 成员会话行 id（Prisma Session.id/cuid；turn 详情/搜索归因用，非 taskId） */
  sessionId?: string | null
  skills?: Array<{ skillName: string }>
  agents?: Array<{ agentName: string | null; isSubagent: boolean }>
}

/** 收集 run 工作台离线所需全量数据。单端点失败容忍跳过（对应能力离线
 *  降级）；成员富轮失败记空仓（该成员 Turns/详情/回放离线缺位）。 */
export async function gatherRunExportData(runId: string): Promise<RunExportPayload> {
  const archive: Record<string, unknown> = {}
  const memberTurns: OfflineMemberTurns[] = []
  const base = `/api/observe/run/${encodeURIComponent(runId)}`

  const fetchJson = async (url: string): Promise<{ ok: boolean; status: number; body: unknown }> => {
    try {
      const res = await fetch(url)
      if (!res.ok) return { ok: false, status: res.status, body: null }
      return { ok: true, status: res.status, body: await res.json() }
    } catch {
      return { ok: false, status: 0, body: null }
    }
  }
  const archiveIfOk = async (url: string): Promise<boolean> => {
    const r = await fetchJson(url)
    if (!r.ok) return false
    archive[urlKeyOf(url)] = r.body
    return true
  }

  // ① run 详情先行：viewModel 拍平出成员名册（成员枚举与 UI 同源）
  const detailUrl = `${base}`
  const detail = await fetchJson(detailUrl)
  if (!detail.ok) throw new Error(`Run not found: ${runId}`)
  archive[urlKeyOf(detailUrl)] = detail.body
  const detailBody = detail.body as { viewModel?: Parameters<typeof runMemberRowsOf>[0] }
  const memberRows: RunMemberRow[] = detailBody.viewModel ? runMemberRowsOf(detailBody.viewModel) : []

  // ② run 级聚合端点（Overview/Perf/Context/Skills/Files/Turns 桥）
  const fileReadsUrl = `${base}/file-reads`
  await Promise.all([
    archiveIfOk(`${base}/executions`),
    archiveIfOk(`${base}/skills`),
    archiveIfOk(`${base}/bridges`),
    archiveIfOk(`${base}/context`),
    archiveIfOk(`${base}/lanes`),
    archiveIfOk(`${base}/tool-stats`),
    // score 评测导出（issue #116 RSI 语料）：离线 bundle 同 URL 可答（内核①精确档案命中）
    archiveIfOk(`${base}/score-export`),
    archiveIfOk(fileReadsUrl),
  ])

  // ③ 文件还原档案（Files tab 逐文件查看）：file-reads 清单枚举
  const fileReads = archive[urlKeyOf(fileReadsUrl)] as { files?: Array<{ filePath?: string }> } | undefined
  const filePaths = [...new Set((fileReads?.files ?? []).map(f => f.filePath).filter((p): p is string => !!p))]
  await Promise.all(filePaths.map(p => archiveIfOk(`${base}/file-restore?filePath=${encodeURIComponent(p)}`)))

  // ④ 成员域：富轮仓（合成器单一数据源）+ 转发端点档案（按 UI 同一构造器）
  await Promise.all(memberRows.map(async m => {
    const urlFor = runMemberUrlFor(runId, m.taskId)
    const enc = encodeURIComponent

    // member-detail 提供会话行 id（sid 是 taskId，两者不同字段）——先取到
    // 才能填 OfflineMemberTurns.sessionId（契约：成员会话行 id，非 sid）
    const memberDetailUrl = urlFor("member-detail")
    const memberDetail = await fetchJson(memberDetailUrl)
    const md = memberDetail.ok ? memberDetail.body as MemberDetailProjection : null

    const memberTurnsUrl = urlFor("member-turns?includeContent=true&includeToolDetail=true&includeMeta=true")
    const turnsRes = await fetchJson(memberTurnsUrl)
    const turnsBody = turnsRes.ok ? turnsRes.body as { items?: OfflineMemberTurns["items"] } : null
    memberTurns.push({
      member: { taskId: m.taskId, label: m.displayName },
      sessionId: md?.sessionId ?? null,
      framework: m.framework,
      items: turnsBody?.items ?? [],
    })

    await Promise.all([
      archiveIfOk(urlFor("turn-digest")),
      archiveIfOk(urlFor("main-agent-workflow")),
      archiveIfOk(urlFor(`scorecard?taskId=${enc(m.taskId)}${m.framework ? `&framework=${enc(m.framework)}` : ""}`)),
      archiveIfOk(urlFor("mate-agent")),
      ...(md?.skills ?? []).map(s =>
        archiveIfOk(urlFor(`skill-content?taskId=${enc(m.taskId)}&skillName=${enc(s.skillName)}`))),
      ...[...new Set((md?.agents ?? []).filter(a => a.isSubagent && a.agentName).map(a => a.agentName!))].map(name =>
        archiveIfOk(urlFor(`agent-content?taskId=${enc(m.taskId)}&agentName=${enc(name)}${m.framework ? `&framework=${enc(m.framework)}` : ""}`))),
    ])
  }))

  // ⑤ 对账结果迁移（sessionStorage → 全局；离线挂载即读，无需重跑）
  const audits: Record<string, string> = {}
  const prefixes = [`run-audit-${runId}-`, ...memberRows.map(m => `skill-audit-${m.taskId}-`)]
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i) ?? ""
      if (!prefixes.some(p => k.startsWith(p))) continue
      const v = sessionStorage.getItem(k)
      if (!v) continue
      // 剥掉 _html（原始 HTML 报告，体积大且含 </script> 会破坏内联脚本）
      try {
        const parsed = JSON.parse(v)
        if (parsed && typeof parsed === "object" && "_html" in parsed) delete (parsed as Record<string, unknown>)._html
        audits[k] = JSON.stringify(parsed)
      } catch {
        audits[k] = v
      }
    }
  } catch { /* sessionStorage 不可用 */ }

  return { archive, memberTurns, audits }
}

// 组装嵌入式 SPA HTML：内联 CSS + 档案全局 + bundle + #root，离线打开即跑
// 真实 run 工作台（fetch 由离线内核应答）
export function assembleEmbeddedHtml(
  cssText: string,
  bundleJs: string,
  runId: string,
  runName: string,
  payload: RunExportPayload,
): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  // 鲁棒转义：内联进 <script> 的内容里，任何 </script 序列（大小写不敏感、任意后缀）
  // 都会提前截断 script 标签；把 </script 改成 <\/script（HTML 解析器见 <\ 不视为结束，JS/JSON 里 \/ 即 /）
  const safeForScript = (s: string) => s.replace(/<\/script/gi, "<\\/script")
  const archiveJson = safeForScript(JSON.stringify(payload.archive))
  const memberTurnsJson = safeForScript(JSON.stringify(payload.memberTurns))
  const auditsJson = safeForScript(JSON.stringify(payload.audits))
  const bundleSafe = safeForScript(bundleJs)
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(runName)} — ${esc(BRAND_NAME)}</title>
<style>
html, body, #root { height: 100%; margin: 0; }
${cssText}
</style>
</head>
<body>
<div id="root"></div>
<script>
window.__EXPORT_RUN_ID = ${JSON.stringify(runId)};
window.__EXPORT_ARCHIVE = ${archiveJson};
window.__EXPORT_MEMBER_TURNS = ${memberTurnsJson};
window.__EXPORT_AUDITS = ${auditsJson};
</script>
<script>${bundleSafe}</script>
</body>
</html>`
}

export function downloadHtml(html: string, filename: string): void {
  saveBlob(new Blob([html], { type: "text/html;charset=utf-8" }), filename, HTML_FILE)
}
