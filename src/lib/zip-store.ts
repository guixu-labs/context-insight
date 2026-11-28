// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Zip 写入器（纯 JS，零依赖）。两个入口共用同一套本地头 / 中央目录 / 尾记录编码：
//   writeZip(sources, out)  流式：条目逐个边读边写，整包不进内存——会话归档
//                           （原文件动辄数百 MB，run 归档可过 4GB）走这里
//   buildZip(entries)       内存：{ path, data } 条目 → Blob——Files 页「下载全部
//                           文件」走这里（条目已在手上，一律 STORE）
// 编码口径：
//   - 流式条目已压缩形态（.7z/.gz/.zip …）STORE 原样入包（再压没有收益），其余 DEFLATE
//   - 文件源读完才知道 CRC 与大小 → 数据描述符（通用位 3）
//   - zip64：条目解压大小将越过 4GB、中央目录偏移越过 4GB、条目数越过 65535 时按
//     APPNOTE 写 zip64 扩展字段与 zip64 尾记录（与 Python zipfile 的 force_zip64 /
//     Info-ZIP 同构：本地头大小填 0xFFFFFFFF + zip64 扩展占位 0，描述符给 64 位大小）
//   - 文件名一律 UTF-8（通用位 11）；时间取条目 mtime 的本地时间

import stream from "node:stream";
import zlib from "node:zlib";

export interface ZipEntry {
  path: string;
  data: Uint8Array;
}

export type ZipMethod = "store" | "deflate";

/** 内存条目（手上的一整块）：大小与 CRC 事先可算 → 直接写进本地头，不带数据
 *  描述符；一律 STORE、时间固定——输出确定，不随导出时刻变。Files 页走这里。 */
export interface ZipBytesSource {
  kind: 'bytes';
  /** zip 内相对路径（会经 normalizeZipPath 归一） */
  path: string;
  data: Uint8Array;
}

/** 流式条目（磁盘上的一个大文件）：读完才知道 CRC 与大小 → 数据描述符。 */
export interface ZipStreamSource {
  kind: 'stream';
  /** zip 内相对路径（会经 normalizeZipPath 归一） */
  path: string;
  /** 解压前大小（zip64 判定用；入包大小以实际读到的为准） */
  size: number;
  method: ZipMethod;
  mtime?: Date;
  open(): stream.Readable;
}

export type ZipSource = ZipBytesSource | ZipStreamSource;

export interface ZipWriteResult {
  /** 整包字节数 */
  bytes: number;
  entries: number;
}

const CRC_TABLE = new Uint32Array((() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})());

export function crc32(bytes: Uint8Array): number {
  return crc32Update(0, bytes);
}

/** 增量 CRC32：流式入包时逐块累计，初值 0。 */
export function crc32Update(crc: number, bytes: Uint8Array): number {
  let c = (~crc) >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    c = (c >>> 8) ^ CRC_TABLE[(c ^ bytes[i]) & 0xff];
  }
  return (c ^ 0xffffffff) >>> 0;
}

