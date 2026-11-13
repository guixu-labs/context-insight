// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

export const MAIN_AGENT_FALLBACK_NAME = "Main Agent";
export const SUBAGENT_FALLBACK_NAME = "Subagent";

export function mainAgentDisplayName(input: {
  memberLabel?: string | null;
  agentName?: string | null;
}): string {
  const memberLabel = input.memberLabel?.trim();
  if (memberLabel) return memberLabel;
  const agentName = input.agentName?.trim();
  return agentName || MAIN_AGENT_FALLBACK_NAME;
}

export function fallbackAgentDisplayName(input: {
  isSubagent: boolean;
  memberLabel?: string | null;
  agentName?: string | null;
}): string {
  if (!input.isSubagent) return mainAgentDisplayName(input);
  const agentName = input.agentName?.trim();
  return agentName || SUBAGENT_FALLBACK_NAME;
}
