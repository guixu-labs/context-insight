// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with
// the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See the License in the root of the software repository for the full text of the License.

// 泳道模型 IT（src/lib/swimlane-model + swimlane-axis，Turns 顶部时间线的推导单点）。
// 泳道图自 Perf 迁入 Turns 顶部时，渲染层里的推导整体下沉到这里——旧块
// agent-swimlane-v2.test.tsx 锁的布局事实（车道钉死 / 配色不回绕 / 按派发拆条 /
// 成员分道）在这里以模型层口径延续，另加迁入后的新契约：时刻 → 轮次。

import { describe, it, expect } from 'vitest';
import {
  buildSwimlaneModel,
  pickTurnAt,
  ROOT_COLOR,
  MIN_BAR_PCT,
  swimBarTop,
  swimLaneHeight,
  type SwimAgent,
  type SwimBridge,
  type SwimInterval,
} from '@/lib/swimlane-model';
import { buildAxis, computeTickInterval, fmtDuration, fmtTokens } from '@/lib/swimlane-axis';

const T0 = Date.parse('2026-10-15T10:00:00Z');

function iv(start: number, end: number, turnId: string, over: Partial<SwimInterval> = {}): SwimInterval {
  return { start, end, turnId, ...over };
}

/** 夹具：字段全可缺省（默认 = 子代理），显式给出的原样生效 */
function mkAgent(over: Partial<SwimAgent>): SwimAgent {
  const span = over.span ?? { start: T0, end: T0 + 60_000 };
  return {
    executionId: over.executionId ?? 'exec',
    agentName: over.agentName ?? 'general',
    agentSessionId: over.agentSessionId ?? null,
    isSubagent: over.isSubagent ?? true,
    parentExecutionId: null,
    tokens: 1000,
    maxSingleCallTokens: 500,
    toolCallCount: 3,
    model: 'glm-5.3',
    createdAt: new Date(span.start).toISOString(),
    latencyMs: span.end - span.start,
    firstPrompt: over.firstPrompt ?? null,
    span,
    activeIntervals: over.activeIntervals ?? [],
    member: over.member ?? null,
    ...(over.createdAt ? { createdAt: over.createdAt } : {}),
    ...(over.tokens != null ? { tokens: over.tokens } : {}),
    ...(over.toolCallCount != null ? { toolCallCount: over.toolCallCount } : {}),
    ...(over.model != null ? { model: over.model } : {}),
  };
}

function mkBridge(over: {
  sub: string;
  type: string;
  step?: string;
  ts?: string;
  resp?: string;
  status?: string;
}): SwimBridge {
  return {
    bridgeId: `bridge-${over.sub}-${over.ts ?? ''}`,
    dispatchContent: over.step ?? `step-${over.sub}`,
    dispatchTimestamp: over.ts ?? null,
    responseTimestamp: over.resp ?? null,
    subagentSessionId: over.sub,
    subagentType: over.type,
    status: over.status ?? 'completed',
  };
}

const root = (extra: Partial<SwimAgent> = {}): SwimAgent =>
  mkAgent({ executionId: 'root', span: { start: T0, end: T0 + 400_000 }, isSubagent: false, agentName: 'build', ...extra });

const build = (agents: SwimAgent[], bridges: SwimBridge[] = [], lanes: string[] = [], hiddenTypes?: ReadonlySet<string>) =>
  buildSwimlaneModel({ agents, bridges, lanes, thresholdMs: 300_000, hiddenTypes });

const laneOf = (model: ReturnType<typeof build>, barKey: string) =>
  model.lanes.find(l => l.bars.some(b => b.key === barKey));

