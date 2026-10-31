// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// run 成员视图（design: docs/design/run-first-architecture/design.md §3.4，刀I1）：scorecard/bench-report
// member 闸 + 委托既有 session 处理器（逻辑零复制）。

export const maxDuration = 60;

import { memberForwardGET, memberForwardPOST } from '@/lib/observe/run-member-forward';
import { GET as sessionGET } from '@/lib/observe/session-handlers/scorecard-bench-report';
import { POST as sessionPOST } from '@/lib/observe/session-handlers/scorecard-bench-report';

export const GET = memberForwardGET('scorecard/bench-report', sessionGET);
export const POST = memberForwardPOST('scorecard/bench-report', sessionPOST);
