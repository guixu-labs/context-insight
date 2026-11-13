// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { describe, expect, it } from 'vitest';
import {
  MAIN_AGENT_FALLBACK_NAME,
  SUBAGENT_FALLBACK_NAME,
  fallbackAgentDisplayName,
  mainAgentDisplayName,
} from '@/components/observe/agent-display-name';

describe('agent display names', () => {
  it('main agent prefers member label, then agent name, then canonical fallback', () => {
    expect(mainAgentDisplayName({ memberLabel: 'build·g0', agentName: 'main' })).toBe('build·g0');
    expect(mainAgentDisplayName({ agentName: 'main' })).toBe('main');
    expect(mainAgentDisplayName({ agentName: '  ' })).toBe(MAIN_AGENT_FALLBACK_NAME);
  });

  it('fallback distinguishes main and subagent identities', () => {
    expect(fallbackAgentDisplayName({ isSubagent: false, agentName: null })).toBe(MAIN_AGENT_FALLBACK_NAME);
    expect(fallbackAgentDisplayName({ isSubagent: true, agentName: null })).toBe(SUBAGENT_FALLBACK_NAME);
    expect(fallbackAgentDisplayName({ isSubagent: true, agentName: 'reviewer' })).toBe('reviewer');
  });
});