describe('buildSwimlaneModel — 道与条', () => {
  it('单成员/无归因：合并 root 单道（data-lane 恒 root、标签 root）', () => {
    const m = build([
      mkAgent({ ...root(), member: { taskId: 'ses-a', label: 'build·g0', isProxy: false } }),
    ]);
    expect(m.lanes.map(l => [l.key, l.label, l.kind])).toEqual([['root', 'root', 'root']]);
    expect(m.lanes[0]!.color).toBe(ROOT_COLOR);
    expect(m.agentCount).toBe(1);
    expect(m.subagentCount).toBe(0);
    expect(m.maxConcurrency).toBe(1);
    expect(m.legend).toEqual([]);
  });

  it('多成员：root 按成员分道（道键 = 成员 taskId、标签 = 成员名），按最早起点排序；无归因 root 并入 root 道', () => {
    const m = build([
      mkAgent({ ...root(), member: { taskId: 'ses-b', label: 'build·验收', isProxy: false } }),
      mkAgent({ ...root(), member: { taskId: 'ses-a', label: 'build·g0', isProxy: false } }),
      mkAgent({ ...root(), span: { start: T0 - 5_000, end: T0 + 10_000 }, member: null }),
    ]);
    // 无归因 root 起点最早 → 在前；A/B 同刻起步 → 按道键定序（不依赖传入顺序）
    expect(m.lanes.map(l => [l.key, l.label])).toEqual([
      ['root', 'root'],
      ['ses-a', 'build·g0'],
      ['ses-b', 'build·验收'],
    ]);
    expect(m.lanes.every(l => l.kind === 'root')).toBe(true);
  });

  it('同成员多个 root 执行叠在同一道的多行（行高等距、条按行号落位）', () => {
    const m = build([
      mkAgent({ ...root(), member: { taskId: 'ses-a', label: 'A', isProxy: false }, executionId: 'r1' }),
      mkAgent({ ...root({ span: { start: T0, end: T0 + 100_000 } }), member: { taskId: 'ses-a', label: 'A', isProxy: false }, executionId: 'r2', span: { start: T0 + 50_000, end: T0 + 150_000 } }),
    ]);
    const lane = m.lanes[0]!;
    expect(lane.key).toBe('root'); // 只有一个成员 → 仍合并 root 单道
    expect(lane.rows).toBe(2);
    expect(lane.bars.map(b => [b.key, b.row])).toEqual([['r1', 0], ['r2', 1]]);
    expect(swimLaneHeight(2)).toBe(2 * 12 + 3 * 3);
    expect(swimBarTop(2, 0)).toBe(3);
    expect(swimBarTop(2, 1)).toBe(3 + 12 + 3);
    expect(swimBarTop(1, 0)).toBe((swimLaneHeight(1) - 12) / 2); // 单行垂直居中
  });

  it('条位置 = 相对整段时长的百分比；瞬时条保底最小宽度', () => {
    const m = build([
      root(),
      mkAgent({ executionId: 'instant', span: { start: T0 + 100_000, end: T0 + 100_000 }, agentSessionId: 'ses-i' }),
    ]);
    const bar = laneOf(m, 'instant')!.bars[0]!;
    expect(bar.startPct).toBeCloseTo(25, 6);
    expect(bar.widthPct).toBe(MIN_BAR_PCT);
    const rootBar = laneOf(m, 'root')!.bars[0]!;
    expect(rootBar.startPct).toBe(0);
    expect(rootBar.widthPct).toBeCloseTo(100, 6);
  });

  it('车道钉死：声明 lanes 后 base/group/empty 各占固定槽，跨波次不漂移；未分类另槽', () => {
    const w = (at: number) => [
      mkAgent({ executionId: `b${at}`, span: { start: T0 + at, end: T0 + at + 50_000 }, agentSessionId: `ses_b${at}` }),
      mkAgent({ executionId: `g${at}`, span: { start: T0 + at + 1_000, end: T0 + at + 50_000 }, agentSessionId: `ses_g${at}` }),
      mkAgent({ executionId: `e${at}`, span: { start: T0 + at + 2_000, end: T0 + at + 50_000 }, agentSessionId: `ses_e${at}` }),
    ];
    const step = (sid: string) => (sid.startsWith('ses_b') ? '④ base 泳道模板计算流'
      : sid.startsWith('ses_g') ? '④ group 泳道模板计算流'
        : sid.startsWith('ses_e') ? '④ empty 泳道模板计算流' : 'P1 需求分析');
    const agents = [
      root(),
      ...w(0), ...w(100_000), ...w(200_000),
      mkAgent({ executionId: 'serial', span: { start: T0 + 3_000, end: T0 + 40_000 }, agentSessionId: 'ses_serial' }),
    ];
    const bridges = [
      ...[0, 100_000, 200_000].flatMap(at => ['b', 'g', 'e'].map(k => mkBridge({ sub: `ses_${k}${at}`, type: 'design-merger', step: step(`ses_${k}${at}`) }))),
      mkBridge({ sub: 'ses_serial', type: 'acme-ops-architect', step: 'P1 需求分析' }),
    ];
    const m = build(agents, bridges, ['base', 'group', 'empty']);
    const laneKey = (ex: string) => laneOf(m, ex)!.key;
    expect(m.lanes.filter(l => l.kind === 'slot').map(l => l.label)).toEqual(['base', 'group', 'empty', 'slot1']);
    for (const at of [0, 100_000, 200_000]) {
      expect(laneKey(`b${at}`)).toBe(laneKey('b0'));
      expect(laneKey(`g${at}`)).toBe(laneKey('g0'));
      expect(laneKey(`e${at}`)).toBe(laneKey('e0'));
    }
    expect(new Set([laneKey('b0'), laneKey('g0'), laneKey('e0'), laneKey('serial')]).size).toBe(4);
    expect(m.lanes.map(l => l.key).slice(-4)).toEqual(['slot-1', 'slot-2', 'slot-3', 'slot-4']);
  });

  it('整段条车道匹配取桥派发内容（agentName 是类型名时不错漏到贪心槽）', () => {
    const m = build([
      root(),
      mkAgent({ executionId: 'w1', span: { start: T0 + 10_000, end: T0 + 60_000 }, agentSessionId: 'ses_w1', agentName: '④ base 模板计算流' }),
      mkAgent({ executionId: 'r1', span: { start: T0 + 70_000, end: T0 + 120_000 }, agentSessionId: 'ses_r1', agentName: 'design-step-reviewer' }),
    ], [
      mkBridge({ sub: 'ses_w1', type: 'design-kernel-coder', step: '④ base 模板计算流' }),
      mkBridge({ sub: 'ses_r1', type: 'design-step-reviewer', step: '④ base R 门控' }),
    ], ['base', 'group', 'empty']);
    expect(laneOf(m, 'w1')!.key).toBe('slot-1');
    expect(laneOf(m, 'r1')!.key).toBe('slot-1');
  });

  it('真实最大并发：重叠的子代理区间扫掠（端点相接不算并发）', () => {
    const m = build([
      root(),
      mkAgent({ executionId: 'a', span: { start: T0 + 10_000, end: T0 + 60_000 }, agentSessionId: 's1' }),
      mkAgent({ executionId: 'b', span: { start: T0 + 20_000, end: T0 + 70_000 }, agentSessionId: 's2' }),
      mkAgent({ executionId: 'c', span: { start: T0 + 70_000, end: T0 + 90_000 }, agentSessionId: 's3' }),
    ]);
    expect(m.maxConcurrency).toBe(2);
  });
});

