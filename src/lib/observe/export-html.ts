// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 离线导出 bundle 装配单点（自 session 页抽离，design:
// docs/design/run-first-architecture/design.md 刀J）：solo run 工作台的
// 「导出 HTML」按钮经此装配嵌入式 SPA——数据取自 run 成员视图端点
// （刀I1 转发），按 session 路径键存档（export-view entry.tsx 的 fetch
// 拦截器按 session URL 匹配，离线查看器组件零改动消费）。

import { BRAND_NAME } from "@/lib/branding"

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

// 规范化全 URL 为匹配 key（path + 排序后 query），与 entry.tsx 的 urlKey 一致
export function urlKeyOf(u: string): string {
  try {
    const parsed = new URL(u, "http://e")
    const params = [...parsed.searchParams.entries()].sort().map(([k, v]) => `${k}=${v}`).join("&")
    return params ? `${parsed.pathname}?${params}` : parsed.pathname
  } catch {
    return u.split("?")[0]
  }
}

interface ExportDetailProjection {
  skills?: Array<{ skillName: string }>
  agents?: Array<{ agentName: string | null; isSubagent: boolean }>
}

/**
 * 收集会话视图离线所需全量数据：核心端点按 session 路径存 data（一路径一份数据，
 * 容忍 query 差异）；skill-content/agent-content 按完整 session URL 存 param
 * （per-参数区分）；sessionStorage 的 skill 对账结果存 skillAudits（迁移到导出
 * HTML 供 hydrateSkillAuditFromStorage 挂载即读）。取数走 run 成员视图端点
 * （framework 由 scope 成员消歧行注入，同 sid 双行原生优先）。
 */
export async function gatherExportData(
  runId: string,
  taskId: string,
  framework?: string,
): Promise<{ data: Record<string, unknown>; param: Record<string, unknown>; skillAudits: Record<string, string> }> {
  const memberView = (p: string) => `/api/observe/run/${encodeURIComponent(runId)}/${p}`
  const data: Record<string, unknown> = {}
  const param: Record<string, unknown> = {}

  const fetchInto = async (key: string, url: string, store: Record<string, unknown>) => {
    try {
      const res = await fetch(url)
      if (!res.ok) return
      store[key] = await res.json()
    } catch { /* 忽略单个端点失败 */ }
  }

  // ① 成员详情先行：既是核心数据（session 详情键），也提供 skills/agents 清单
  await fetchInto("/api/observe/session", memberView("member-detail"), data)
  const detail = data["/api/observe/session"] as ExportDetailProjection | undefined

  // ② 核心端点（键 = session 路径；bridges/file-reads 用 run 独立实现，响应形状兼容）
  await Promise.all([
    fetchInto("/api/observe/session/turns", memberView("member-turns"), data),
    fetchInto("/api/observe/session/bridges", memberView("bridges"), data),
    fetchInto(`/api/observe/executions?taskId=${encodeURIComponent(taskId)}`, `/api/observe/executions?taskId=${encodeURIComponent(taskId)}`, data),
    fetchInto("/api/observe/session/main-agent-workflow", memberView("main-agent-workflow"), data),
    fetchInto("/api/observe/session/workflow", memberView("workflow"), data),
    fetchInto(`/api/observe/stats?taskId=${encodeURIComponent(taskId)}`, `/api/observe/stats?taskId=${encodeURIComponent(taskId)}`, data),
    fetchInto("/api/observe/session/file-reads", memberView("file-reads"), data),
    fetchInto("/api/observe/session/skill-content-audit", memberView("skill-content-audit"), data),
    fetchInto("/api/observe/session/llm-workflow-extract", memberView("llm-workflow-extract"), data),
  ])

  // ③ skill-content（每个 skill 一份，"全文"按钮按需取，预取内嵌）+ agent-content
  //   （每个 dispatched 子 agent 一份）——键 = 完整 session URL 归一化（离线查看器
  //   按 session 端点形态 fetch，拦截器按全 URL 精确匹配）
  const paramUrls: Array<{ key: string; fetchUrl: string }> = [
    ...(detail?.skills ?? []).map(s => {
      const sessionUrl = `/api/observe/session/skill-content?taskId=${encodeURIComponent(taskId)}&skillName=${encodeURIComponent(s.skillName)}`
      return { key: urlKeyOf(sessionUrl), fetchUrl: memberView(`skill-content?skillName=${encodeURIComponent(s.skillName)}`) }
    }),
    ...[...new Set((detail?.agents ?? []).filter(a => a.isSubagent && a.agentName).map(a => a.agentName!))].map(name => {
      const sessionUrl = `/api/observe/session/agent-content?taskId=${encodeURIComponent(taskId)}&agentName=${encodeURIComponent(name)}&framework=${encodeURIComponent(framework ?? "")}`
      return { key: urlKeyOf(sessionUrl), fetchUrl: memberView(`agent-content?agentName=${encodeURIComponent(name)}`) }
    }),
  ]
  await Promise.all(paramUrls.map(({ key, fetchUrl }) => fetchInto(key, fetchUrl, param)))

  // skill/agent 对账结果（sessionStorage 里 skill-audit-${taskId}-${kind}-${name}）
  const skillAudits: Record<string, string> = {}
  const prefix = `skill-audit-${taskId}-`
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i) ?? ""
      if (k.startsWith(prefix)) {
        const v = sessionStorage.getItem(k)
        if (!v) continue
        // 剥掉 _html（sift 原始 HTML 报告，体积大且含 </script> 会破坏内联脚本；保留 findings/summary 等结构化结果）
        try {
          const parsed = JSON.parse(v)
          if (parsed && typeof parsed === "object" && "_html" in parsed) delete (parsed as Record<string, unknown>)._html
          skillAudits[k] = JSON.stringify(parsed)
        } catch {
          skillAudits[k] = v
        }
      }
    }
  } catch { /* sessionStorage 不可用 */ }

  return { data, param, skillAudits }
}

