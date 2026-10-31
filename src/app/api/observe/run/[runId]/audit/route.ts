// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// POST /api/observe/run/[runId]/audit —— run 级 sift 对账（四域审计的执行面）。
// 声明单元（skill / agent .md / 主 agent 编排 root / run 级编排规程）对账本 run
// 涉事成员的 transcript，两条编排路径：
// - 源 bundle 在盘（import.json sourceDir + workflow.schema.json 契约齐全）：
//   skill/agent 域走 sift `--run`（guixu PR #9）——sift 原生枚举清单成员、匹配
//   目标调用、转换 .native 会话（保留原生 tool_use id 与子会话派生关系），
//   报告带 run 溯元数据（命中会话/调用数 + units 审计单元映射），成员归因按
//   report.run.units × sessionId 映射（_memberBySession 随流回传解析）。
//   run 域同走 `--run` 但不带 --kind（宽松模式：声明真名匹配到的成员整会话
//   对账，不切调用段）；S1 型声明（turn0 注入无真名）无法按名匹配 → 回落。
// - 无源 bundle（solo run / 目录已删 / root 域 / S1 型 run 域）：每成员会话经
//   buildStructuredRecords 序列化成独立 transcript 文件，一次 `sift audit` 多
//   `--transcript`（sift 原生支持，可重复）跑完，跨成员聚合语义由 sift 的
//   InstructionAggregate（pass/fail_count、fail_in_transcripts）直接产出。
//   transcript 文件名 = 成员标签（受控命名），`--kind` 切片名以该 stem 为前缀，
//   finding.transcript 反查成员按前缀回映射（sift-runner result 时点解析）。
//
// 声明恢复（单成员端点的同链路复用）：
// - skill：遍历涉事成员，首个能恢复 invoke 正文的成员胜出（同 skill 多成员
//   正文版本一致是常态；漂移在 UI 层以成员归因呈现）。
// - agent：system 注入（proxy 捕获的运行时 .md）> 磁盘扫描兜底
//   （AGENTS_SCAN_ROOT，多插件按涉事会话派发集合消歧）。
// - root：主 agent 编排组合声明（规程层 + 计划层）——编排声明是成员私有
//   （各成员各有一份），恒单成员对账。
// - run：声明源成员（name）的编排规程层（"怎么干"，跨成员可共享）× 全体
//   成员整会话——计划层（STATE.md）是成员私有任务承诺，不入 run 级对账。

import { NextResponse } from 'next/server';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withRouteLog } from '@/lib/api-route';
import { prisma } from '@/lib/db';
import { resolveRunScope } from '@/lib/run/observe/scope';
import { resolveRunBundleDir } from '@/lib/run/bundle-source';
import {
  recoverSkillBody,
  recoverCombinedWorkflowDeclaration,
  recoverWorkflowDeclaration,
  resolveWorkflowSkillName,
  MAIN_AGENT_WORKFLOW_NAME,
  buildStructuredRecords,
} from '@/lib/sift-audit';
import { recoverAgentMdFromSystem } from '@/lib/agent-md-session-recover';
import { resolveScanRoot, scanAgentDirs, resolveAgentMd } from '@/lib/agent-md-scan';
import { makeStreamingAuditResponse } from '@/lib/sift-runner';
import type { AuditLayerInfo, AuditMemberMap, AuditMemberRef } from '@/lib/sift-audit-types';
import { logError } from '@/lib/logger';

const NAME_RE = /^[A-Za-z0-9._-]+$/;

interface AuditRequestBody {
  kind?: 'skill' | 'agent' | 'root' | 'run';
  /** skill/agent = 目标名；root = 声明成员 taskId；run = 声明源成员 taskId。 */
  name?: string;
  /** 涉事成员 taskId 列表；缺省 = run 全体成员（root 恒单成员）。 */
  members?: string[];
}

function sanitizeFileLabel(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._\-\u4e00-\u9fa5]/g, '_').slice(0, 40) || 'member';
}