describe('buildSwimlaneModel — 身份、配色与图例', () => {
  it('类型配色不回绕：14 个类型 14 个图例色互不相同，顺序取首现序', () => {
    const types = Array.from({ length: 14 }, (_, i) => `type-${i + 1}`);
    const m = build([
      root(),
      ...types.map((t, i) => mkAgent({
        executionId: `x${i}`,
        span: { start: T0 + i * 1_000, end: T0 + i * 1_000 + 500 },
        agentSessionId: `ses_${t}`,
      })),
    ], types.map(t => mkBridge({ sub: `ses_${t}`, type: t })));
    expect(m.legend.map(l => l.key)).toEqual(types);
    expect(new Set(m.legend.map(l => l.color)).size).toBe(14);
    expect(m.legend.every(l => l.color !== ROOT_COLOR && l.count === 1)).toBe(true);
    // 条色与图例色同源
    expect(new Set(m.lanes.flatMap(l => l.bars.map(b => b.color))).size).toBe(15); // root + 14
  });

  it('图例次数按拆分后条数计（返工重入各算一次）', () => {
    const m = build([
      root({ span: { start: T0, end: T0 + 200_000 } }),
      mkAgent({ executionId: 'subA', span: { start: T0 + 10_000, end: T0 + 120_000 }, agentSessionId: 'ses_g1' }),
    ], [
      mkBridge({ sub: 'ses_g1', type: 'acme-ops-architect', step: 'P1 返工 r1', ts: '2026-10-15T10:01:00Z', resp: '2026-10-15T10:02:00Z' }),
      mkBridge({ sub: 'ses_g1', type: 'acme-ops-architect', step: 'P1 需求分析', ts: '2026-10-15T10:00:10Z', resp: '2026-10-15T10:00:50Z', status: 'error' }),
    ]);
    expect(m.legend).toEqual([{ key: 'acme-ops-architect', color: expect.any(String), count: 2 }]);
    expect(m.subagentCount).toBe(1);
    expect(m.agentCount).toBe(2);
  });

  it('类型过滤：隐藏的类型条子与槽道一起消失，图例全集与配色不变', () => {
    const m = build([
      root(),
      mkAgent({ executionId: 'subA', span: { start: T0 + 10_000, end: T0 + 60_000 }, agentSessionId: 'ses_g1' }),
      mkAgent({ executionId: 'subB', span: { start: T0 + 20_000, end: T0 + 70_000 }, agentSessionId: 'ses_g2' }),
    ], [
      mkBridge({ sub: 'ses_g1', type: 'design-sync-planner' }),
      mkBridge({ sub: 'ses_g2', type: 'design-tiling-splitter' }),
    ]);
    const all = buildSwimlaneModel({
      agents: [root()], bridges: [], lanes: [], thresholdMs: 300_000,
    });
    expect(all.lanes).toHaveLength(1);
    expect(m.lanes.flatMap(l => l.bars.map(b => b.key))).toEqual(['root', 'subA', 'subB']);
    const hidden = build(
      [root(),
        mkAgent({ executionId: 'subA', span: { start: T0 + 10_000, end: T0 + 60_000 }, agentSessionId: 'ses_g1' }),
        mkAgent({ executionId: 'subB', span: { start: T0 + 20_000, end: T0 + 70_000 }, agentSessionId: 'ses_g2' })],
      [mkBridge({ sub: 'ses_g1', type: 'design-sync-planner' }), mkBridge({ sub: 'ses_g2', type: 'design-tiling-splitter' })],
      [],
      new Set(['design-sync-planner']),
    );
    expect(hidden.lanes.flatMap(l => l.bars.map(b => b.key))).toEqual(['root', 'subB']);
    expect(hidden.legend.map(l => l.key)).toEqual(['design-sync-planner', 'design-tiling-splitter']);
    expect(hidden.legend[0]!.color).toBe(m.legend[0]!.color);
  });
});

