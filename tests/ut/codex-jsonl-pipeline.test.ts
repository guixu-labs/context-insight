// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// codex-jsonl 适配器（agent-source-framework 首个新源）全链路 IT：
// fixture（tests/ut/data/codex-sessions/，脱敏复刻真机多 agent 样本——主会话
// spawn 双子代理）→ 注册表身份/嗅探 → readSession 状态机（响应组冲刷/工具
// 输出回填/注入归一）→ 子代理发现（spawn 输出 + parent_thread_id 交叉验证）→
// import-file 路由 → DB 轮次/工具/usage 断言 → 增量刷新 → 负向（子文件丢失、
// 未知 payload、损坏行、非 codex 文件不误吞、未知源 400）。

import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prisma } from '../setup';
import { POST as importFilePOST } from '@/app/api/ingest/import-file/route';
import { POST as importSessionsPOST } from '@/app/api/ingest/import-file/sessions/route';
import { POST as refreshPOST } from '@/app/api/ingest/refresh-session/route';
import {
  listSessions,
  readSession,
  readSubagentInteractions,
  listSubagentRolloutFiles,
  listSessionFiles,
  extractVersion,
} from '@/lib/ingest/adapters/codex-jsonl';
import {
  frameworkOfSource,
  sourceOfFramework,
  isKnownSource,
  requireSource,
  sniffImportableFile,
} from '@/lib/ingest/adapters/registry';
import { BRAND_SOURCE_TYPE } from '@/lib/branding';

const DATA = path.join(__dirname, './data/codex-sessions');
const MAIN = '11111111-aaaa-4b04-8f7e-abcdef000001';
const SUB1 = '22222222-bbbb-4b04-8f7e-abcdef000002';
const SUB2 = '33333333-cccc-4b04-8f7e-abcdef000003';
const mainFile = path.join(DATA, `rollout-2026-10-09T10-23-45-${MAIN}.jsonl`);
const sub1File = path.join(DATA, `rollout-2026-10-09T10-24-10-${SUB1}.jsonl`);
const sub2File = path.join(DATA, `rollout-2026-10-09T10-24-12-${SUB2}.jsonl`);

function req(body: unknown, url: string): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const createdTaskIds: string[] = [];

afterEach(async () => {
  for (const taskId of createdTaskIds.splice(0)) {
    const rows = await prisma.session.findMany({ where: { taskId } });
    for (const row of rows) {
      await prisma.session.delete({ where: { id: row.id } }).catch(() => { /* ignore */ });
    }
  }
});

describe('agent-source-framework 注册表：身份映射与文件嗅探单点', () => {
  it('frameworkOfSource / sourceOfFramework 双向映射（含回归锁）', () => {
    expect(frameworkOfSource('codex-jsonl')).toBe('codex');
    expect(sourceOfFramework('codex')).toBe('codex-jsonl');
    // 既有源回归锁（重构前内联三元的等价性）
    expect(frameworkOfSource('opencode-db')).toBe('opencode');
    expect(sourceOfFramework('opencode')).toBe('opencode-db');
    expect(frameworkOfSource('claude-jsonl')).toBe('claude-code');
    expect(sourceOfFramework('claude-code')).toBe('claude-jsonl');
    // 容器源（insight 导出件 = 序列化搬运格式，非会话生产者）不声明源级
    // framework——会话身份走 readSessionMeta 件内声明（曾用容器身份冒充
    // agent 身份：framework='cannbot-insight' 误标史）。反查同样不命中，
    // 存量误标行由调用方 `?? framework` 自身值兜底路由
    expect(frameworkOfSource(BRAND_SOURCE_TYPE)).toBeNull();
    expect(sourceOfFramework(BRAND_SOURCE_TYPE)).toBeNull();
    // 未知值
    expect(frameworkOfSource('nope')).toBeNull();
    expect(sourceOfFramework('nope')).toBeNull();
  });

  it('isKnownSource / requireSource 未知源报错带支持清单', () => {
    expect(isKnownSource('codex-jsonl')).toBe(true);
    expect(isKnownSource('nope')).toBe(false);
    expect(() => requireSource('nope')).toThrow(/Unknown source type: "nope"\. Supported types: .+codex-jsonl/);
  });

  it('sniffImportableFile：rollout- 前缀先于 claude-jsonl 扩展名兜底', () => {
    expect(sniffImportableFile('rollout-2026-10-09T10-23-45-abc.jsonl')).toBe('codex-jsonl');
    expect(sniffImportableFile('session-abc.jsonl')).toBe('claude-jsonl');
    expect(sniffImportableFile('cpx-abc.jsonl.7z')).toBe('claude-jsonl');
    expect(sniffImportableFile('context_session_x.db')).toBe(BRAND_SOURCE_TYPE);
    expect(sniffImportableFile('opencode.db')).toBe('opencode-db');
    expect(sniffImportableFile('notes.txt')).toBeNull();
    expect(sniffImportableFile('README.md')).toBeNull();
  });
});

