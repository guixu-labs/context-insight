// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { crc32, crc32Update, normalizeZipPath, buildZip, writeZip, zipMethodFor, type ZipEntry, type ZipSource } from '../../src/lib/zip-store.ts';
import { sevenZipBin } from '@/lib/seven-zip-bin';

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function findBytes(haystack: Uint8Array, needle: number[]): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

const PK_LOCAL = [0x50, 0x4b, 0x03, 0x04];
const PK_CENTRAL = [0x50, 0x4b, 0x01, 0x02];
const PK_END = [0x50, 0x4b, 0x05, 0x06];

describe('zip-store', () => {
  describe('crc32', () => {
    it('known vector: crc32("123456789") == 0xCBF43926', () => {
      expect(crc32(bytes('123456789'))).toBe(0xCBF43926);
    });
    it('crc32 of empty is 0', () => {
      expect(crc32(new Uint8Array(0))).toBe(0);
    });
  });

  describe('normalizeZipPath', () => {
    it('strips leading slashes', () => {
      expect(normalizeZipPath('/a/b/c.ts')).toBe('a/b/c.ts');
    });
    it('converts backslashes', () => {
      expect(normalizeZipPath('C:\\Users\\me\\foo.ts')).toBe('Users/me/foo.ts');
    });
    it('strips drive prefix when followed by slash', () => {
      expect(normalizeZipPath('C:/Users/me/foo.ts')).toBe('Users/me/foo.ts');
    });
  });

  describe('buildZip', () => {
    it('produces valid zip signatures and structure', async () => {
      const entries: ZipEntry[] = [
        { path: 'docs/a.md', data: bytes('# A\nhello') },
        { path: 'docs/b.md', data: bytes('# B\nworld') },
      ];
      const blob = await buildZip(entries);
      expect(blob.type).toBe('application/zip');
      const ab = await blob.arrayBuffer();
      const arr = new Uint8Array(ab);

      // local file header at start
      expect(findBytes(arr, PK_LOCAL)).toBe(0);
      // central directory header present
      const cd = findBytes(arr, PK_CENTRAL);
      expect(cd).toBeGreaterThan(0);
      // end of central directory present
      const eocd = findBytes(arr, PK_END);
      expect(eocd).toBeGreaterThan(cd);

      // file paths appear
      expect(findBytes(arr, [...bytes('docs/a.md')])).toBeGreaterThan(0);
      expect(findBytes(arr, [...bytes('# A')])).toBeGreaterThan(0);
    });

    it('writes correct CRC for each entry in the local header', async () => {
      const data = bytes('hello zip\n');
      const blob = await buildZip([{ path: 'x.txt', data }]);
      const arr = new Uint8Array(await blob.arrayBuffer());
      // local header layout: sig(4) ver(2) flags(2) method(2) time(2) date(2) crc(4) ...
      // crc is at offset 14..18
      const dv = new DataView(arr.buffer, arr.byteOffset + 14, 4);
      expect(dv.getUint32(0, true)).toBe(crc32(data));
    });

    it('sets UTF-8 flag (bit 11) in local + central headers for Windows Explorer compatibility', async () => {
      const blob = await buildZip([{ path: 'docs/状态.md', data: bytes('x') }]);
      const arr = new Uint8Array(await blob.arrayBuffer());
      const localFlags = new DataView(arr.buffer, arr.byteOffset + 6, 2).getUint16(0, true);
      expect(localFlags & 0x0800).toBe(0x0800);
      const cd = findBytes(arr, PK_CENTRAL);
      const cdFlags = new DataView(arr.buffer, arr.byteOffset + cd + 8, 2).getUint16(0, true);
      expect(cdFlags & 0x0800).toBe(0x0800);
    });

    it('encodes a valid DOS date (2026-01-01) decodeable by zipfile', async () => {
      const blob = await buildZip([{ path: 'a.txt', data: bytes('1') }]);
      const arr = new Uint8Array(await blob.arrayBuffer());
      const date = new DataView(arr.buffer, arr.byteOffset + 12, 2).getUint16(0, true);
      expect(date).toBe(0x5c21);
    });

    it('end-of-central-directory records the entry count', async () => {
      const blob = await buildZip([
        { path: 'a.txt', data: bytes('1') },
        { path: 'b.txt', data: bytes('2') },
        { path: 'c.txt', data: bytes('3') },
      ]);
      const arr = new Uint8Array(await blob.arrayBuffer());
      const eocd = findBytes(arr, PK_END);
      const dv = new DataView(arr.buffer, arr.byteOffset + eocd + 10, 2);
      expect(dv.getUint16(0, true)).toBe(3);
    });

    it('handles empty entry list (valid empty zip)', async () => {
      const blob = await buildZip([]);
      const arr = new Uint8Array(await blob.arrayBuffer());
      expect(findBytes(arr, PK_END)).toBeGreaterThan(-1);
    });
  });
});