describe('buildSwimlaneModel — 按派发拆条与浮窗事实', () => {
  it('同会话多次派发：拆成两根条（首发 #0 在前，哪怕桥倒序传入），各自步骤/状态独立', () => {
    const m = build([
      root({ span: { start: T0, end: T0 + 200_000 } }),
      mkAgent({ executionId: 'subA', span: { start: T0 + 10_000, end: T0 + 120_000 }, agentSessionId: 'ses_g1' }),
    ], [
      mkBridge({ sub: 'ses_g1', type: 'acme-ops-architect', step: 'P1 返工 r1', ts: '2026-10-15T10:01:00Z', resp: '2026-10-15T10:02:00Z' }),
      mkBridge({ sub: 'ses_g1', type: 'acme-ops-architect', step: 'P1 需求分析', ts: '2026-10-15T10:00:10Z', resp: '2026-10-15T10:00:50Z', status: 'error' }),
    ]);
    const bars = m.lanes.flatMap(l => l.bars).filter(b => b.key.startsWith('subA'));
    expect(bars.map(b => b.key)).toEqual(['subA#0', 'subA#1']);
    expect(bars[0]!.tip.step).toBe('P1 需求分析');
    expect(bars[0]!.tip.failed).toBe(true);
    expect(bars[0]!.tip.dispatchCount).toBe(1);
    expect(bars[0]!.startPct).toBeCloseTo((10_000 / 200_000) * 100, 6);
    expect(bars[1]!.tip.step).toBe('P1 返工 r1');
    expect(bars[1]!.tip.failed).toBe(false);
    // 首发条终点 = 该次派发的 response 时刻（50s），不是会话跨度终点
    expect(bars[0]!.tip.endMs).toBe(T0 + 50_000);
  });

  it('拆分条终点钳到下次派发（completedAt 越过下次派发时不得越过下一条起点）', () => {
    const m = build([
      root({ span: { start: T0, end: T0 + 300_000 } }),
      mkAgent({ executionId: 'subA', span: { start: T0 + 10_000, end: T0 + 250_000 }, agentSessionId: 'ses_g1' }),
    ], [
      mkBridge({ sub: 'ses_g1', type: 't', step: '首发', ts: '2026-10-15T10:00:10Z', resp: '2026-10-15T10:04:00Z' }),
      mkBridge({ sub: 'ses_g1', type: 't', step: '返工', ts: '2026-10-15T10:01:00Z', resp: '2026-10-15T10:04:10Z' }),
    ]);
    const bars = m.lanes.flatMap(l => l.bars).filter(b => b.key.startsWith('subA'));
    expect(bars[0]!.tip.endMs).toBe(T0 + 60_000);
    expect(bars[1]!.tip.endMs).toBe(T0 + 250_000);
  });

  it('多派发但缺时间戳：回落整段一根条，步骤拼接全部派发 + 次数', () => {
    const m = build([
      root({ span: { start: T0, end: T0 + 200_000 } }),
      mkAgent({ executionId: 'subA', span: { start: T0 + 10_000, end: T0 + 60_000 }, agentSessionId: 'ses_g1' }),
    ], [
      mkBridge({ sub: 'ses_g1', type: 'acme-ops-architect', step: 'P1 需求分析', status: 'error' }),
      mkBridge({ sub: 'ses_g1', type: 'acme-ops-architect', step: 'P1 返工 r1' }),
    ]);
    const bar = m.lanes.flatMap(l => l.bars).find(b => b.key === 'subA')!;
    expect(bar).toBeTruthy();
    expect(bar.tip.step).toBe('P1 需求分析 · P1 返工 r1');
    expect(bar.tip.dispatchCount).toBe(2);
    // 整段条无单次派发归属：不按某次派发的状态判失败
    expect(bar.failed).toBe(false);
  });

  it('浮窗事实携带执行指标与首条提示', () => {
    const m = build([
      { ...root(), firstPrompt: '把缓存层重写一遍', tokens: 12_345, toolCallCount: 7, model: 'glm-5.3' },
    ]);
    const tip = m.lanes[0]!.bars[0]!.tip;
    expect(tip).toMatchObject({ label: 'root', firstPrompt: '把缓存层重写一遍', tokens: 12_345, maxSingleCallTokens: 500, toolCallCount: 7, model: 'glm-5.3' });
    expect(tip.startMs).toBe(T0);
    expect(tip.endMs).toBe(T0 + 400_000);
  });
});