// 组装嵌入式 SPA HTML：内联 CSS + 三块数据全局 + bundle + #root，离线打开即跑真实 React 应用
export function assembleEmbeddedHtml(
  cssText: string,
  bundleJs: string,
  taskId: string,
  framework: string | undefined,
  payload: { data: Record<string, unknown>; param: Record<string, unknown>; skillAudits: Record<string, string> },
): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  // 鲁棒转义：内联进 <script> 的内容里，任何 </script 序列（大小写不敏感、任意后缀）
  // 都会提前截断 script 标签；把 </script 改成 <\/script（HTML 解析器见 <\ 不视为结束，JS/JSON 里 \/ 即 /）
  const safeForScript = (s: string) => s.replace(/<\/script/gi, "<\\/script")
  const dataJson = safeForScript(JSON.stringify(payload.data))
  const paramJson = safeForScript(JSON.stringify(payload.param))
  const skillAuditsJson = safeForScript(JSON.stringify(payload.skillAudits))
  const bundleSafe = safeForScript(bundleJs)
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Session ${esc(taskId)} — ${esc(BRAND_NAME)}</title>
<style>
html, body, #root { height: 100%; margin: 0; }
${cssText}
</style>
</head>
<body>
<div id="root"></div>
<script>
window.__EXPORT_TASK_ID = ${JSON.stringify(taskId)};
window.__EXPORT_FRAMEWORK = ${JSON.stringify(framework ?? "")};
window.__EXPORT_DATA = ${dataJson};
window.__EXPORT_PARAM = ${paramJson};
window.__EXPORT_SKILL_AUDITS = ${skillAuditsJson};
</script>
<script>${bundleSafe}</script>
</body>
</html>`
}

export function downloadHtml(html: string, filename: string): void {
  const blob = new Blob([html], { type: "text/html;charset=utf-8" })
  const opts = {
    suggestedName: filename,
    types: [{ description: "HTML", accept: { "text/html": [".html"] } }],
  }
  const w = window as unknown as {
    showSaveFilePicker?: (o: typeof opts) => Promise<{ createWritable: () => Promise<{ write: (d: Blob) => Promise<void>; close: () => Promise<void> }> }>
  }
  if (typeof w.showSaveFilePicker === "function") {
    w.showSaveFilePicker(opts).then(async (handle) => {
      const writable = await handle.createWritable()
      await writable.write(blob)
      await writable.close()
    }).catch((e: unknown) => {
      if (e instanceof DOMException && e.name === "AbortError") return
      fallbackDownload(blob, filename)
    })
    return
  }
  fallbackDownload(blob, filename)
}

export function fallbackDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 15000)
}