// ── 流式写入（会话归档走这里）─────────────────────────────────────
// 校验一律用 7za 独立解包 + 逐字节比对，不信任写入器自己的任何读回逻辑。

const SIG = {
  local: 0x04034b50,
  central: 0x02014b50,
  eocd: 0x06054b50,
  z64Eocd: 0x06064b50,
  z64Locator: 0x07064b50,
};

function u32At(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
}

function u16At(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 2).getUint16(0, true);
}

function countSignature(bytes: Uint8Array, sig: number): number {
  let n = 0;
  for (let i = 0; i + 4 <= bytes.length; i++) {
    if (bytes[i] === (sig & 0xff) && bytes[i + 1] === ((sig >>> 8) & 0xff) && bytes[i + 2] === ((sig >>> 16) & 0xff) && bytes[i + 3] === ((sig >>> 24) & 0xff)) n++;
  }
  return n;
}

/** 用 7za 解包并返回 { 相对路径 → 字节 } */
function extractWith7za(zip: string): Map<string, Buffer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-store-7za-'));
  const r = spawnSync(sevenZipBin(), ['x', '-y', `-o${dir}`, zip], { stdio: ['ignore', 'pipe', 'pipe'] });
  // 拉不起来时 status / stderr 都是空，原因只在 error 里
  expect(r.status, r.error?.message ?? r.stderr?.toString()).toBe(0);
  const out = new Map<string, Buffer>();
  const walk = (at: string, rel: string) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const child = path.posix.join(rel, entry.name);
      if (entry.isDirectory()) walk(path.join(at, entry.name), child);
      else out.set(child, fs.readFileSync(path.join(at, entry.name)));
    }
  };
  walk(dir, '');
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

async function writeToFile(sources: ZipSource[]): Promise<string> {
  const zip = path.join(os.tmpdir(), `zip-store-${process.pid}-${Math.random().toString(36).slice(2, 8)}.zip`);
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(zip);
    out.on('error', reject);
    writeZip(sources, out).then(
      () => out.end(() => resolve()),
      error => { out.destroy(); reject(error); },
    );
  });
  return zip;
}

const bytesSource = (zipPath: string, data: Uint8Array): ZipSource => ({ kind: 'bytes', path: zipPath, data });
const text = (s: string) => new TextEncoder().encode(s);