describe('buildSwimlaneModel — 活跃段', () => {
  it('深色活跃切片 = 逐轮区间按休眠阈值聚类，钳在条内、相对条盒定位；无区间 = 无切片（渲染层画实心）', () => {
    const m = build([
      root({ span: { start: T0, end: T0 + 600_000 },
        activeIntervals: [
          iv(T0 + 10_000, T0 + 20_000, 't1'),
          iv(T0 + 25_000, T0 + 40_000, 't2'),   // 与 t1 间隔 5s < 5min → 同段
          iv(T0 + 500_000, T0 + 510_000, 't3'), // 空档 460s > 5min → 断开
        ],
      }),
      mkAgent({ executionId: 'subA', span: { start: T0 + 100_000, end: T0 + 200_000 }, agentSessionId: 's' }),
    ]);
    const bar = m.lanes[0]!.bars[0]!;
    expect(bar.pieces).toHaveLength(2);
    expect(bar.pieces[0]).toEqual({ leftPct: (10_000 / 600_000) * 100, widthPct: (30_000 / 600_000) * 100 });
    expect(bar.pieces[1]!.leftPct).toBeCloseTo((500_000 / 600_000) * 100, 6);
    expect(m.lanes[1]!.bars[0]!.pieces).toEqual([]);
  });

  it('单轮最长计入 = 休眠阈值（超长轮不把整条空档涂成活跃）', () => {
    const m = build([root({ span: { start: T0, end: T0 + 3_600_000 }, activeIntervals: [iv(T0, T0 + 3_600_000, 'long')] })]);
    const bar = m.lanes[0]!.bars[0]!;
    expect(bar.pieces).toHaveLength(1);
    expect(bar.pieces[0]!.widthPct).toBeCloseTo((300_000 / 3_600_000) * 100, 6);
  });
});