export function normalizeZipPath(path: string): string {
  let p = path.replace(/\\/g, "/");
  while (p.startsWith("/")) p = p.slice(1);
  // zip entries must be relative; drop any drive prefix like "C:/"
  if (/^[a-zA-Z]:\//.test(p)) p = p.slice(p.indexOf("/") + 1);
  return p;
}

/** 已压缩形态原样入包（STORE）：再压一遍没有收益，还白耗 CPU。 */
const STORE_EXT_RE = /\.(7z|gz|zip|xz|bz2|zst|zstd)$/i;

export function zipMethodFor(path: string): ZipMethod {
  return STORE_EXT_RE.test(path) ? "store" : "deflate";
}

function u16(n: number): Buffer {
  return Buffer.from([n & 0xff, (n >>> 8) & 0xff]);
}

function u32(n: number): Buffer {
  const v = n >>> 0;
  return Buffer.from([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
}

/** 0 到 2^53-1 的整数写成小端 64 位（JS 安全整数范围内够用）。 */
function u64(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeUInt32LE(n % 4294967296, 0);
  b.writeUInt32LE(Math.floor(n / 4294967296), 4);
  return b;
}

const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
/** 解压大小离 4GB 不到这个量就按 zip64 写：deflate 最坏情况会略微膨胀，不能等越过才判 */
const ZIP64_MARGIN = 1 << 20;

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_DESCRIPTOR = 0x08074b50;
const SIG_EOCD = 0x06054b50;
const SIG_Z64_EOCD = 0x06064b50;
const SIG_Z64_LOCATOR = 0x07064b50;

const FLAG_UTF8 = 0x0800;
const FLAG_DESCRIPTOR = 0x0008;

const VERSION_STORE = 10;
const VERSION_DEFLATE = 20;
const VERSION_ZIP64 = 45;
/** version made by：高字节 3 = Unix（外部属性为 0 时无实义，取通用值） */
const MADE_BY_UNIX = 3 << 8;

const EMPTY: Buffer = Buffer.alloc(0);

/** 内存条目的固定时间：2026-01-01（输出确定，不随导出时刻变）。 */
const FIXED_MTIME = new Date(2026, 0, 1);

/** DOS 时间字段的最小年份是 1980；更早的 mtime 抬到 1980-01-01。 */
function dosDateTime(mtime: Date): { time: number; date: number } {
  const d = mtime;
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

interface Pausable {
  pause(): unknown;
  resume(): unknown;
}

/** 有序异步汇：write 同步交给下游 Writable（调用顺序即字节顺序）。下游缓冲满时
 *  返回的 Promise 在 drain 后落定，返回 null 表示无需等待。下游出错后每次 write
 *  都拒绝——错误不会被静默吞掉。 */
class Sink {
  private failure: unknown = null;

  constructor(private readonly out: stream.Writable) {
    out.on("error", (e: unknown) => {
      this.failure = e;
    });
  }

  write(buf: Buffer): Promise<void> | null {
    if (this.failure !== null) return Promise.reject(this.failure);
    if (this.out.write(buf)) return null;
    return new Promise<void>((resolve, reject) => {
      const onDrain = () => {
        cleanup();
        resolve();
      };
      const onError = (e: unknown) => {
        cleanup();
        reject(e);
      };
      const cleanup = () => {
        this.out.off("drain", onDrain);
        this.out.off("error", onError);
      };
      this.out.once("drain", onDrain);
      this.out.once("error", onError);
    });
  }

  /** 交一块字节并遵守背压。 */
  async put(buf: Buffer): Promise<void> {
    const wait = this.write(buf);
    if (wait) await wait;
  }
}

/** 把一个可读源（可经 deflate）顺序推进 Sink：onRaw 收原始块（CRC / 解压大小
 *  累计），onOut 收交给下游的块（压缩后大小累计）。下游背压时暂停源，drain 后
 *  续读；源读尽且最后一块被下游接走后才落定。 */
function pump(
  src: stream.Readable,
  transform: zlib.DeflateRaw | null,
  sink: Sink,
  onRaw: (chunk: Buffer) => void,
  onOut: (chunk: Buffer) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const pusher: stream.Readable = transform ?? src;
    const throttle: Pausable = transform ?? src;
    let lastWait: Promise<void> | null = null;
    const fail = (e: unknown) => {
      reject(e);
    };
    src.once("error", fail);
    pusher.once("error", fail);
    pusher.once("end", () => {
      if (lastWait) lastWait.then(() => resolve(), fail);
      else resolve();
    });
    const emit = (chunk: Buffer) => {
      onOut(chunk);
      const wait = sink.write(chunk);
      if (wait) {
        lastWait = wait;
        throttle.pause();
        wait.then(() => throttle.resume(), fail);
      }
    };
    if (transform) {
      // 原始块在源上旁听（pipe 照常把块交给 deflate）：CRC 与解压大小按原始字节算
      src.on("data", onRaw);
      transform.on("data", emit);
      src.pipe(transform);
    } else {
      src.on("data", (chunk: Buffer) => {
        onRaw(chunk);
        emit(chunk);
      });
      src.resume();
    }
  });
}

interface CentralRecord {
  name: Buffer;
  method: number;
  flags: number;
  time: number;
  date: number;
  crc: number;
  csize: number;
  usize: number;
  localOffset: number;
  versionNeeded: number;
}

/** 流式写一个 zip 到 out。不调用 out.end()——调用方决定何时收尾。 */
export async function writeZip(sources: ZipSource[], out: stream.Writable): Promise<ZipWriteResult> {
  const sink = new Sink(out);
  const central: CentralRecord[] = [];
  let offset = 0;

  for (const source of sources) {
    const name = Buffer.from(normalizeZipPath(source.path), "utf8");
    if (name.length === 0) throw new Error("zip entry path must not be empty");
    const localOffset = offset;

    if (source.kind === "bytes") {
      // 大小与 CRC 事先已知：全写进本地头，不带描述符
      const { time, date } = dosDateTime(FIXED_MTIME);
      const data = Buffer.from(source.data.buffer, source.data.byteOffset, source.data.byteLength);
      const crc = crc32(data);
      const header = Buffer.concat([
        u32(SIG_LOCAL),
        u16(VERSION_STORE),
        u16(FLAG_UTF8),
        u16(0),
        u16(time),
        u16(date),
        u32(crc),
        u32(data.length),
        u32(data.length),
        u16(name.length),
        u16(0),
        name,
      ]);
      await sink.put(header);
      if (data.length > 0) await sink.put(data);
      offset += header.length + data.length;
      central.push({ name, method: 0, flags: FLAG_UTF8, time, date, crc, csize: data.length, usize: data.length, localOffset, versionNeeded: VERSION_STORE });
      continue;
    }

    const method = source.method === "store" ? 0 : 8;
    const { time, date } = dosDateTime(source.mtime ?? new Date());
    const z64 = source.size >= MAX32 - ZIP64_MARGIN || localOffset >= MAX32;
    const versionNeeded = z64 ? VERSION_ZIP64 : VERSION_DEFLATE;
    // zip64 + 数据描述符：本地头两个大小填 0xFFFFFFFF，zip64 扩展里先占 0（真值在描述符）
    const localExtra = z64 ? Buffer.concat([u16(0x0001), u16(16), u64(0), u64(0)]) : EMPTY;
    const localHeader = Buffer.concat([
      u32(SIG_LOCAL),
      u16(versionNeeded),
      u16(FLAG_UTF8 | FLAG_DESCRIPTOR),
      u16(method),
      u16(time),
      u16(date),
      u32(0),
      u32(z64 ? MAX32 : 0),
      u32(z64 ? MAX32 : 0),
      u16(name.length),
      u16(localExtra.length),
      name,
      localExtra,
    ]);
    await sink.put(localHeader);
    offset += localHeader.length;

    let crc = 0;
    let usize = 0;
    let csize = 0;
    await pump(
      source.open(),
      method === 8 ? zlib.createDeflateRaw({ level: 6 }) : null,
      sink,
      (chunk) => {
        crc = crc32Update(crc, chunk);
        usize += chunk.length;
      },
      (chunk) => {
        csize += chunk.length;
      },
    );
    offset += csize;

    const descriptor = z64
      ? Buffer.concat([u32(SIG_DESCRIPTOR), u32(crc), u64(csize), u64(usize)])
      : Buffer.concat([u32(SIG_DESCRIPTOR), u32(crc), u32(csize), u32(usize)]);
    await sink.put(descriptor);
    offset += descriptor.length;

    central.push({ name, method, flags: FLAG_UTF8 | FLAG_DESCRIPTOR, time, date, crc, csize, usize, localOffset, versionNeeded });
  }

  const centralOffset = offset;
  for (const record of central) {
    // 只有真越界的字段才进 zip64 扩展（APPNOTE 4.5.3：顺序 = 原始大小、压缩后大小、本地头偏移）
    const sizeOverflow = record.usize >= MAX32;
    const csizeOverflow = record.csize >= MAX32;
    const offsetOverflow = record.localOffset >= MAX32;
    const z64Fields: Buffer[] = [];
    if (sizeOverflow) z64Fields.push(u64(record.usize));
    if (csizeOverflow) z64Fields.push(u64(record.csize));
    if (offsetOverflow) z64Fields.push(u64(record.localOffset));
    const extra = z64Fields.length
      ? Buffer.concat([u16(0x0001), u16(z64Fields.reduce((sum, b) => sum + b.length, 0)), ...z64Fields])
      : EMPTY;
    const entry = Buffer.concat([
      u32(SIG_CENTRAL),
      u16(MADE_BY_UNIX | record.versionNeeded),
      u16(record.versionNeeded),
      u16(record.flags),
      u16(record.method),
      u16(record.time),
      u16(record.date),
      u32(record.crc),
      u32(csizeOverflow ? MAX32 : record.csize),
      u32(sizeOverflow ? MAX32 : record.usize),
      u16(record.name.length),
      u16(extra.length),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offsetOverflow ? MAX32 : record.localOffset),
      record.name,
      extra,
    ]);
    await sink.put(entry);
    offset += entry.length;
  }
  const centralSize = offset - centralOffset;
  const count = central.length;

  if (count >= MAX16 || centralOffset >= MAX32 || centralSize >= MAX32 || central.some(r => r.versionNeeded === VERSION_ZIP64)) {
    const recordOffset = offset;
    const record = Buffer.concat([
      u32(SIG_Z64_EOCD),
      u64(44),
      u16(MADE_BY_UNIX | VERSION_ZIP64),
      u16(VERSION_ZIP64),
      u32(0),
      u32(0),
      u64(count),
      u64(count),
      u64(centralSize),
      u64(centralOffset),
    ]);
    await sink.put(record);
    const locator = Buffer.concat([u32(SIG_Z64_LOCATOR), u32(0), u64(recordOffset), u32(1)]);
    await sink.put(locator);
    offset += record.length + locator.length;
  }

  const eocd = Buffer.concat([
    u32(SIG_EOCD),
    u16(0),
    u16(0),
    u16(Math.min(count, MAX16)),
    u16(Math.min(count, MAX16)),
    u32(Math.min(centralSize, MAX32)),
    u32(Math.min(centralOffset, MAX32)),
    u16(0),
  ]);
  await sink.put(eocd);
  offset += eocd.length;

  return { bytes: offset, entries: count };
}

export async function buildZip(entries: ZipEntry[]): Promise<Blob> {
  const sources: ZipBytesSource[] = entries.map((entry) => ({ kind: "bytes", path: entry.path, data: entry.data }));
  const parts: Buffer[] = [];
  const collect = new stream.Writable({
    write(chunk: Buffer, _encoding, done) {
      parts.push(chunk);
      done();
    },
  });
  await writeZip(sources, collect);
  return new Blob(parts as BlobPart[], { type: "application/zip" });
}
