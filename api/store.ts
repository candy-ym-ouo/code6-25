import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

/**
 * 存档信封：每次写入携带持久化代次(generation)与校验和(checksum)。
 * 写入前先旋转上一完整版本到 <file>.bak，主文件损坏或校验失败时自动从备份恢复；
 * 主备均不可用时隔离为 *.corrupt-<ts> 保留现场，绝不静默丢弃。
 */
export type Envelope<T> = { generation: number; checksum: string; savedAt: string; data: T };

export type LoadedStore<T> = { data: T; generation: number; source: 'primary' | 'backup' | 'legacy' | 'fresh' };

const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const payloadOf = <T>(generation: number, data: T) => JSON.stringify({ generation, data });

/** tmp 写入 + fsync + 同分区 rename：崩溃不会留下半截主文件 */
function writeAtomic(file: string, contents: string): void {
  const tmp = `${file}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeFileSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

function quarantine(file: string): void {
  try {
    renameSync(file, `${file}.corrupt-${Date.now()}`);
  } catch {
    // 隔离失败不阻断启动
  }
}

/** 解析并校验信封；旧版裸数组存档视为第 0 代，下次写入自动升级为信封格式 */
function parseEnvelope<T>(file: string): { envelope: Envelope<T>; legacy: boolean } | null {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return { envelope: { generation: 0, checksum: '', savedAt: '', data: parsed as T }, legacy: true };
    }
    if (!parsed || typeof parsed !== 'object') return null;
    const { generation, checksum, data } = parsed as Envelope<T>;
    if (!Number.isInteger(generation) || generation < 0 || typeof checksum !== 'string') return null;
    if (digest(payloadOf(generation, data)) !== checksum) return null; // 校验失败：视为损坏
    return { envelope: parsed as Envelope<T>, legacy: false };
  } catch {
    return null;
  }
}

export function loadStore<T>(file: string, fallback: T): LoadedStore<T> {
  const backup = `${file}.bak`;
  const valid: { envelope: Envelope<T>; source: 'primary' | 'backup' | 'legacy' }[] = [];
  for (const [path, source] of [[file, 'primary'], [backup, 'backup']] as const) {
    if (!existsSync(path)) continue;
    const parsed = parseEnvelope<T>(path);
    if (parsed) {
      valid.push({ envelope: parsed.envelope, source: parsed.legacy ? 'legacy' : source });
    } else {
      console.warn(`[store] ${path} 损坏或校验失败，已隔离并尝试从上一完整版本恢复`);
      quarantine(path);
    }
  }
  if (valid.length === 0) return { data: fallback, generation: 0, source: 'fresh' };
  // 主备同时有效时取代次更高者，保证不回滚到旧进度
  valid.sort((a, b) => b.envelope.generation - a.envelope.generation);
  const best = valid[0];
  if (best.source === 'backup') {
    console.warn(`[store] 主存档不可用，已从 ${backup} 恢复第 ${best.envelope.generation} 代存档`);
  }
  return { data: best.envelope.data, generation: best.envelope.generation, source: best.source };
}

/** 同步落盘：先保留上一完整版本为 .bak，再原子替换主文件。返回已持久化的代次。 */
export function saveStore<T>(file: string, data: T, generation: number): number {
  const envelope: Envelope<T> = {
    generation,
    checksum: digest(payloadOf(generation, data)),
    savedAt: new Date().toISOString(),
    data,
  };
  if (existsSync(file)) copyFileSync(file, `${file}.bak`);
  writeAtomic(file, JSON.stringify(envelope, null, 2));
  return generation;
}