export const POST = withRouteLog(
  'observe/run/audit',
  async (request: Request, { params }: { params: Promise<{ runId: string }> }) => {
    const { runId } = await params;
    const body = (await request.json().catch(() => ({}))) as AuditRequestBody;
    const kind = body.kind ?? 'skill';
    const name = body.name ?? '';

    if (kind !== 'root' && !name) {
      return NextResponse.json({ error: 'Missing name', reason: 'bad-request' }, { status: 400 });
    }
    if (kind === 'agent' && !NAME_RE.test(name)) {
      return NextResponse.json(
        { error: `非法 name "${name}"（仅允许字母/数字/._-）`, reason: 'bad-request' },
        { status: 400 },
      );
    }

    const scope = await resolveRunScope(runId, prisma);
    if (!scope) {
      return NextResponse.json({ error: `Run not found: ${runId}`, reason: 'run-not-found' }, { status: 404 });
    }

    // 成员选择：请求给定子集（须 ⊆ run 成员）；缺省全体。root 恒单成员。
    const wanted = body.members?.length ? body.members : scope.members.map(m => m.taskId);
    const unknown = wanted.filter(t => !scope.members.some(m => m.taskId === t));
    if (unknown.length > 0) {
      return NextResponse.json(
        { error: `Member not in run: ${unknown.join(', ')}`, reason: 'member-not-in-run' },
        { status: 400 },
      );
    }
    if (kind === 'root' && wanted.length !== 1) {
      return NextResponse.json(
        { error: `root（主 agent 编排）对账恒单成员，收到 ${wanted.length} 个`, reason: 'bad-request' },
        { status: 400 },
      );
    }
    if (kind === 'run' && !scope.members.some(m => m.taskId === name)) {
      return NextResponse.json(
        { error: `声明源成员不在本 run: ${name}`, reason: 'bad-request' },
        { status: 400 },
      );
    }

    // 成员 → 会话（同 sid 双会话形态按 framework 消歧；scope 成员自带 framework）
    const memberRefs = scope.members.filter(m => wanted.includes(m.taskId));
    const sessions = new Map<string, { id: string; sourcePath: string | null }>();
    for (const m of memberRefs) {
      const s = await prisma.session.findFirst({
        where: { taskId: m.taskId, ...(m.framework ? { framework: m.framework } : {}) },
        select: { id: true, sourcePath: true },
      });
      if (s) sessions.set(m.taskId, s);
    }
    if (sessions.size === 0) {
      return NextResponse.json(
        { error: '所选成员均无已导入会话', reason: 'no-sessions' },
        { status: 404 },
      );
    }
    const withSession = memberRefs.filter(m => sessions.has(m.taskId));

    // ── 声明恢复 ──
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sift-run-audit-'));
    try {
      let skillPath: string;
      let layers: AuditLayerInfo[] | undefined;
      // run 域（--run 宽松）声明锚定的真名：S2 型主 agent Skill invoke 的 skill 名；
      // null（S1 型 turn0 注入）时 sift 无法按名匹配 bundle 成员，回落 DB 路径。
      let workflowRealName: string | null = null;
      if (kind === 'skill') {
        let body: string | null = null;
        for (const m of withSession) {
          body = await recoverSkillBody(sessions.get(m.taskId)!.id, name, prisma);
          if (body != null) break;
        }
        if (body == null) {
          return NextResponse.json(
            { error: `所选成员均恢复不到 skill "${name}" 的正文（无 invoke 事件 / resultJson）`, reason: 'no-declaration' },
            { status: 404 },
          );
        }
        const dir = path.join(tmp, name.replace(/[^a-zA-Z0-9._-]/g, '_'));
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'SKILL.md'),
          `---\nname: ${name}\ndescription: recovered from run member session\n---\n${body}\n`,
        );
        skillPath = dir;
      } else if (kind === 'agent') {
        let viaSystem: { content: string } | null = null;
        for (const m of withSession) {
          const s = sessions.get(m.taskId)!;
          viaSystem = s.sourcePath
            ? recoverAgentMdFromSystem(s.sourcePath, m.taskId, name)
            : null;
          if (viaSystem) break;
        }
        if (viaSystem) {
          skillPath = path.join(tmp, 'agent.md');
          fs.writeFileSync(
            skillPath,
            `---\nname: ${name}\ndescription: recovered from session system injection\n---\n${viaSystem.content}\n`,
          );
        } else {
          // 磁盘扫描兜底：消歧用全体涉事会话的派发名并集
          const scanRoot = resolveScanRoot();
          if (!scanRoot) {
            return NextResponse.json(
              { error: '涉事会话 system 均无该 agent 的声明注入，且未配 AGENTS_SCAN_ROOT 且自动探测失败。配置扫描根可启用磁盘兜底。', reason: 'no-declaration' },
              { status: 503 },
            );
          }
          const dispatched = new Set<string>();
          for (const m of withSession) {
            const bridges = await prisma.interactionBridge.findMany({
              where: { sessionId: sessions.get(m.taskId)!.id },
              select: { subagentName: true, subagentType: true },
            });
            for (const b of bridges) {
              const n = b.subagentName ?? b.subagentType;
              if (n) dispatched.add(n);
            }
          }
          const resolved = resolveAgentMd(name, scanAgentDirs(scanRoot), dispatched);
          if (!resolved) {
            return NextResponse.json(
              { error: `涉事会话 system 均无该 agent 的声明注入，且扫描根下找不到 agent "${name}" 的 .md`, reason: 'no-declaration' },
              { status: 404 },
            );
          }
          skillPath = resolved.mdPath;
        }
      } else if (kind === 'run') {
        // run 域：声明源成员（name = taskId）的规程层声明 × 全体成员整会话。
        // 只取编排规程层（"怎么干"，跨成员可共享）；计划层（STATE.md，"干什么"）
        // 是成员私有任务承诺，对其他成员只会产生 N/A 噪声，不入 run 级对账。
        const declarerSession = sessions.get(name);
        if (!declarerSession) {
          return NextResponse.json(
            { error: `声明源成员 ${name} 无已导入会话`, reason: 'no-sessions' },
            { status: 404 },
          );
        }
        const regulation = await recoverWorkflowDeclaration(declarerSession.id, prisma);
        if (!regulation) {
          return NextResponse.json(
            { error: '声明源成员会话无可恢复的编排规程声明（无主 agent Skill invoke 的 skill 正文 / 无 turn0 注入）', reason: 'no-declaration' },
            { status: 404 },
          );
        }
        workflowRealName = await resolveWorkflowSkillName(declarerSession.id, prisma);
        const dir = path.join(tmp, 'run-declaration');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'SKILL.md'),
          `---\nname: ${workflowRealName ?? MAIN_AGENT_WORKFLOW_NAME}\ndescription: recovered from run member session\n---\n${regulation.content}\n`,
        );
        skillPath = dir;
        layers = [{ kind: 'regulation', label: '编排规程', source: regulation.source, content: regulation.content }];
      } else {
        // root：单成员的组合声明
        const m = withSession[0]!;
        const combined = await recoverCombinedWorkflowDeclaration(sessions.get(m.taskId)!.id, prisma);
        if (!combined) {
          return NextResponse.json(
            { error: '此成员会话无可对账的 workflow 声明（规程层：无主 agent Skill invoke / 无 skill resources / 无 SKILL.md body / 无 turn0 注入；计划层：无 STATE.md 等计划文件的 Read）', reason: 'no-declaration' },
            { status: 404 },
          );
        }
        const dir = path.join(tmp, 'main-agent-workflow');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'SKILL.md'),
          `---\nname: main-agent-workflow\ndescription: recovered from session\n---\n${combined.content}\n`,
        );
        skillPath = dir;
        layers = combined.layers;
      }

      // ── 对账输入编排 ──
      // 源 bundle 在盘且契约齐全（skill/agent 域）→ sift `--run` 原生对账：
      // sift 自己扫清单成员、匹配目标调用、转换原生会话（保留原生 id 与子会话
      // 派生关系），报告带 run 溯源（命中会话/调用数 + 审计单元映射）。成员选择
      // 交给 sift（原生 tool_use 扫描为准）；`members` 参数仅作请求校验，不再
      // 逐成员物化 transcript。root 域 sift 明确不支持 --run（且组合声明本就
      // 走 DB 恢复），恒走 DB transcript 路径。
      const outputDir = path.join(tmp, 'out');
      fs.mkdirSync(outputDir, { recursive: true });

      // run 域走宽松模式（无 --kind，整会话不切分）；S1 型声明（turn0 注入）无
      // 真名，sift 无法按名匹配 bundle 成员 → 不走 --run，回落 DB 路径。
      if (kind !== 'root' && !(kind === 'run' && workflowRealName == null)) {
        const bundleDir = resolveRunBundleDir(runId);
        if (bundleDir) {
          const memberBySession: Record<string, AuditMemberRef> = {};
          for (const m of scope.members) {
            memberBySession[m.taskId] = { taskId: m.taskId, label: m.label, framework: m.framework };
          }
          const runArgs: string[] = ['audit', skillPath, '--run', bundleDir, '-o', outputDir, '--turn-refs'];
          if (kind !== 'run') runArgs.push('--kind', kind);
          return makeStreamingAuditResponse(
            runArgs,
            outputDir,
            () => fs.rmSync(tmp, { recursive: true, force: true }),
            { _layers: layers, _memberBySession: memberBySession, expectedSlices: scope.members.length },
          );
        }
      }

      // ── transcript 物化（每成员一个文件；文件名 = 受控成员标签）──
      const members: AuditMemberMap = {};
      const args: string[] = ['audit', skillPath];
      const usedNames = new Set<string>();
      for (const m of withSession) {
        const base = sanitizeFileLabel(m.label ?? m.taskId);
        let fileName = `${base}.json`;
        for (let i = 2; usedNames.has(fileName); i++) fileName = `${base}-${i}.json`;
        usedNames.add(fileName);
        const records = await buildStructuredRecords(sessions.get(m.taskId)!.id, prisma);
        fs.writeFileSync(path.join(tmp, fileName), JSON.stringify(records));
        args.push('--transcript', path.join(tmp, fileName));
        members[fileName] = { taskId: m.taskId, label: m.label, framework: m.framework };
      }
      args.push('-o', outputDir);
      if (kind !== 'run') args.push('--kind', kind);
      args.push('--turn-refs');

      return makeStreamingAuditResponse(
        args,
        outputDir,
        () => fs.rmSync(tmp, { recursive: true, force: true }),
        { _layers: layers, _members: members, expectedSlices: withSession.length },
      );
    } catch (e) {
      logError('route:observe/run/audit', '准备 run 级对账失败', {
        error: e instanceof Error ? e.message : String(e),
      });
      fs.rmSync(tmp, { recursive: true, force: true });
      return NextResponse.json(
        { error: `准备 run 级对账失败：${e instanceof Error ? e.message : String(e)}` },
        { status: 500 },
      );
    }
  },
);
