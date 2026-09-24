import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';

export type Envelope<T> = { generation:number; checksum:string; savedAt:string; data:T };

const sha256=(s:string)=>createHash('sha256').update(s).digest('hex');

export function readSave<T>(file:string):Envelope<T>|null{
  try{
    if(!existsSync(file))return null;
    const parsed=JSON.parse(readFileSync(file,'utf8'));
    if(Array.isArray(parsed))return {generation:0,checksum:'',savedAt:'',data:parsed as T};
    if(!parsed||typeof parsed!=='object')return null;
    const {generation,checksum,savedAt,data}=parsed;
    if(!Number.isInteger(generation)||generation<0||typeof checksum!=='string'||data===undefined)return null;
    if(sha256(JSON.stringify(data))!==checksum)return null;
    return {generation,checksum,savedAt:String(savedAt||''),data};
  }catch{return null}
}

export function writeSave<T>(file:string,data:T,generation:number):Envelope<T>{
  const env:Envelope<T>={generation,checksum:sha256(JSON.stringify(data)),savedAt:new Date().toISOString(),data};
  const tmp=`${file}.tmp`,bak=`${file}.bak`;
  const fd=openSync(tmp,'w');
  try{writeSync(fd,JSON.stringify(env,null,2));fsyncSync(fd)}finally{closeSync(fd)}
  if(readSave<T>(file))renameSync(file,bak);
  renameSync(tmp,file);
  return env;
}

export function loadLatest<T>(file:string,empty:T):{data:T;generation:number;recovered:boolean}{
  const main=readSave<T>(file);
  if(main)return {data:main.data,generation:main.generation,recovered:false};
  const bak=readSave<T>(`${file}.bak`);
  if(bak){console.warn(`[save] 主存档缺失或校验失败，已从 ${file}.bak 恢复代次 ${bak.generation}`);return {data:bak.data,generation:bak.generation,recovered:true}}
  if(existsSync(file)||existsSync(`${file}.bak`))console.warn(`[save] 存档损坏且无可用备份，从空存档开始`);
  return {data:empty,generation:0,recovered:false};
}
