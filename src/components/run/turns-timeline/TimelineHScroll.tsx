"use client";
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with
// the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See the License in the root of the software repository for the full text of the License.

// 时间线横向滚动条（自绘）：吸在时间线盒子底部，不随纵向翻道滚走。
// 滚动位置的唯一来源仍是被控的道区滚动容器——这里只镜像它的 scrollLeft，
// 拖滑块 / 点轨道时写回它的 scrollLeft。原生条在纵向滚动容器里会被滚出
// 视野，所以道区隐藏原生条，由这一条常驻代替。

import { useImperativeHandle, useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent, type Ref } from "react";

export interface TimelineHScrollHandle {
  /** 按被控容器当前的 scrollLeft / scrollWidth 重摆滑块（被控容器 onScroll 里调） */
  sync: () => void;
}

/** 被控滚动容器的读写口（由持有容器的一方提供——这里不碰别人的 ref） */
export interface TimelineHScrollSource {
  /** 被控容器的 DOM id（aria-controls 指向它） */
  id: string;
  /** 当前的滚动位置、视口宽、内容宽（px） */
  read: () => { left: number; view: number; content: number };
  write: (left: number) => void;
}

export interface TimelineHScrollProps {
  source: TimelineHScrollSource;
  ref?: Ref<TimelineHScrollHandle>;
}

export function TimelineHScroll({ source, ref }: TimelineHScrollProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; left: number; trackW: number } | null>(null);

  // 不做手工 memo：每次渲染重摆一次滑块（几次样式写入，恒定开销）
  const sync = () => {
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (!track || !thumb) return;
    const { left, view, content } = source.read();
    if (content <= 0) return;
    const ratio = Math.min(1, view / content);
    thumb.style.width = `${ratio * 100}%`;
    thumb.style.transform = `translateX(${(left / content) * track.clientWidth}px)`;
    track.setAttribute("aria-valuenow", String(Math.round((left / Math.max(1, content - view)) * 100)));
  };
  useLayoutEffect(sync);
  useImperativeHandle(ref, () => ({ sync }));

  const onThumbPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const track = trackRef.current;
    const { left, content } = source.read();
    if (!track || content <= 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { x: e.clientX, left, trackW: track.clientWidth };
  };
  const onThumbPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    const { content } = source.read();
    if (!d || d.trackW <= 0) return;
    source.write(d.left + ((e.clientX - d.x) / d.trackW) * content);
  };
  const onThumbPointerUp = () => {
    dragRef.current = null;
  };
  // 点轨道：把视野中心移到落点
  const onTrackPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const track = trackRef.current;
    const { view, content } = source.read();
    if (!track || e.target !== e.currentTarget || content <= 0) return;
    const rect = track.getBoundingClientRect();
    source.write(((e.clientX - rect.left) / rect.width) * content - view / 2);
  };

  return (
    <div
      ref={trackRef}
      data-timeline-hscroll
      role="scrollbar"
      aria-label="时间轴水平滚动"
      aria-orientation="horizontal"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={0}
      aria-controls={source.id}
      className="relative h-1.5 w-full min-w-0 flex-1 cursor-pointer rounded-full bg-foreground/[0.06]"
      onPointerDown={onTrackPointerDown}
    >
      <div
        ref={thumbRef}
        data-timeline-hscroll-thumb
        className="absolute top-0 h-full cursor-grab touch-none rounded-full bg-foreground/25 transition-colors hover:bg-foreground/35 active:cursor-grabbing active:bg-foreground/45"
        style={{ width: "100%" }}
        onPointerDown={onThumbPointerDown}
        onPointerMove={onThumbPointerMove}
        onPointerUp={onThumbPointerUp}
        onPointerCancel={onThumbPointerUp}
      />
    </div>
  );
}
