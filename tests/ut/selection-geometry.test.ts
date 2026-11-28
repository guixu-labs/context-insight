// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of CANN Open Software License Agreement Version 2.0.
// You may refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See the License in the root of the software repository for the full text of the License.

import { describe, expect, it } from 'vitest';
import {
  BEAM_FEATHER_PX,
  SELECTION_BAR_PX,
  PILL_W,
  SELECTION_LIFT,
  beamOf,
  glowOf,
  tintOf,
} from '@/components/run/turns-timeline/selection-geometry';

describe('selection-geometry — Turns 时间线选中层的几何与配色', () => {
  it('柔光 / 柔影取条子本色的淡化色：整个选中态只有一个色系', () => {
    expect(tintOf('#3b82f6')).toBe('color-mix(in oklab, #3b82f6 21%, transparent)');
    expect(glowOf('#3b82f6')).toBe('color-mix(in oklab, #3b82f6 45%, transparent)');
  });

  it('柔光包着选中条：实心核 = 选中条范围，两侧各渐隐 8px——两者必然重合', () => {
    const tint = tintOf('#3b82f6');
    const beam = beamOf({ color: '#3b82f6', x: 500, w: 250 });
    expect(beam.x).toBe(500 - BEAM_FEATHER_PX / 2);
    expect(beam.w).toBe(250 + BEAM_FEATHER_PX);
    expect(beam.background).toBe(
      `linear-gradient(90deg, transparent 0, ${tint} 8px, ${tint} calc(100% - 8px), transparent 100%)`,
    );
    // 实心核的左右缘 = 选中条的左右缘
    expect(beam.x + BEAM_FEATHER_PX / 2).toBe(500);
    expect(beam.x + beam.w - BEAM_FEATHER_PX / 2).toBe(750);
  });

  it('选中条是恒定宽度的细条：长短轮、零宽轮都是 4px，居中于起点两侧', () => {
    const beam = beamOf({ color: 'red', x: 991.67, w: SELECTION_BAR_PX });
    expect(SELECTION_BAR_PX).toBe(4);
    expect(beam.x).toBeCloseTo(991.67 - 8, 6);
    expect(beam.w).toBe(SELECTION_BAR_PX + BEAM_FEATHER_PX);
    expect(beam.x + beam.w / 2).toBeCloseTo(991.67 + SELECTION_BAR_PX / 2, 6);
  });

  it('尺寸常量彼此自洽：渐隐为偶数（两侧各半），胶囊装得下 HH:MM:SS', () => {
    expect(BEAM_FEATHER_PX % 2).toBe(0);
    expect(PILL_W).toBeGreaterThan(8 * 6);
    expect(SELECTION_LIFT).toBe(1);
  });
});
