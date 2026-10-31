// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { NextRequest, NextResponse } from 'next/server';
import { listLakeOverview, importLakeSession, uploadLakeSessionWithNative, GovernanceError, listParadigmDirs } from '@/lib/lake';
import { prewarmLfsBinary } from '@/lib/lake/lfs-setup';
import { resolveNativeCounterpart } from '@/lib/ingest/native-counterpart';
import { agentFrameworkOf } from '@/lib/shared/session-format';
import { listLakeBundles, uploadLakeBundle, importLakeBundle } from '@/lib/lake/bundle';
import { resolveLakeRemote, resolveAdhocRemote, testLakeRemote, listRemoteBranches, redactRemoteSecrets, normalizeDirPrefix } from '@/lib/lake/remote';
import { classifyLakeError, lakeLfsNotEnabledMessage } from '@/lib/lake/auth';
import { ensureMirrorAsync, lakeProgress, listRemoteDirs, markLakePhase } from '@/lib/lake/mirror';
import { listParadigms, listRuns, getLakeListing, invalidateCaches } from '@/lib/collection/lake-view/runs';
import { getScorecard } from '@/lib/collection/lake-view/insight-data';
import { sessionHref } from '@/lib/shared/session-link';
import {
  appendNote, putScorecard, editNote, readRecords, readSubmitInfo, setOpGen,
  readParadigmTarget, setParadigmTarget, NotesConflictError,
  type SessionLoc, type OpGenValue,
} from '@/lib/lake/notes';
import type { LakeRemoteInput } from '@/lib/lake-config';
import { prisma } from '@/lib/db';
import { logError, logInfo, logWarn } from '@/lib/logger';

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  // 单源架构：数据动作（list/dirs/import/upload）的远端一律 resolveLakeRemote()
  // 读服务端 lake-config.json，请求体 config 对它们无意义（忽略）。探测动作
  // （test/branches/dirs 浏览）走 resolveAdhocRemote 拿编辑态显式值。remote
  // 在各分支内按需 resolve；fail() 脱敏消费 nullable remote
  let remote: ReturnType<typeof resolveLakeRemote> | null = null;
  let secrets: (string | undefined)[] = [];
  // 错误出边界统一走这里：消息脱敏 + classifyLakeError 产出结构化 code
  // （no-credentials/auth-failed/forbidden/quota/lfs-not-enabled/unknown）——
  // 前端据 code 给「前往设置页配置凭据」等定向引导，而不是让用户看脱敏后
  // 的 git 原文；lfs-not-enabled 用白话文案整段替换（凭据无问题的结论 +
  // 平台侧出路，见 lakeLfsNotEnabledMessage）
  const fail = (err: unknown, status = 500) => {
    const code = classifyLakeError(err);
    const message = code === 'lfs-not-enabled'
      ? lakeLfsNotEnabledMessage()
      : redactRemoteSecrets(
          err instanceof Error ? err.message : String(err), remote ?? undefined, secrets,
        );
    logError('route:ingest/lake', 'lake action 失败', { code, error: message });
    return NextResponse.json({ error: message, code }, { status: code === 'no-credentials' ? 400 : status });
  };
  try {
    const body = await request.json();
    const { action, config } = body as { action?: string; config?: LakeRemoteInput };
    secrets = [config?.account, config?.password, config?.token];

    // test/branches：编辑态探测（adhoc）——校验异常按 400 出。branches 是
    // 分支选择器：容忍用户正在编辑的脏 branch 字段（不消费它）
    if (config && (action === 'test' || action === 'branches')) {
      const toValidate = action === 'branches' ? { ...config, branch: undefined } : config;
      try {
        resolveAdhocRemote(toValidate);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Invalid lake config';
        return NextResponse.json({ error: message }, { status: 400 });
      }
    }

    if (action === 'test') {
      return NextResponse.json(await testLakeRemote(config));
    }

    if (action === 'branches') {
      try {
        return NextResponse.json({ branches: listRemoteBranches(config) });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to list branches';
        return NextResponse.json({ error: message }, { status: 500 });
      }
    }

    if (action === 'dirs') {
      // 目录浏览（设置页选择上传目录）：编辑态地址（adhoc）——浏览的就是
      // 用户正在输入/已保存表单里的远端
      const { prefix } = body as { prefix?: string };
      try {
        remote = resolveAdhocRemote(config);
        const dirs = listRemoteDirs(remote, normalizeDirPrefix(prefix));
        return NextResponse.json({ dirs });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Invalid prefix';
        return NextResponse.json({ error: message }, { status: 400 });
      }
    }

    // 原生对位预检（只读）：上传弹窗勾选「同步上传原生会话」时即时探测——
    // DB 直查 + 本机磁盘发现，不导入不上传，不触碰数据仓（无 lake 配置也可
    // 用）。found 时 sid = 原生行 taskId（codex 与捕获 sid 不同）
    if (action === 'native-preview') {
      const { taskId, framework } = body as { taskId?: string; framework?: string };
      if (!taskId) {
        return NextResponse.json({ error: 'Missing taskId' }, { status: 400 });
      }
      try {
        const session = await prisma.session.findFirst({
          where: framework ? { taskId, framework } : { taskId },
          select: { taskId: true, framework: true, startTime: true, endTime: true, query: true },
        });
        if (!session) {
          return NextResponse.json({ error: `Session not found: "${taskId}"` }, { status: 404 });
        }
        const resolution = await resolveNativeCounterpart(prisma, {
          taskId: session.taskId,
          framework: session.framework,
          startTime: session.startTime ?? null,
          endTime: session.endTime ?? null,
          query: session.query ?? null,
        });
        const resolutionView = resolution.status === 'not-found'
          ? { status: resolution.status, reason: resolution.reason }
          : resolution.origin === 'db'
            ? { status: resolution.status, origin: resolution.origin, sid: resolution.taskId, framework: resolution.framework }
            : { status: resolution.status, origin: resolution.origin, sid: resolution.hit.sessionId, framework: agentFrameworkOf(session.framework) };
        return NextResponse.json({ resolution: resolutionView });
      } catch (err) {
        return fail(err);
      }
    }

    // 数据动作：单源（服务端 lake-config.json），忽略请求体 config
    try {
      remote = resolveLakeRemote();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid lake config';
      return NextResponse.json({ error: message }, { status: 400 });
    }

    // LFS 预热：首个数据动作即后台自举 git-lfs（fire-and-forget，不阻塞响应；
    // 上传/导入路径的同步就绪检查兜底）——用户浏览/填表期间把环境备好，
    // 正式操作时零等待
    if (remote.lfs) prewarmLfsBinary();

    if (action === 'list') {
      // sessions + 顶层目录（dirs）一次返回：导入对话框的范式下拉 + 会话表
      // 共享单轮 mirror fetch（原先 dirs/list 两路各 fetch 一次 ~1s×2）
      const { sessions, topDirs } = listLakeOverview(remote);
      return NextResponse.json({ sessions, dirs: topDirs });
    }

    if (action === 'import') {
      const { sid, recording } = body as { sid: string; recording?: string };
      if (!sid) {
        return NextResponse.json({ error: 'Missing sid' }, { status: 400 });
      }
      // 记录类（同 sid 双记录）：native = <sid>.native/ 目录（原生 claude 会话），
      // 缺省 capture = 裸 <sid>/ 目录（wire 捕获 / 主位上传）
      if (recording != null && recording !== 'capture' && recording !== 'native') {
        return NextResponse.json({ error: `Invalid recording: "${recording}" (capture | native)` }, { status: 400 });
      }
      try {
        const result = await importLakeSession(sid, prisma, remote, recording === 'native' ? 'native' : 'capture');
        // 视图聚合层 TTL 缓存失效：导入后 lake-runs 的「已导入」列即时翻转
        invalidateCaches();
        // 权威深链回传：framework = 刚落库行的 recording class（分类器可能加
        // -proxy 后缀，lake meta 的裸 agent 名不可预拼）——前端跳转只认此值
        return NextResponse.json({ result, insightUrl: sessionHref(sid, result.framework ?? null) });
      } catch (err) {
        return fail(err);
      }
    }

    if (action === 'upload') {
      const { taskId, description, category, baseline, opGen, framework, withNative } = body as { taskId: string; description?: string; category?: string; baseline?: boolean; opGen?: string; framework?: string; withNative?: boolean };
      if (!taskId) {
        return NextResponse.json({ error: 'Missing taskId' }, { status: 400 });
      }
      // opGen（任务结果标注）：只认 success/failure，其余值视为未标注
      const opGenValue = opGen === 'success' || opGen === 'failure' ? opGen : undefined;
      try {
        // framework：同 sid 双行（方案一）消歧——从捕获行页面上传必须带；
        // withNative：捕获行上传成功后同步上传本机原生会话（可选，对位发现
        // 见 native-preview）
        const result = await uploadLakeSessionWithNative(prisma, taskId, {
          description,
          category: typeof category === 'string' ? category : undefined,
          baseline: baseline === true,
          opGen: opGenValue,
          framework: typeof framework === 'string' ? framework : undefined,
          withNative: withNative === true,
        }, remote);
        return NextResponse.json(result);
      } catch (err) {
        if (err instanceof GovernanceError) {
          logWarn('route:ingest/lake', '上传熔断拒绝', { sid: taskId, error: err.message });
          return NextResponse.json({ error: err.message, governance: true }, { status: 422 });
        }
        return fail(err);
      }
    }

    if (action === 'bundle-list') {
      // bundle 列表（统一布局：全树锚定扫描，条目 paradigm = 所在顶层目录）
      // + imported 标记（run-store 已有该 runId）+ 顶层目录清单（与会话范式
      // 注册表同源——导入弹窗目录选择阶段与 sessions lake 步同构）
      try {
        const items = listLakeBundles(remote);
        const dirs = listParadigmDirs(remote);
        return NextResponse.json({ items, dirs });
      } catch (err) {
        return fail(err);
      }
    }

    if (action === 'bundle-upload') {
      // 已导入 run → <范式>/<runId>/（原子整体替换；换目录重传 = 旧位置迁移
      // 删除，runId 全仓唯一。数据源 = insight，与会话上传同款「导入后上传」
      // 链路）。category = 物理落点（位置即身份），opGen 落 bundle.meta.json
      const { runId, description, category, opGen } = body as { runId?: string; description?: string; category?: string; opGen?: string };
      if (!runId) {
        return NextResponse.json({ error: 'Missing runId' }, { status: 400 });
      }
      // opGen（任务结果标注）：只认 success/failure，其余值视为未标注
      const opGenValue = opGen === 'success' || opGen === 'failure' ? opGen : undefined;
      try {
        const result = await uploadLakeBundle(prisma, runId, description, remote, typeof category === 'string' ? category : undefined, opGenValue);
        return NextResponse.json(result);
      } catch (err) {
        if (err instanceof GovernanceError) {
          logWarn('route:ingest/lake', 'bundle 上传熔断拒绝', { runId, error: err.message });
          return NextResponse.json({ error: err.message, governance: true }, { status: 422 });
        }
        return fail(err);
      }
    }

    if (action === 'bundle-import') {
      // 数据仓 bundle → 物化 → run 域导入 job（fire-and-forget，轮询状态）。
      // paradigm（可选）= 所在顶层目录（列表行已知位置时透传，免全仓搜索；
      // 缺省 runId 全仓锚定搜索——多处同名报错交用户清理）
      const { runId, paradigm } = body as { runId?: string; paradigm?: string };
      if (!runId) {
        return NextResponse.json({ error: 'Missing runId' }, { status: 400 });
      }
      try {
        const handle = await importLakeBundle(runId, { prisma }, remote, typeof paradigm === 'string' ? paradigm : undefined);
        return NextResponse.json(handle);
      } catch (err) {
        return fail(err);
      }
    }

    if (action === 'lake-status') {
      // 数据仓源视图的镜像进度探针（clone/list 阶段轮询）
      return NextResponse.json(lakeProgress());
    }

    if (action === 'paradigm-summary') {
      // 范式侧栏：镜像懒同步 + 目录清单（目录即注册表，统一布局——无专区标记）
      try {
        await ensureMirrorAsync();
        markLakePhase('list');
        const items = await listParadigms();
        markLakePhase('idle');
        return NextResponse.json({ items });
      } catch (err) {
        markLakePhase('idle');
        return fail(err);
      }
    }

    if (action === 'lake-runs') {
      const { paradigm, framework, ccVersion, opGen, scored, imported, q, from, to, tz } = body as {
        paradigm?: string;
        framework?: string | string[];
        ccVersion?: string | string[];
        opGen?: string;
        scored?: boolean;
        imported?: boolean;
        q?: string;
        from?: string;
        to?: string;
        tz?: string;
      };
      if (!paradigm) {
        return NextResponse.json({ error: 'Missing paradigm' }, { status: 400 });
      }
      const csv = (v?: string | string[]): string[] | undefined => {
        if (v == null) return undefined;
        const list = (Array.isArray(v) ? v : v.split(',')).map(s => s.trim()).filter(Boolean);
        return list.length > 0 ? list : undefined;
      };
      try {
        await ensureMirrorAsync();
        const result = await listRuns({
          paradigm,
          framework: csv(framework),
          ccVersion: csv(ccVersion),
          opGen: opGen === 'success' || opGen === 'failure' ? opGen : undefined,
          scored: scored === true ? true : scored === false ? false : undefined,
          imported: imported === true ? true : imported === false ? false : undefined,
          q: typeof q === 'string' && q.trim() ? q.trim() : undefined,
          from: from || undefined,
          to: to || undefined,
          tz: tz || undefined,
        });
        return NextResponse.json(result);
      } catch (err) {
        return fail(err);
      }
    }

    if (action === 'lake-notes') {
      // 实验记录（存数据湖，团队可见）。kind 缺省 = 读（records + 提交信息）；
      // 写四类：note / scorecard / edit / opgen（行为与旧 viewer notes 路由一致）
      const { sid, recording, kind, text, ts, newText, value } = body as {
        sid?: string;
        recording?: string;
        kind?: unknown;
        text?: unknown;
        ts?: unknown;
        newText?: unknown;
        value?: unknown;
      };
      if (!sid) {
        return NextResponse.json({ error: 'Missing sid' }, { status: 400 });
      }
      // recording 消歧：同 sid 双记录（捕获 + 原生）时按参数定位；缺省优先捕获位
      // （存量兼容——旧客户端/裸目录会话无 recording 概念）。请求位在仓里不存在
      // 且仓内只有一个记录位时回落到它：存量裸目录会话的 DB 行 framework 无
      // -proxy 后缀，调用方按框架推断的 recording 可能指错位，仓布局才是记录类
      // 的权威；真双记录两位都在、回落不触发，不跨记录借显。
      const lake = await getLakeListing();
      const matches = lake.sessions.filter(x => x.sid === sid);
      let s = recording === 'native' || recording === 'capture'
        ? matches.find(x => x.recording === recording)
        : undefined;
      if (!s) s = matches.find(x => x.recording === 'capture') ?? matches[0];
      if (!s || !s.paradigm) return NextResponse.json({ error: 'session not found' }, { status: 404 });
      const session: SessionLoc = { sid: s.sid, paradigm: s.paradigm, isBaseline: s.isBaseline, recording: s.recording };
      const dual = matches.some(x => x.recording === 'capture') && matches.some(x => x.recording === 'native');

      if (kind == null) {
        const [records, submit] = await Promise.all([readRecords(session), readSubmitInfo(session)]);
        return NextResponse.json({ sid, records, submit });
      }

      let writeKind = 'note';
      let noteText = '';
      let edit = { ts: '', text: '', newText: '' };
      let opGen: OpGenValue | 'invalid' = 'invalid';
      if (kind === 'scorecard') writeKind = 'scorecard';
      if (kind === 'edit') {
        writeKind = 'edit';
        edit = {
          ts: typeof ts === 'string' ? ts : '',
          text: typeof text === 'string' ? text : '',
          newText: typeof newText === 'string' ? newText : '',
        };
      }
      if (kind === 'opgen') {
        writeKind = 'opgen';
        opGen = value === 'success' || value === 'failure' ? value : (value === null ? null : 'invalid');
      }
      if (typeof text === 'string' && writeKind !== 'edit' && writeKind !== 'opgen') noteText = text;
      try {
        let records;
        if (writeKind === 'scorecard') {
          // recording 消歧仅在真双记录（仓内两位并存）时传下去：快照必须取本记录行
          // 的卡（capture=捕获行）。单记录位仓（存量裸目录）不传——其 DB 行 framework
          // 无 -proxy 后缀，按 capture→-proxy 启发式查会永远落空，把已评分的存量
          // 会话误判成「未导入或未评分」
          const card = await getScorecard(sid, undefined, dual ? (session.recording === 'native' ? 'native' : 'capture') : undefined);
          if (!card) return NextResponse.json({ error: '无评分卡（该会话未导入或未评分）' }, { status: 409 });
          records = await putScorecard(session, card);
        } else if (writeKind === 'edit') {
          if (!edit.ts || !edit.text) return NextResponse.json({ error: 'ts and text required' }, { status: 400 });
          records = await editNote(session, { ts: edit.ts, text: edit.text }, edit.newText);
        } else if (writeKind === 'opgen') {
          if (opGen === 'invalid') return NextResponse.json({ error: "value must be 'success' | 'failure' | null" }, { status: 400 });
          await setOpGen(session, opGen);
        } else {
          if (!noteText.trim()) return NextResponse.json({ error: 'text required' }, { status: 400 });
          records = await appendNote(session, noteText);
        }
        invalidateCaches();
        logInfo('route:ingest/lake', 'lake 记录已推送', { sid, kind: writeKind, paradigm: session.paradigm });
        return NextResponse.json({ sid, records });
      } catch (e) {
        if (e instanceof NotesConflictError) {
          logWarn('route:ingest/lake', '写入冲突', { sid, error: e.message });
          return NextResponse.json({ error: e.message }, { status: 409 });
        }
        logError('route:ingest/lake', '写入失败', { sid, error: e instanceof Error ? e.message : String(e) });
        return NextResponse.json({ error: e instanceof Error ? e.message : 'append failed' }, { status: 502 });
      }
    }

    if (action === 'paradigm-target') {
      // 优化目标（基线/期望，存湖 <paradigm>/<paradigm>.jsonl）：baselineMs/
      // expectedMs 俱缺 = 读；写 = 追加式「末条生效」，畸形值 400——静默收敛成
      // null 会把团队已存参考线整条抹掉
      const { name } = body as { name?: string };
      if (!name) {
        return NextResponse.json({ error: 'Missing name' }, { status: 400 });
      }
      const raw = body as { baselineMs?: unknown; expectedMs?: unknown };
      const hasBaseline = 'baselineMs' in raw;
      const hasExpected = 'expectedMs' in raw;
      if (!hasBaseline && !hasExpected) {
        try {
          return NextResponse.json({ name, target: await readParadigmTarget(name) });
        } catch (e) {
          logWarn('route:ingest/lake', '读取优化目标失败', { error: e instanceof Error ? e.message : String(e) });
          return NextResponse.json({ error: e instanceof Error ? e.message : 'bad paradigm' }, { status: 400 });
        }
      }
      for (const key of ['baselineMs', 'expectedMs'] as const) {
        if (key in raw && raw[key] !== null && typeof raw[key] !== 'number') {
          return NextResponse.json({ error: `${key} must be a number or null` }, { status: 400 });
        }
      }
      const baselineMs = typeof raw.baselineMs === 'number' ? raw.baselineMs : null;
      const expectedMs = typeof raw.expectedMs === 'number' ? raw.expectedMs : null;
      try {
        await setParadigmTarget(name, baselineMs, expectedMs);
        logInfo('route:ingest/lake', '优化目标已写入', { name, baselineMs, expectedMs });
        return NextResponse.json({ name, target: await readParadigmTarget(name) });
      } catch (e) {
        logWarn('route:ingest/lake', '写入优化目标失败', { error: e instanceof Error ? e.message : String(e) });
        if (e instanceof NotesConflictError) return NextResponse.json({ error: e.message }, { status: 409 });
        return NextResponse.json({ error: e instanceof Error ? e.message : 'save failed' }, { status: 400 });
      }
    }

    return NextResponse.json({ error: `Unknown action: "${action}". Supported: list, import, upload, bundle-list, bundle-upload, bundle-import, paradigm-summary, lake-runs, lake-status, lake-notes, paradigm-target, test, branches, dirs` }, { status: 400 });
  } catch (err) {
    return fail(err);
  }
}
