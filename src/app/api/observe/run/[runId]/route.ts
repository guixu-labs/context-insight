// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// GET    /api/observe/run/[runId] —— Run 详情：view-model + 成员会话 join。
//          runId = solo:<taskId>（刀H）：无主 session 合成单例 run（不读
//          run-store，framework 查询参数消歧同 sid 双行）。
// DELETE /api/observe/run/[runId] —— 删 run 目录（不级联删除已导入会话）；
//          solo 是会话视图，无目录可删（400，删会话走会话删除）。

import { NextRequest, NextResponse } from 'next/server';
import { withRouteLog } from '@/lib/api-route';
import { prisma } from '@/lib/db';
import { logError, logInfo } from '@/lib/logger';
import { deleteRun, readRun, runsRoot } from '@/lib/run/run-store';
import { deleteOwnedSessionRows } from '@/lib/run/session-scope';
import { buildViewModel } from '@/lib/run/view-model';
import { attachSessionRefs, joinSessionRefs } from '@/lib/run/session-link';
import type { SessionRef } from '@/lib/run/model';
import { attachSessionScores } from '@/lib/run/session-score';
import { getActiveSplitMap } from '@/lib/active-time-map';
import { aggregateMemberStats } from '@/lib/collection/run-asset';
import { pageSessionErrorTotal } from '@/lib/collection/session-asset';
import type { RunMemberIdentity, RunMemberStats } from '@/lib/collection/types';
import { isSoloRunId, soloTaskIdOf } from '@/lib/run/identity';
import { resolveSoloRun } from '@/lib/run/solo';

/** 观测聚合（bundle/solo 共用）：Σ成员指标（活跃拆分批量一次，与统一列表
 *  同款两段式）+ 页级错误计数 + 成员身份名册（Overview 单元身份卡：Tool/
 *  proxy 徽标按成员行判定，混布框架可见）——任一失败不阻断详情（降级
 *  null/空，Overview 卡 —） */
async function aggregateRunObservability(
  runId: string,
  lookup: Map<string, SessionRef>,
): Promise<{ memberStats: RunMemberStats | null; totalErrors: number | null; members: RunMemberIdentity[]; codeStats: { additions: number; deletions: number; files: number } | null }> {
  try {
    const activeByRow = await getActiveSplitMap(
      [...lookup.values()]
        .filter(r => r.startTime != null)
        .map(r => ({
          id: r.rowId,
          startTime: new Date(r.startTime!),
          endTime: r.endTime != null ? new Date(r.endTime) : null,
          version: r.version ?? null,
        })),
    );
    const memberStats = aggregateMemberStats(lookup, activeByRow);
    const totalErrors = await pageSessionErrorTotal(prisma, memberStats.memberRowIds);
    const members: RunMemberIdentity[] = [...lookup.values()]
      .map(r => ({ taskId: r.taskId, framework: r.framework, version: r.version ?? null, label: r.label }))
      .sort((a, b) => a.taskId.localeCompare(b.taskId));
    // Σ成员代码统计（Overview 元信息卡 Code 行：run 级 = 成员会话行求和）
    const summaryRows = await prisma.session.findMany({
      where: { id: { in: memberStats.memberRowIds } },
      select: { summaryAdditions: true, summaryDeletions: true, summaryFiles: true },
    });
    const codeStats = summaryRows.length > 0 ? {
      additions: summaryRows.reduce((s, r) => s + (r.summaryAdditions ?? 0), 0),
      deletions: summaryRows.reduce((s, r) => s + (r.summaryDeletions ?? 0), 0),
      files: summaryRows.reduce((s, r) => s + (r.summaryFiles ?? 0), 0),
    } : null;
    return { memberStats, totalErrors, members, codeStats };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logError('route:observe/run/[runId]', '成员观测聚合失败（详情降级）', { runId, error: message });
    return { memberStats: null, totalErrors: null, members: [], codeStats: null };
  }
}