describe('zip-store · writeZip（流式）', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-store-src-'));
  const produced: string[] = [];
  afterAll(() => {
    for (const zip of produced) fs.rmSync(zip, { force: true });
    fs.rmSync(work, { recursive: true, force: true });
  });

  it('zipMethodFor：已压缩形态 STORE，其余 DEFLATE', () => {
    expect(zipMethodFor('sessions/s/a.jsonl.7z')).toBe('store');
    expect(zipMethodFor('sessions/s/a.jsonl.gz')).toBe('store');
    expect(zipMethodFor('sessions/s/a.db.7z')).toBe('store');
    expect(zipMethodFor('sessions/s/a.jsonl')).toBe('deflate');
    expect(zipMethodFor('sessions/s/a.meta.json')).toBe('deflate');
  });

  it('crc32Update 分块累计 = 整块 crc32（流式 CRC 的正确性前提）', () => {
    const data = text('会话内容 hello world '.repeat(4000));
    expect(crc32Update(crc32Update(crc32Update(0, data.subarray(0, 9999)), data.subarray(9999, 30000)), data.subarray(30000))).toBe(crc32(data));
  });

  it('文件源流式入包（明文 DEFLATE、.7z 原样 STORE、空文件、内存条目混排）：7za 解包逐字节一致', async () => {
    const big = Buffer.alloc(5 * 1024 * 1024 + 37);
    for (let i = 0; i < big.length; i += 4096) big.write('line of session text\n'.repeat(30), i);
    const files: Array<[string, Buffer]> = [
      ['plain.jsonl', big],
      ['arch.jsonl.7z', Buffer.from('7z-bytes-as-is\x00\x01\x02')],
      ['empty.meta.json', Buffer.alloc(0)],
      ['blob.bin', Buffer.from(Array.from({ length: 70000 }, (_, i) => (i * 2654435761) >>> 24))],
    ];
    const sources: ZipSource[] = files.map(([name, data]) => {
      const file = path.join(work, name);
      fs.writeFileSync(file, data);
      return {
        kind: 'stream' as const,
        path: `sessions/ses_a/${name}`,
        size: data.length,
        method: zipMethodFor(name),
        mtime: new Date(2024, 4, 6, 7, 8, 9),
        open: () => fs.createReadStream(file, { highWaterMark: 64 * 1024 }),
      };
    });
    sources.push(bytesSource('export-manifest.json', text('{"format":"session-archive"}\n')));
    sources.push(bytesSource('/lead/slash.txt', new Uint8Array([1, 2, 3])));

    const zip = await writeToFile(sources);
    produced.push(zip);
    const out = extractWith7za(zip);
    expect([...out.keys()].sort()).toEqual([
      'export-manifest.json', 'lead/slash.txt',
      ...files.map(([name]) => `sessions/ses_a/${name}`),
    ].sort());
    for (const [name, data] of files) {
      expect(out.get(`sessions/ses_a/${name}`)!.equals(data)).toBe(true);
    }
    expect(out.get('export-manifest.json')!.equals(Buffer.from(text('{"format":"session-archive"}\n')))).toBe(true);

    // 结构：数据描述符只属于流式条目；内存条目 CRC 在本地头；条目数进尾记录
    const bytes = new Uint8Array(fs.readFileSync(zip));
    expect(countSignature(bytes, SIG.local)).toBe(6);
    expect(countSignature(bytes, SIG.central)).toBe(6);
    expect(countSignature(bytes, SIG.eocd)).toBe(1);
    expect(u16At(bytes, bytes.length - 22 + 10)).toBe(6);
    expect(countSignature(bytes, SIG.z64Eocd)).toBe(0);
    // 内存条目（export-manifest.json）的本地头：CRC 与大小事先已知 → 写在头里、无描述符位
    const manifestName = findBytes(bytes, [...text('export-manifest.json')]);
    const manifestHeader = manifestName - 30;
    expect(u32At(bytes, manifestHeader)).toBe(SIG.local);
    expect(u32At(bytes, manifestHeader + 14)).toBe(crc32(text('{"format":"session-archive"}\n')));
    expect(u32At(bytes, manifestHeader + 18)).toBe(29);
    expect(u16At(bytes, manifestHeader + 6) & 0x0008).toBe(0);
    // 流式条目（首条 plain.jsonl）的本地头：CRC / 大小在数据描述符里，头里为 0
    expect(u32At(bytes, 14)).toBe(0);
    expect(u16At(bytes, 6) & 0x0008).toBe(0x0008);
  });

  it('声明大小将越过 4GB → zip64：本地头 45 版 + 0xFFFFFFFF + 扩展字段、64 位描述符、zip64 尾记录 + 定位器；7za 照常解出', async () => {
    // 声明 4GiB（zip64 判定看声明大小），实际只给少量字节——廉价走到 64 位编码全路径
    const file = path.join(work, 'declared-big.jsonl');
    fs.writeFileSync(file, 'small payload actually');
    const sources: ZipSource[] = [{
      kind: 'stream',
      path: 'sessions/ses_big/big.jsonl',
      size: 4 * 1024 * 1024 * 1024 + 5,
      method: 'deflate',
      open: () => fs.createReadStream(file),
    }];
    const zip = await writeToFile(sources);
    produced.push(zip);
    expect(extractWith7za(zip).get('sessions/ses_big/big.jsonl')!.toString()).toBe('small payload actually');

    const bytes = new Uint8Array(fs.readFileSync(zip));
    expect(u16At(bytes, 4)).toBe(45);
    expect(u16At(bytes, 6) & 0x0008).toBe(0x0008);
    expect(u32At(bytes, 18)).toBe(0xffffffff);
    expect(u32At(bytes, 22)).toBe(0xffffffff);
    // 本地头扩展字段 = zip64（id 0x0001，16 字节，两个 64 位 0）
    const nameLen = u16At(bytes, 26);
    const extraAt = 30 + nameLen;
    expect(u16At(bytes, extraAt)).toBe(0x0001);
    expect(u16At(bytes, extraAt + 2)).toBe(16);
    // 中央目录条目：真值在 32 位放得下 → 不进 zip64 扩展；字段序 = 压缩后大小在前、
    // 解压大小在后（APPNOTE；写反时 STORE 条目两者相等查不出来，DEFLATE 条目才露馅）
    const central = findBytes(bytes, [...new Uint8Array([0x50, 0x4b, 0x01, 0x02])]);
    expect(u16At(bytes, central + 6)).toBe(45);
    const plain = 'small payload actually';
    expect(u32At(bytes, central + 20)).toBeGreaterThan(plain.length);
    expect(u32At(bytes, central + 24)).toBe(plain.length);
    // zip64 尾记录 + 定位器各一，经典尾记录仍在最后
    expect(countSignature(bytes, SIG.z64Eocd)).toBe(1);
    expect(countSignature(bytes, SIG.z64Locator)).toBe(1);
    expect(u32At(bytes, bytes.length - 22)).toBe(SIG.eocd);
  });

  it('条目路径为空 → 拒绝（不写出半截包）', async () => {
    await expect(writeZip([{ kind: 'bytes', path: '/', data: text('x') }], new (await import('node:stream')).Writable({
      write(_c, _e, cb) { cb(); },
    }))).rejects.toThrow('zip entry path must not be empty');
  });
});