describe('时刻 → 轮次（单击即跳的解析单点）', () => {
  const W = [
    { turnId: 't1', start: 0, end: 30 },
    { turnId: 't2', start: 60, end: 90 },
    { turnId: 't3', start: 100, end: 100 },
  ];

  it('点在轮内即该轮；空档取边界最近的一轮（等距取前一轮）；两端越界取首/末轮', () => {
    expect(pickTurnAt(W, 0)?.turnId).toBe('t1');
    expect(pickTurnAt(W, 15)?.turnId).toBe('t1');
    expect(pickTurnAt(W, 30)?.turnId).toBe('t1');
    expect(pickTurnAt(W, 40)?.turnId).toBe('t1'); // 距 t1 终点 10 / 距 t2 起点 20
    expect(pickTurnAt(W, 45)?.turnId).toBe('t1'); // 等距 15/15 → 前一轮
    expect(pickTurnAt(W, 50)?.turnId).toBe('t2'); // 距 t1 终点 20 / 距 t2 起点 10
    expect(pickTurnAt(W, 75)?.turnId).toBe('t2');
    expect(pickTurnAt(W, 100)?.turnId).toBe('t3'); // 零长轮：恰好命中
    expect(pickTurnAt(W, 1_000)?.turnId).toBe('t3');
    expect(pickTurnAt([], 5)).toBeNull();
  });

  it('root 道窗口 = 该道全部 root 执行的可见轮（去重、升序）；无行轮与无 turnId 的区间不进窗口', () => {
    const m = build([
      root({ span: { start: T0, end: T0 + 200_000 },
        activeIntervals: [
          iv(T0 + 60_000, T0 + 90_000, 'late'),
          iv(T0 + 10_000, T0 + 30_000, 'early'),
          iv(T0 + 10_000, T0 + 30_000, 'early'), // 重复
          iv(T0 + 40_000, T0 + 41_000, 'caveat', { hidden: true }),
          iv(T0 + 150_000, T0 + 160_000, ''),
        ],
      }),
    ]);
    const lane = m.lanes[0]!;
    expect(lane.windows.map(w => w.turnId)).toEqual(['early', 'late']);
    expect(lane.windows[0]).toEqual({ turnId: 'early', start: T0 + 10_000, end: T0 + 30_000 });
    // 播放头索引：可见轮可查，无行轮查不到
    expect(m.windowOfTurn.get('late')?.start).toBe(T0 + 60_000);
    expect(m.windowOfTurn.has('caveat')).toBe(false);
    // 点在无行轮的时刻 → 落到最近的可见轮，而不是跳到一个列表里没有行的轮
    const t = T0 + 40_500;
    expect(pickTurnAt(lane.windows, t)?.turnId).toBe('early');
  });

  it('拆分条的窗口只含与该次派发时间范围有交叠的轮', () => {
    const at = (s: number) => T0 + s * 1000;
    const m = build([
      root({ span: { start: T0, end: T0 + 200_000 } }),
      mkAgent({
        executionId: 'subA', span: { start: at(10), end: at(120) }, agentSessionId: 'ses_g1',
        activeIntervals: [iv(at(12), at(20), 'first-a'), iv(at(22), at(40), 'first-b'), iv(at(62), at(80), 'rework-a')],
      }),
    ], [
      mkBridge({ sub: 'ses_g1', type: 't', step: '首发', ts: new Date(at(10)).toISOString(), resp: new Date(at(50)).toISOString() }),
      mkBridge({ sub: 'ses_g1', type: 't', step: '返工', ts: new Date(at(60)).toISOString(), resp: new Date(at(110)).toISOString() }),
    ]);
    const bars = m.lanes.flatMap(l => l.bars).filter(b => b.key.startsWith('subA'));
    expect(bars[0]!.windows.map(w => w.turnId)).toEqual(['first-a', 'first-b']);
    expect(bars[1]!.windows.map(w => w.turnId)).toEqual(['rework-a']);
    // 在首发条内点 30s → 当时的轮是 first-b；在返工条内点 65s → rework-a
    expect(pickTurnAt(bars[0]!.windows, at(30))?.turnId).toBe('first-b');
    expect(pickTurnAt(bars[1]!.windows, at(65))?.turnId).toBe('rework-a');
  });

  it('槽道自身没有窗口（只在条上可点）', () => {
    const m = build([
      root(),
      mkAgent({ executionId: 'subA', span: { start: T0 + 10_000, end: T0 + 60_000 }, agentSessionId: 's', activeIntervals: [iv(T0 + 10_000, T0 + 60_000, 'sub-t')] }),
    ]);
    const slot = laneOf(m, 'subA')!;
    expect(slot.kind).toBe('slot');
    expect(slot.windows).toEqual([]);
    expect(slot.bars[0]!.windows.map(w => w.turnId)).toEqual(['sub-t']);
  });

  it('全滤空：没有可见执行 → 没有道，时间轴退化成单位长度', () => {
    const m = build(
      [mkAgent({ executionId: 'subA', span: { start: T0 + 10_000, end: T0 + 60_000 }, agentSessionId: 's' })],
      [mkBridge({ sub: 's', type: 'only' })],
      [], new Set(['only']),
    );
    expect(m.lanes).toEqual([]);
    expect(m.totalMs).toBe(1);
    expect(m.windowOfTurn.size).toBe(0);
  });
});

