// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// run 成员视图（design: docs/design/run-first-architecture/design.md §3.4，刀I1）：mate-agent
// member 闸 + 委托既有 session 处理器（逻辑零复制）。

import { memberForwardGET, memberForwardPOST } from '@/lib/observe/run-member-forward';
import { GET as sessionGET } from '@/lib/observe/session-handlers/mate-agent';
import { POST as sessionPOST } from '@/lib/observe/session-handlers/mate-agent';

export const GET = memberForwardGET('mate-agent', sessionGET);
export const POST = memberForwardPOST('mate-agent', sessionPOST);
