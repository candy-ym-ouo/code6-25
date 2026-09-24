import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadStore, saveStore } from './store.js';

const dir = mkdtempSync(join(tmpdir(), 'store-test-'));
const corruptFiles = () => readdirSync(dir).filter(f => f.includes('.corrupt-'));
try {
  // 1. 写入-读取往返：代次递增，模拟重启后进度不丢
  const a = join(dir, 'a.json');
  let gen = 0;
  gen = saveStore(a, [{ id: 't1', stopIndex: 1 }], gen + 1);
  gen = saveStore(a, [{ id: 't1', stopIndex: 2 }], gen + 1);
  assert.equal(gen, 2);
  const reloaded = loadStore<any[]>(a, []);
  assert.equal(reloaded.source, 'primary');
  assert.equal(reloaded.generation, 2);
  assert.equal(reloaded.data[0].stopIndex, 2);
  const envelope = JSON.parse(readFileSync(a, 'utf8'));
  assert.equal(envelope.generation, 2);
  assert.ok(typeof envelope.checksum === 'string' && envelope.checksum.length === 64);

  // 2. 主文件写一半崩溃（截断）→ 从 .bak 恢复上一完整版本
  const b = join(dir, 'b.json');
  saveStore(b, [{ id: 't1', stopIndex: 1 }], 1);
  saveStore(b, [{ id: 't1', stopIndex: 2 }], 2);
  writeFileSync(b, '{"generation":2,"checksum":"abc'); // 模拟半截写入
  const recovered = loadStore<any[]>(b, []);
  assert.equal(recovered.source, 'backup');
  assert.equal(recovered.generation, 1);
  assert.equal(recovered.data[0].stopIndex, 1);
  assert.ok(!existsSync(b), '损坏主文件应被隔离');
  assert.ok(corruptFiles().some(f => f.startsWith('b.json.corrupt-')));

  // 3. 校验和被篡改（JSON 合法但内容对不上）→ 视为损坏并回退备份
  const c = join(dir, 'c.json');
  saveStore(c, [{ id: 't1', stopIndex: 1 }], 1);
  saveStore(c, [{ id: 't1', stopIndex: 2 }], 2);
  const tampered = JSON.parse(readFileSync(c, 'utf8'));
  tampered.data[0].stopIndex = 99;
  writeFileSync(c, JSON.stringify(tampered));
  const rolledBack = loadStore<any[]>(c, []);
  assert.equal(rolledBack.source, 'backup');
  assert.equal(rolledBack.data[0].stopIndex, 1);

  // 4. 主备均损坏 → 隔离现场并回退初始值，不崩溃、不静默吞掉坏文件
  const d = join(dir, 'd.json');
  saveStore(d, [{ id: 't1' }], 1);
  writeFileSync(d, 'not json at all');
  writeFileSync(`${d}.bak`, '{broken');
  const fresh = loadStore<any[]>(d, [{ id: 'fallback' }]);
  assert.equal(fresh.source, 'fresh');
  assert.equal(fresh.generation, 0);
  assert.deepEqual(fresh.data, [{ id: 'fallback' }]);
  assert.ok(corruptFiles().some(f => f.startsWith('d.json.corrupt-')));
  assert.ok(corruptFiles().some(f => f.startsWith('d.json.bak.corrupt-')));

  // 5. 旧版裸数组存档 → 兼容读取，下次写入升级为信封格式
  const e = join(dir, 'e.json');
  writeFileSync(e, JSON.stringify([{ id: 'legacy', stopIndex: 3 }]));
  const legacy = loadStore<any[]>(e, []);
  assert.equal(legacy.source, 'legacy');
  assert.equal(legacy.generation, 0);
  assert.equal(legacy.data[0].stopIndex, 3);
  saveStore(e, legacy.data, legacy.generation + 1);
  const upgraded = loadStore<any[]>(e, []);
  assert.equal(upgraded.source, 'primary');
  assert.equal(upgraded.generation, 1);
  assert.equal(upgraded.data[0].stopIndex, 3);

  console.log('store persistence tests passed');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
