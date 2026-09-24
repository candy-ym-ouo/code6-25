import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLatest, readSave, writeSave } from './persistence.js';

const dir=mkdtempSync(join(tmpdir(),'save-test-'));
const file=join(dir,'data.json');

// 无存档时从空数据开始
let loaded=loadLatest<string[]>(file,[]);
assert.deepEqual(loaded,{data:[],generation:0,recovered:false});

// 写入后立即重新加载（模拟成功后立即重启）不丢进度，且带代次与校验
writeSave(file,['a'],1);
loaded=loadLatest<string[]>(file,[]);
assert.deepEqual(loaded.data,['a']);
assert.equal(loaded.generation,1);
assert.equal(loaded.recovered,false);
const env=JSON.parse(readFileSync(file,'utf8'));
assert.equal(env.generation,1);
assert.match(env.checksum,/^[0-9a-f]{64}$/);
assert.ok(env.savedAt);

// 再次写入后，备份保留上一完整版本
writeSave(file,['a','b'],2);
assert.equal(readSave<string[]>(`${file}.bak`)!.generation,1);
assert.deepEqual(readSave<string[]>(`${file}.bak`)!.data,['a']);

// 主文件写坏（截断）→ 从备份恢复上一完整版本
writeFileSync(file,'{"generation":2,"checksum":"abc');
loaded=loadLatest<string[]>(file,[]);
assert.equal(loaded.recovered,true);
assert.deepEqual(loaded.data,['a']);
assert.equal(loaded.generation,1);

// 损坏的主文件不得污染备份；篡改数据导致校验失败 → 仍回退到上一完整版本
writeSave(file,['a','b'],2);
assert.equal(readSave<string[]>(`${file}.bak`)!.generation,1);
const tampered=JSON.parse(readFileSync(file,'utf8'));
tampered.data.push('evil');
writeFileSync(file,JSON.stringify(tampered));
loaded=loadLatest<string[]>(file,[]);
assert.equal(loaded.recovered,true);
assert.deepEqual(loaded.data,['a']);

// 旧版纯数组存档可迁移读取，下次写入自动升级为带代次/校验的格式
writeFileSync(file,JSON.stringify(['legacy']));
loaded=loadLatest<string[]>(file,[]);
assert.deepEqual(loaded.data,['legacy']);
assert.equal(loaded.generation,0);
writeSave(file,loaded.data,loaded.generation+1);
assert.equal(readSave<string[]>(file)!.generation,1);

// 主备都损坏 → 回退初始值而不是抛异常
writeFileSync(file,'not json');
writeFileSync(`${file}.bak`,'also not json');
loaded=loadLatest<string[]>(file,[]);
assert.deepEqual(loaded.data,[]);
assert.equal(loaded.generation,0);

// 崩溃残留的 tmp 文件不影响读写
writeFileSync(`${file}.tmp`,'{"generation":99');
writeSave(file,['c'],2);
assert.deepEqual(loadLatest<string[]>(file,[]).data,['c']);
assert.ok(!existsSync(`${file}.tmp`));

rmSync(dir,{recursive:true,force:true});
console.log('persistence tests passed');