export const GET = withRouteLog(
  'observe/run/[runId]',
  async (request: NextRequest, { params }: { params: Promise<{ runId: string }> }) => {
    const { runId } = await params;
    try {
      // solo:<taskId>（刀H）：单例合成 run——kind='solo' 供工作台显示「会话」标
      if (isSoloRunId(runId)) {
        const taskId = soloTaskIdOf(runId)!;
        const framework = request.nextUrl.searchParams.get('framework') ?? undefined;
        const solo = await resolveSoloRun(prisma, taskId, framework);
        if (!solo) {
          return NextResponse.json(
            { error: `Session not found: ${taskId}`, reason: 'session-not-found' },
            { status: 404 },
          );
        }
        const vm = buildViewModel(solo.index);
        const lookup = new Map<string, SessionRef>([[taskId, solo.ref]]);
        await attachSessionScores(lookup, prisma);
        attachSessionRefs(vm, lookup);
        const { memberStats, totalErrors, members, codeStats } = await aggregateRunObservability(runId, lookup);
        return NextResponse.json({
          run: {
            runId,
            kind: 'solo' as const,
            name: solo.ref.label,
            status: vm.status,
            exportDataComplete: true,
            startedAt: solo.ref.startTime,
            finishedAt: solo.ref.endTime,
            import: null,
          },
          viewModel: vm,
          memberStats,
          members,
          codeStats,
          totalErrors,
        });
      }
      const stored = readRun(runId);
      if (!stored) {
        return NextResponse.json({ error: `Run not found: ${runId}`, reason: 'run-not-found' }, { status: 404 });
      }
      const vm = buildViewModel(stored.index);
      // 成员 ↔ Prisma 会话 join（缺正文成员 session=null，视图容忍渲染）+
      // 评分卡规则层装配（D4/D5 规则分，批量一次算齐）
      const lookup = await joinSessionRefs(stored.index, prisma);
      await attachSessionScores(lookup, prisma);
      attachSessionRefs(vm, lookup);
      const { memberStats, totalErrors, members, codeStats } = await aggregateRunObservability(runId, lookup);
      return NextResponse.json({
        run: {
          runId: stored.runId,
          kind: 'run' as const,
          name: stored.manifest.name ?? null,
          status: vm.status,
          exportDataComplete: vm.exportDataComplete,
          startedAt: vm.startedAt,
          finishedAt: vm.finishedAt,
          import: stored.meta?.data ?? null,
        },
        viewModel: vm,
        memberStats,
        members,
        codeStats,
        totalErrors,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logError('route:observe/run/[runId]', '读取 run 失败', { runId, error: message });
      return NextResponse.json({ error: message }, { status: 500 });
    }
  },
);

export const DELETE = withRouteLog(
  'observe/run/[runId]',
  async (_request: NextRequest, { params }: { params: Promise<{ runId: string }> }) => {
    const { runId } = await params;
    try {
      if (isSoloRunId(runId)) {
        return NextResponse.json(
          { error: `solo run 是会话视图，无目录可删——请删除会话本身：${soloTaskIdOf(runId)}`, reason: 'solo-not-deletable' },
          { status: 400 },
        );
      }
      // 级联清理本 run 导入的会话行（owned 精确对，用户自有会话不受影响），
      // 再删 run 目录——先会话后目录，中途失败时整体可重试
      const stored = readRun(runId);
      const owned = stored?.meta?.data.ownedSessions ?? [];
      const deletedSessions = await deleteOwnedSessionRows(prisma, runsRoot(), owned);
      const ok = deleteRun(runId);
      if (!ok) {
        return NextResponse.json({ error: `Run not found: ${runId}`, reason: 'run-not-found' }, { status: 404 });
      }
      logInfo('route:observe/run/[runId]', '删除 run（级联清理导入会话）', {
        runId,
        deletedSessions,
      });
      return NextResponse.json({ ok: true, runId, deletedSessions });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logError('route:observe/run/[runId]', '删除 run 失败', { runId, error: message });
      return NextResponse.json({ error: message }, { status: 500 });
    }
  },
);