describe('时间轴（swimlane-axis）', () => {
  const hm = (ms: number) => {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  const axisLabels = (start: number, totalMs: number, zoom = 1) => {
    const a = buildAxis(start, totalMs, zoom);
    return { ...a, grid: a.ticks.map(t => t.label) };
  };

  it('刻度间隔：一屏最多 6 格，按可视时长取「整」间隔；放大后间隔随之变细', () => {
    expect(computeTickInterval(5 * 60_000)).toBe(60_000);
    expect(computeTickInterval(3_600_000)).toBe(600_000);
    expect(computeTickInterval(87 * 3_600_000)).toBe(86_400_000);
    expect(computeTickInterval(87 * 3_600_000 / 64)).toBe(3_600_000);
    expect(computeTickInterval(87 * 3_600_000 / 1024)).toBe(60_000);
    const start = new Date(2026, 8, 16, 12, 38, 20).getTime();
    expect(axisLabels(start, 87 * 3_600_000).ticks.length).toBeLessThanOrEqual(6);
  });

  it('放大后刻度只为可视窗口生成（整段上有数千个刻度点，全画会卡）：窗口外扩一格、首屏默认、步数有护栏', () => {
    const start = new Date(2026, 8, 16, 12, 38, 20).getTime();
    const total = 87 * 3_600_000;
    // 未测量（to ≤ from）= 首屏：1024× 下首屏 ≈ 5min，1min 刻度 → 一屏 + 外扩
    const first = buildAxis(start, total, 1024);
    expect(first.ticks.length).toBeGreaterThanOrEqual(6);
    expect(first.ticks.length).toBeLessThanOrEqual(9);
    expect(first.ticks[0]!.pct).toBeGreaterThanOrEqual(0);
    // 窗口右缘外扩一格：末刻度最多越过首屏右缘一个间隔（1min 占整段的百分比）
    const intervalPct = (60_000 / total) * 100;
    expect(first.ticks[first.ticks.length - 1]!.pct).toBeLessThanOrEqual(100 / 1024 + intervalPct + 1e-9);
    // 滚到中段（50% 起）：只给窗口 ± 一格内的刻度
    const mid = buildAxis(start, total, 1024, { fromPct: 50, toPct: 50 + 100 / 1024 });
    expect(mid.ticks.length).toBeGreaterThanOrEqual(6);
    expect(mid.ticks.length).toBeLessThanOrEqual(9);
    expect(mid.ticks.every(t => t.pct >= 50 - intervalPct - 1e-9 && t.pct <= 50 + 100 / 1024 + intervalPct + 1e-9)).toBe(true);
    // 1min 间隔 → 纯 HH:MM（同日窗口内不重复日期）
    expect(mid.ticks.every(t => /^\d{2}:\d{2}$/.test(t.label))).toBe(true);
    expect(mid.ticks.map(t => t.label)).toEqual(['08:08', '08:09', '08:10', '08:11', '08:12', '08:13', '08:14']);
    // 边界标签只看与整轴首/末网格刻度的距离，与窗口无关：1min 刻度下首刻度
    // （12:39）离起点 40s，起点不再另给标签；两端的标签贴在轨道两端，滚走即不可见
    expect(mid.edgeStart).toBeNull();
    expect(buildAxis(start, total, 1).edgeStart).not.toBeNull();
    // 脏数据护栏：totalMs 异常大也不死循环
    expect(buildAxis(start, Number.MAX_SAFE_INTEGER, 1).ticks.length).toBeLessThanOrEqual(64);
  });

  it('跨天会话：刻度对齐本地午夜整点并带日期（不出现 08:38 这类怪时刻）；起点以边界标签补出', () => {
    const start = new Date(2026, 8, 16, 12, 38, 20).getTime();
    const total = 87 * 3_600_000;
    const a = axisLabels(start, total);
    const dated = a.grid.filter(t => /^\d{2}-\d{2} \d{2}:\d{2}$/.test(t));
    expect(dated.length).toBeGreaterThanOrEqual(3);
    for (const t of dated) expect(t).toMatch(/^\d{2}-\d{2} \d{2}:00$/);
    expect(dated).toContain('09-17 00:00');
    expect(dated).toContain('09-19 00:00');
    // 起点 12:38 距首个网格刻度（次日 00:00）~11.4h > 6% → 给边界标签；终点距末刻度 <6% → 去重
    expect(a.edgeStart).toBe(hm(start));
    expect(a.edgeEnd).toBeNull();
    // 刻度在整段里的位置单调递增且落在轴内
    const pcts = a.ticks.map(t => t.pct);
    expect(pcts.every((p, i) => p >= 0 && p <= 100 && (i === 0 || p > pcts[i - 1]!))).toBe(true);
  });

  it('同日会话（1h 刻度）：首个刻度带 MM-DD，其余同日刻度纯 HH:MM', () => {
    const start = new Date(2026, 9, 15, 1, 0, 0).getTime();
    const a = axisLabels(start, 5 * 3_600_000);
    expect(a.grid.length).toBeGreaterThanOrEqual(4);
    expect(a.grid.filter(t => /^\d{2}-\d{2} /.test(t))).toHaveLength(1);
    expect(a.grid.slice(1).every(t => /^\d{2}:\d{2}$/.test(t))).toBe(true);
  });

  it('跨日会话（6h 刻度 <12h）：首刻度与跨日后首刻度都带日期', () => {
    const start = new Date(2026, 9, 15, 0, 0, 0).getTime();
    const a = axisLabels(start, 30 * 3_600_000);
    expect(a.grid.filter(t => /^\d{2}-\d{2} /.test(t)).length).toBeGreaterThanOrEqual(2);
    expect(a.grid.some(t => /^\d{2}:\d{2}$/.test(t))).toBe(true);
  });

  it('起止边界：离最近网格刻度太近（<6% 轴宽）时去重防叠字', () => {
    // 01:23 → 06:23：两端各留 23min 空当，起止标签都出现
    const start = new Date(2026, 9, 15, 1, 23, 0).getTime();
    const total = 5 * 3_600_000;
    const a = axisLabels(start, total);
    expect(a.edgeStart).toBe(hm(start));
    expect(a.edgeEnd).toBe(hm(start + total));
    // 01:00 整点起步：首刻度就在起点，不再另给边界标签
    const b = axisLabels(new Date(2026, 9, 15, 1, 0, 0).getTime(), 5 * 3_600_000);
    expect(b.edgeStart).toBeNull();
  });

  it('刻度密度有下限：窗口里不足 3 格就降一档步长（62min 窗口不会只剩 13:00 一根线），整段全程照旧', () => {
    const start = new Date(2026, 10, 2, 12, 37, 43).getTime();
    const total = 5.5 * 86_400_000;
    // 1×：5.5 天 → 一天一格（6 格，在上限内、不低于下限）
    const whole = buildAxis(start, total, 1);
    expect(whole.ticks.map(t => t.label)).toEqual(['11-03 00:00', '11-04 00:00', '11-05 00:00', '11-06 00:00', '11-07 00:00', '11-08 00:00']);
    // 128×：窗口 ≈ 62min；只看上限会选 1h（6.2 格 > 6）→ 窗口里只有 13:00 一根，降到 10min
    //（窗口 55.3% 处 ≈ 11-05 13:30 → 14:26；外扩一格后首刻度 13:20）
    const zoomed = buildAxis(start, total, 128, { fromPct: 55.3, toPct: 55.3 + 100 / 128 });
    expect(zoomed.ticks.length).toBeGreaterThanOrEqual(5);
    expect(zoomed.ticks.length).toBeLessThanOrEqual(8);
    expect(zoomed.ticks.every(t => /^\d{2}:\d{2}$/.test(t.label))).toBe(true);
    const toMin = (label: string) => Number(label.slice(0, 2)) * 60 + Number(label.slice(3));
    for (let k = 1; k < zoomed.ticks.length; k++) expect(toMin(zoomed.ticks[k]!.label) - toMin(zoomed.ticks[k - 1]!.label)).toBe(10);
  });

  it('刻度标签防裁切只看轨道两端：贴首端左对齐、贴末端右对齐，窗口中段一律居中——放大后窗口落在整段开头几 percent 内也逐个有刻度', () => {
    const total = 87 * 3_600_000;
    const noon = new Date(2026, 8, 16, 12, 0, 0).getTime();
    // 1024× 的首屏（0–0.1%）：刻度全在轨道开头——每个都要在（曾被「离两端
    // 0.5% 内不画」的过滤整批误杀，放大后网格线全空），首刻度左对齐、其余居中
    const zoomed = buildAxis(noon, total, 1024);
    expect(zoomed.ticks.length).toBeGreaterThanOrEqual(6);
    expect(zoomed.ticks[0]!.align).toBe('start');
    expect(zoomed.ticks.slice(1).every(t => t.align === 'center')).toBe(true);
    // 窗口在 50% 处：没有刻度贴轨道两端 → 全部居中
    const mid = buildAxis(noon, total, 1024, { fromPct: 50, toPct: 50 + 100 / 1024 });
    expect(mid.ticks.every(t => t.align === 'center')).toBe(true);
    // 1×（间隔一天）：零点起步首刻度在 0% → 左对齐；72.5h 的会话末刻度在
    // 99.3% → 右对齐；离两端足够远的刻度照常居中
    const whole = buildAxis(new Date(2026, 8, 16, 0, 0, 0).getTime(), 72.5 * 3_600_000, 1);
    expect(whole.ticks[0]).toMatchObject({ pct: 0, align: 'start' });
    expect(whole.ticks[whole.ticks.length - 1]!.align).toBe('end');
    expect(whole.ticks.slice(1, -1).every(t => t.align === 'center')).toBe(true);
  });

  it('时长与 Token 文案', () => {
    expect(fmtDuration(500)).toBe('500ms');
    expect(fmtDuration(12_340)).toBe('12.3s');
    expect(fmtDuration(125_000)).toBe('2.1min');
    expect(fmtDuration(7_200_000)).toBe('2.00h');
    expect(fmtTokens(0)).toBe('');
    expect(fmtTokens(999)).toBe('999');
    expect(fmtTokens(12_300)).toBe('12.3k');
    expect(fmtTokens(2_300_000)).toBe('2.3M');
  });
});