describe('codex-jsonl listSessions：子代理不列出、非 codex 文件不误吞', () => {
  it('只列主会话，字段正确（uuid/firstQuery/model/turnCount/totalTokens/version）', () => {
    const sessions = listSessions(DATA);
    expect(sessions.map(s => s.id)).toEqual([MAIN]); // SUB1/SUB2（thread_source=subagent）与 4444（无 session_meta）都不在列
    const main = sessions[0];
    expect(main.firstQuery).toContain('请派发子代理');
    expect(main.modelName).toBe('test-model-pro');
    expect(main.turnCount).toBe(1); // task_started 计数（event_msg 不双计，D10）
    expect(main.totalTokens).toBe(1345); // (160+300+365+520)，codex 权威 total_tokens（含 reasoning）
    expect(main.version).toBe('0.161.0');
    expect(main.createdAt).toBe('2026-10-09T10:23:45.000Z');
    expect(main.endedAt).toBe('2026-10-09T10:24:14.000Z'); // 末行（ordinal 29）时间戳
  });

  it('import-file/sessions 路由：codex 源列出会话（API 层验证）', async () => {
    const res = await importSessionsPOST(req({ source: 'codex-jsonl', filePath: DATA }, '/api/ingest/import-file/sessions'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.sessions.map((s: { id: string }) => s.id)).toEqual([MAIN]);
  });
});

describe('codex-jsonl readSession 状态机', () => {
  it('响应组冲刷：每组 message+tools → usage 挂接；输出晚于冲刷经 call_id 回填', () => {
    const turns = readSession(mainFile, MAIN);
    // D1 修订：developer skills / environment_context 等静态注入丢弃不进时间线
    // （fixture 含这些行，正好锁丢弃行为）——只剩 1 user + 4 assistant
    // （exec 组 / spawn 组 / wait 组 / 最终回答组）+ 2 system（子代理通知）
    expect(turns.map(t => t.role)).toEqual([
      'user',
      'assistant', 'assistant', 'assistant', 'system', 'system', 'assistant',
    ]);

    const [user, exec1, spawn2, wait3, notif1, notif2, final] = turns;
    expect(user!.content).toContain('请派发子代理');
    expect(user!.model).toBeNull();

    // 静态注入零泄漏：skills 指令 / 环境快照不在任何轮次内容里
    const allContent = turns.map(t => [t.content ?? '', ...(t.tool_calls ?? []).map(c => c.resultJson ?? '')].join('')).join('');
    expect(allContent).not.toContain('<skills_instructions>');
    expect(allContent).not.toContain('<environment_context>');

    // 组1：空 assistant 文本 + exec_command（usage：input 100 / reasoning 10）
    expect(exec1!.content).toBeNull();
    expect(exec1!.tool_calls!.map(c => c.toolName)).toEqual(['exec_command']);
    expect(exec1!.tool_calls![0].resultJson).toBe('demo-insight\ndemo-cpx'); // usage 之后到达仍回填
    expect(exec1!.usage).toMatchObject({ input: 100, output: 50, reasoning: 10, total: 160 });
    expect(exec1!.model).toBe('test-model-pro');
    expect(exec1!.latency).toBeGreaterThan(0);

    // 组2：文本 + spawn_agent×2，输出 JSON 回填
    expect(spawn2!.content).toContain('路径确认。现在派发两个子代理并行阅读。');
    const spawnCalls = spawn2!.tool_calls!;
    expect(spawnCalls.map(c => c.toolName)).toEqual(['spawn_agent', 'spawn_agent']);
    expect(spawnCalls[0].resultJson).toContain(SUB1);
    expect(spawnCalls[0].resultJson).toContain('Euclid');
    expect(spawnCalls[1].resultJson).toContain('Kepler');

    // 组3：wait_agent
    expect(wait3!.tool_calls!.map(c => c.toolName)).toEqual(['wait_agent']);
    expect(wait3!.tool_calls![0].resultJson).toContain('等待完成');

    // subagent_notification：事件提示（claude task-notification 同款 ✅ 格式）。
    // 源文件核实：status.completed 是纯字符串（子代理最终消息全文，与其时间线
    // 最终轮逐字节相同）——通知带 200 字预览 + 全文指针，不复制全文。
    // 初版 bug 锁：误判嵌套对象走了 JSON.stringify 兜底 → 引号 + 字面 \n 转义。
    expect(notif1!.content).toMatch(/^✅ 子代理完成: 22222222-bbbb-4b04-8f7e-abcdef000002 \[completed\]\ndemo-insight 阅读完成/);
    expect(notif1!.content).toContain('…（全文 '); // 长文本 → 预览截断 + 全文指针（明示有意截断）
    expect(notif1!.content).not.toContain('\\"'); // 无 JSON 字符串化残留
    expect(notif1!.content).not.toMatch(/\\n/);   // 无字面 \n 序列（真实换行）
    expect(notif2!.content).toContain('[completed]\ndemo-cpx 阅读完成'); // 短文本：全文干净直出
    expect(notif2!.content).not.toContain('"demo-cpx'); // 无前导引号（初版 bug）

    // 组4：最终回答（无工具）
    expect(final!.content).toContain('两个子代理都已完成');
    expect(final!.tool_calls).toBeNull();
    expect(final!.usage!.total).toBe(520);
  });

  it('reasoning → <thinking> 前缀；web_search_call → 工具调用', () => {
    const sub1 = readSession(sub1File, SUB1);
    // 子代理线程里的 environment_context 同样丢弃（D1 修订）
    expect(sub1.map(t => t.role)).toEqual(['user', 'assistant', 'assistant']);
    const [thinkingTurn] = sub1.filter(t => t.role === 'assistant');
    expect(thinkingTurn!.content).toMatch(/^<thinking>我需要先浏览/); // D2：文本进 content 前缀
    expect(thinkingTurn!.usage!.reasoning).toBe(15); // token 走 usage.reasoning（不加字段）
    expect(thinkingTurn!.tool_calls![0].toolName).toBe('exec_command');

    const sub2 = readSession(sub2File, SUB2);
    const webTurn = sub2.find(t => t.tool_calls?.length);
    expect(webTurn!.tool_calls![0].toolName).toBe('web_search');
    expect(webTurn!.tool_calls![0].argsJson).toContain('demo-cpx 文档');
    expect(webTurn!.tool_calls![0].resultJson).toContain('completed');
  });

  it('custom_tool_call/output：apply_patch 工具调用可生成并回填结果', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-custom-tool-'));
    const file = path.join(root, `rollout-2026-11-12T15-00-00-${MAIN}.jsonl`);
    const startedAt = '2026-11-12T07:00:01.000Z';
    const usageAt = '2026-11-12T07:00:02.000Z';
    const completedAt = '2026-11-12T07:00:03.000Z';
    const patchInput = '*** Begin Patch\n*** Add File: a.py\n+print(1)\n*** End Patch\n';
    fs.writeFileSync(file, [
      JSON.stringify({
        timestamp: '2026-11-12T07:00:00.000Z', ordinal: 0, type: 'session_meta',
        payload: { id: MAIN, session_id: MAIN, timestamp: '2026-11-12T07:00:00.000Z', cli_version: '0.167.0', thread_source: 'user' },
      }),
      JSON.stringify({ timestamp: '2026-11-12T07:00:00.100Z', ordinal: 1, type: 'turn_context', payload: { model: 'test-model' } }),
      JSON.stringify({
        timestamp: startedAt, ordinal: 2, type: 'response_item',
        payload: {
          type: 'custom_tool_call', id: 'ctc_call_patch', status: 'in_progress', call_id: 'call_patch',
          name: 'apply_patch', input: patchInput,
        },
      }),
      JSON.stringify({
        timestamp: usageAt, ordinal: 3, type: 'token_usage_record',
        payload: { usage: { input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 20, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 120 } },
      }),
      JSON.stringify({
        timestamp: completedAt, ordinal: 4, type: 'response_item',
        payload: { type: 'custom_tool_call_output', id: 'ctco_patch', call_id: 'call_patch', output: 'Success. Updated a.py' },
      }),
    ].join('\n') + '\n');
    try {
      const turns = readSession(file, MAIN);
      expect(turns).toHaveLength(1);
      const turn = turns[0];
      expect(turn.timestamp).toBe(startedAt);
      expect(turn.timeInfo?.created).toBe(Date.parse(startedAt));
      expect(turn.usage).toMatchObject({
        total: 120,
        input: 40,
        cacheRead: 40,
        cacheWrite: 20,
        inputMessagesTokens: 100,
        output: 15,
        reasoning: 5,
      });
      expect(turn.tool_calls).toHaveLength(1);
      expect(turn.tool_calls![0]).toMatchObject({
        toolCallId: 'call_patch',
        toolName: 'apply_patch',
        state: 'completed',
        startedAt: Date.parse(startedAt),
        completedAt: Date.parse(completedAt),
        resultJson: 'Success. Updated a.py',
      });
      expect(turn.tool_calls![0].argsJson).toBe(patchInput);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('未知 payload 跳过 + 损坏行容错（fixture 内置锁）', () => {
    // 主 fixture 含 future_unknown_item 与一行坏 JSON——上两条断言能通过即证明
    // 没有炸；这里显式锁 interactions 数不受污染（9 原始行 - 2 静态注入）
    const turns = readSession(mainFile, MAIN);
    expect(turns).toHaveLength(7);
    expect(turns.every(t => t.content == null || !t.content.includes('payload_foo'))).toBe(true);
  });

  it('extractVersion：cli_version；目录路径按 sessionId 解析（UI 列表导入流程）', () => {
    expect(extractVersion(mainFile)).toBe('0.161.0');
    expect(extractVersion(DATA, MAIN)).toBe('0.161.0'); // dbPath=sessions 根目录
  });
});

describe('codex-jsonl 子代理发现（spawn 输出 + parent_thread_id 交叉验证）', () => {
  it('readSubagentInteractions：双生子代理全部打标', () => {
    const subs = readSubagentInteractions(mainFile, MAIN);
    expect(subs).toHaveLength(6); // Euclid 3 + Kepler 3（各自 environment_context 已丢弃）
    const euclid = subs.filter(s => s.subagent_session_id === SUB1);
    const kepler = subs.filter(s => s.subagent_session_id === SUB2);
    expect(euclid).toHaveLength(3);
    expect(kepler).toHaveLength(3);
    expect(euclid.every(s => s.subagent_name === 'Euclid')).toBe(true);
    expect(kepler.every(s => s.subagent_name === 'Kepler')).toBe(true);
  });

  it('子代理类型双源：子 meta agent_role 优先，老版子文件无角色退父侧 spawn 参数', () => {
    const subs = readSubagentInteractions(mainFile, MAIN);
    // Euclid 子 rollout 的 session_meta 带 agent_role（新格式）→ 子侧事实优先
    const euclid = subs.filter(s => s.subagent_session_id === SUB1);
    expect(euclid.every(s => s.subagent_type === 'designer')).toBe(true);
    // Kepler 子 rollout 无 agent_role（老格式）→ 退父侧 spawn 参数的 agent_type
    const kepler = subs.filter(s => s.subagent_session_id === SUB2);
    expect(kepler.every(s => s.subagent_type === 'developer')).toBe(true);
    // 昵称（实例名）与角色（类型分组维度）分通道——类型通道喂昵称会把
    // 泳道/关系图按类型分组拆成一人一组（type=averroes 回归锁）
    expect(euclid.every(s => s.subagent_type !== s.subagent_name)).toBe(true);
  });

  it('listSessionFiles：主 rollout + 子代理 rollout（subagents/ 下、文件名保持原名）；与 readSubagents 同一发现；主文件缺失 → []', () => {
    const refs = listSessionFiles(mainFile, MAIN)!;
    const byPath = (list: typeof refs) => [...list].sort((a, b) => a.filePath.localeCompare(b.filePath));
    expect(byPath(refs).map(r => [r.role, r.filePath, r.relPath])).toEqual([
      ['main', mainFile, path.basename(mainFile)],
      ['subagent', sub1File, `subagents/${path.basename(sub1File)}`],
      ['subagent', sub2File, `subagents/${path.basename(sub2File)}`],
    ]);
    // 发现与 readSubagents 同源：文件集里的子代理 = 读出来的子代理（去重）
    const readIds = new Set(readSubagentInteractions(mainFile, MAIN).map(s => s.subagent_session_id));
    expect(refs.filter(r => r.role === 'subagent')).toHaveLength(readIds.size);
    // 目录路径（UI「列表选择→导入」）与文件路径同一结果
    expect(byPath(listSessionFiles(DATA, MAIN)!)).toEqual(byPath(refs));
    expect(listSessionFiles(path.join(os.tmpdir(), 'no-such-rollout.jsonl'), MAIN)).toEqual([]);
  });

  it('listSubagentRolloutFiles：parent_thread_id 不匹配的文件不进入上传集合', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-sub-parent-'));
    const mainCopy = path.join(root, path.basename(mainFile));
    const wrongSub = path.join(root, path.basename(sub1File));
    fs.copyFileSync(mainFile, mainCopy);
    const wrongLines = fs.readFileSync(sub1File, 'utf-8').split('\n').map(line => {
      if (!line.trim()) return line;
      const row = JSON.parse(line) as { type?: string; payload?: { parent_thread_id?: string } };
      if (row.type === 'session_meta' && row.payload) row.payload.parent_thread_id = 'not-the-main-session';
      return JSON.stringify(row);
    });
    fs.writeFileSync(wrongSub, wrongLines.join('\n'));
    try {
      expect(listSubagentRolloutFiles(mainCopy, MAIN)).toEqual([]);
      expect(readSubagentInteractions(mainCopy, MAIN)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('目录路径与文件路径同结果（回归锁：UI「列表选择→导入」传 sessions 根目录）', () => {
    // 此前 readSubagentInteractions 直读目录会静默返回空——子代理轮次丢失、
    // 时间线只剩通知 system turn。必须先按 sessionId 解析到 rollout 文件。
    const viaDir = readSubagentInteractions(DATA, MAIN);
    const viaFile = readSubagentInteractions(mainFile, MAIN);
    expect(viaDir).toHaveLength(6);
    expect(viaDir).toEqual(viaFile); // 逐字段一致
    // readSession 目录解析同样不受影响
    expect(readSession(DATA, MAIN)).toEqual(readSession(mainFile, MAIN));
  });

  it('子文件丢失不阻塞：spawn/wait 工具结果仍在主时间线', () => {
    // 复制主文件到无子文件的临时目录（子 rollout 缺失）
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-nochild-'));
    const tmpFile = path.join(tmpDir, `rollout-2026-10-09T10-23-45-${MAIN}.jsonl`);
    fs.copyFileSync(mainFile, tmpFile);
    try {
      const subs = readSubagentInteractions(tmpFile, MAIN);
      expect(subs).toHaveLength(0); // 子文件缺失 → 跳过，不抛错
      const main = readSession(tmpFile, MAIN);
      const spawnCalls = main.flatMap(t => t.tool_calls ?? []).filter(c => c.toolName === 'spawn_agent');
      expect(spawnCalls).toHaveLength(2); // 主时间线的 spawn 结果不受影响
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('codex-jsonl 全链路导入（rollout → adapter → normalize → turn-split → DB）', () => {
  it('import-file 路由：会话行 + 轮次 + 工具 + 子代理归属 + usage 聚合', async () => {
    await prisma.session.deleteMany({ where: { taskId: MAIN } });
    createdTaskIds.push(MAIN);

    const res = await importFilePOST(req(
      { source: 'codex-jsonl', sessionId: MAIN, filePath: mainFile },
      '/api/ingest/import-file',
    ));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.imported).toBe(true);
    expect(data.framework).toBe('codex'); // 原生落库值（无 -proxy 装饰）
    expect(data.version).toBe('0.161.0'); // descriptor.extractVersion 能力路径

    const session = await prisma.session.findFirst({ where: { taskId: MAIN, framework: 'codex' } });
    expect(session).not.toBeNull();
    expect(session!.query).toContain('请派发子代理'); // firstQuery 跳过注入
    expect(Number(session!.totalTokens)).toBe(1835); // 1345 + (135+150) + (100+105)，与列表预览同口径

    const turns = await prisma.turn.findMany({
      where: { sessionId: session!.id },
      orderBy: { turnIndex: 'asc' },
    });
    // 7 主会话 + 6 子代理 = 13 轮（1 interaction = 1 turn）
    expect(turns).toHaveLength(13);

    const roles = turns.reduce<Record<string, number>>((acc, t) => {
      acc[t.role] = (acc[t.role] ?? 0) + 1;
      return acc;
    }, {});
    expect(roles).toEqual({ system: 2, user: 3, assistant: 8 }); // 主 2s+1u+4a + 子 2u+4a（注入已丢弃）

    // 子代理轮次归属（subagentName/subagentSessionId 落库）
    const euclidTurns = turns.filter(t => t.subagentName === 'Euclid');
    const keplerTurns = turns.filter(t => t.subagentName === 'Kepler');
    expect(euclidTurns).toHaveLength(3);
    expect(keplerTurns).toHaveLength(3);
    expect(euclidTurns.every(t => t.subagentSessionId === SUB1)).toBe(true);

    // 工具调用 join：spawn_agent / exec_command / wait_agent / web_search 全部落库且带结果
    const toolCalls = await prisma.toolCall.findMany({
      where: { turnId: { in: turns.map(t => t.id) } },
    });
    const byName = toolCalls.reduce<Record<string, number>>((acc, c) => {
      acc[c.toolName] = (acc[c.toolName] ?? 0) + 1;
      return acc;
    }, {});
    expect(byName).toEqual({ exec_command: 2, spawn_agent: 2, wait_agent: 1, web_search: 1 });
    const spawnRow = toolCalls.find(c => c.toolName === 'spawn_agent');
    expect(spawnRow!.resultJson).toContain('Euclid');
    const waitRow = toolCalls.find(c => c.toolName === 'wait_agent');
    expect(waitRow!.resultJson).toContain('等待完成');

    // Bridge：spawn_agent 派发 → 子代理泳道的锚点（TurnTimeline 的泳道/
    // Workflow 关系图/性能视图全部由 Bridge 驱动）。bridge-builder 识别
    // spawn_agent：resultJson 的 agent_id 精确匹配、nickname 进 subagentName、
    // args.message 进 dispatchContent
    const bridges = await prisma.interactionBridge.findMany({ where: { sessionId: session!.id } });
    expect(bridges).toHaveLength(2);
    const euclidBridge = bridges.find(b => b.subagentName === 'Euclid');
    const keplerBridge = bridges.find(b => b.subagentName === 'Kepler');
    expect(euclidBridge).toBeTruthy();
    expect(keplerBridge).toBeTruthy();
    expect(euclidBridge!.subagentSessionId).toBe(SUB1);
    expect(keplerBridge!.subagentSessionId).toBe(SUB2);
    expect(euclidBridge!.dispatchContent).toContain('阅读'); // spawn args.message
    expect(euclidBridge!.dispatchTurnId).toBe(spawnRow!.turnId); // 锚在派发工具轮
    expect(euclidBridge!.status).toBe('completed');
    expect(euclidBridge!.subagentTokens).toBeGreaterThan(0); // 子代理轮 token 聚合
    expect(euclidBridge!.responseContent).toContain('阅读'); // 子代理最终轮内容

    // Bridge 类型通道：spawn 参数 agent_type 进派发桥（此前 agentTypeArgKeys
    // 为空 → 恒 null）
    expect(euclidBridge!.subagentType).toBe('designer');
    expect(keplerBridge!.subagentType).toBe('developer');

    // Execution 类型真值（泳道/关系图/甘特的类型分组维度）：此前 codex 从不
    // 打 subagent_type → execution-split 兜底把昵称小写冒充类型（Euclid →
    // 'euclid'，类型分组被拆成一人一组）。双源真值：子 meta agent_role
    // 优先，老版子文件无角色退父侧 spawn 参数
    const executions = await prisma.execution.findMany({ where: { sessionId: session!.id } });
    expect(executions.filter(e => e.isSubagent)).toHaveLength(2);
    const euclidExec = executions.find(e => e.subagentName === 'Euclid')!;
    const keplerExec = executions.find(e => e.subagentName === 'Kepler')!;
    expect(euclidExec.subagentType).toBe('designer');
    expect(keplerExec.subagentType).toBe('developer');
  });

  it('import-file 路由（目录路径）：UI「列表选择→导入」流程子代理不丢失', async () => {
    // 回归锁：UI 的 Load Sessions → 选择 → 导入把 sessions 根目录作为
    // filePath 传给后端。此前 readSubagents/extractVersion 直读目录静默
    // 返回空——会话导入成功但子代理轮次全丢、version 落 null。
    await prisma.session.deleteMany({ where: { taskId: MAIN } });
    createdTaskIds.push(MAIN);

    const res = await importFilePOST(req(
      { source: 'codex-jsonl', sessionId: MAIN, filePath: DATA }, // ← 目录而非文件
      '/api/ingest/import-file',
    ));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.imported).toBe(true);
    expect(data.version).toBe('0.161.0'); // extractVersion(dir, sessionId) 解析

    const session = await prisma.session.findFirst({ where: { taskId: MAIN, framework: 'codex' } });
    const turns = await prisma.turn.findMany({ where: { sessionId: session!.id } });
    expect(turns).toHaveLength(13); // 与文件路径导入完全同构
    expect(turns.filter(t => t.subagentName === 'Euclid')).toHaveLength(3);
    expect(turns.filter(t => t.subagentName === 'Kepler')).toHaveLength(3);
  });
});

describe('codex-jsonl 增量刷新（活文件追加）', () => {
  it('追加新轮后 refresh-session：framework 反向映射 → codex-jsonl → addedTurns', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-refresh-'));
    const tmpFile = path.join(tmpDir, `rollout-2026-10-09T10-23-45-${MAIN}.jsonl`);
    fs.copyFileSync(mainFile, tmpFile);
    const sid = 'codex-refresh-it';
    try {
      await prisma.session.deleteMany({ where: { taskId: sid } });
      createdTaskIds.push(sid);
      // 子文件未复制：主会话独立导入（负向场景复用——子文件丢失不阻塞导入）
      const res = await importFilePOST(req(
        { source: 'codex-jsonl', sessionId: sid, filePath: tmpFile },
        '/api/ingest/import-file',
      ));
      expect(res.status).toBe(200);
      expect((await res.json()).imported).toBe(true);

      const before = await prisma.session.findFirst({ where: { taskId: sid } });
      const turnsBefore = await prisma.turn.count({ where: { sessionId: before!.id } });
      expect(turnsBefore).toBe(7); // 无子代理：纯主会话 7 轮（注入已丢弃）

      // 活文件追加：新用户轮 + 新响应组
      const appendLines = [
        { timestamp: '2026-10-09T10:25:45.000Z', ordinal: 30, type: 'event_msg', payload: { type: 'task_started' } },
        { timestamp: '2026-10-09T10:25:45.100Z', ordinal: 31, type: 'turn_context', payload: { model: 'test-model-pro', turn_id: 'turn-2' } },
        { timestamp: '2026-10-09T10:25:45.200Z', ordinal: 32, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '追加的问题：insight 支持哪些数据源？' }] } },
        { timestamp: '2026-10-09T10:25:46.000Z', ordinal: 33, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '目前支持 opencode、claude 与 codex 三类源。' }] } },
        { timestamp: '2026-10-09T10:25:47.000Z', ordinal: 34, type: 'token_usage_record', payload: { usage: { input_tokens: 50, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 0, total_tokens: 70 } } },
      ];
      fs.appendFileSync(tmpFile, appendLines.map(l => JSON.stringify(l)).join('\n') + '\n');

      const refreshRes = await refreshPOST(req(
        { taskId: sid, framework: 'codex' }, // 同 sid 双行消歧参数
        '/api/ingest/refresh-session',
      ));
      expect(refreshRes.status).toBe(200);
      const refreshData = await refreshRes.json();
      expect(refreshData.addedTurns).toBe(2); // +1 user +1 assistant

      const turnsAfter = await prisma.turn.count({ where: { sessionId: before!.id } });
      expect(turnsAfter).toBe(9);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('codex-jsonl 负向：未知源与跨源防误判', () => {
  it('import-file 未知 source → 400 带支持清单', async () => {
    const res = await importFilePOST(req(
      { source: 'codex-json', sessionId: 'x', filePath: mainFile }, // 拼错的源名
      '/api/ingest/import-file',
    ));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/Unsupported source: "codex-json"\. Supported: .+codex-jsonl/);
  });

  it('listSessions 对无 session_meta 的 rollout 文件名不误吞（防 codex 误判 claude 件）', () => {
    // 4444 fixture：rollout- 文件名但内容是 claude 形状（无 session_meta.id）
    const sessions = listSessions(path.join(DATA, `rollout-2026-10-09T09-00-00-44444444-dddd-4b04-8f7e-abcdef000004.jsonl`));
    expect(sessions).toHaveLength(0);
  });
});
