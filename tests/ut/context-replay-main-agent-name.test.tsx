// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ContextReplayDialog } from '@/components/observe/ContextReplayDialog';
import type { TurnRowItem } from '@/components/observe/ContextTracker';

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('Context Replay main agent naming', () => {
  it('root turn without agentName uses the canonical Main Agent display name', async () => {
    const turn = {
      turnId: 'turn-root-0', turnIndex: 0, role: 'assistant', contentSummary: 'root response',
      agentName: null, isSubagent: false, subagentName: null, subagentSessionId: null,
      parentExecutionId: null, totalTokens: 2, inputTokens: 2, outputTokens: 0,
      reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, inputMessagesTokens: 2,
      contextWindowPct: 5.6, latencyMs: 100, createdAt: '2026-11-11T02:45:57.000Z',
      completedAt: null, model: 'claude-opus-5',
    } as unknown as TurnRowItem;

    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(createElement(ContextReplayDialog, {
        open: true,
        onOpenChange: () => {},
        turns: [turn],
        contextWindowLimit: 1_000_000,
      }));
    });

    expect(document.body.textContent).toContain('Main Agent: 2 input');
  });
});
