#!/usr/bin/env node
// 今夜の予測を出す(裏で動かす用)。data/night-forecast.json に書く。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { nightsFromCounts, lateShiftFrom, trainNightModel, predictNight, fmtMin,
         lightningWarning, hanedaLightningHours }
  from './lib/night-forecast.mjs';
const ROOT=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const R=(x)=>path.join(ROOT,x);
const rd=(p)=>readFileSync(p,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const holidays=new Set(JSON.parse(readFileSync(R('data/jp-holidays.json'),'utf8')).map(x=>x.date));
const nights=nightsFromCounts(rd(R('data/advance-count-rebuilt.jsonl')));
const LS=new Map();
for(const f of readdirSync(R('data/arrivals-snapshots')).filter(f=>f.endsWith('.jsonl')).sort()){
  const day=f.slice(9,19); let last=null;
  for(const line of readFileSync(path.join(R('data/arrivals-snapshots'),f),'utf8').split('\n')){
    if(!line.trim())continue; try{last=JSON.parse(line);}catch{}}
  if(last&&last.flights) LS.set(day, lateShiftFrom(last.flights).pax);
}
const model=trainNightModel(nights,LS,holidays);
// 今夜: 現在の arrivals.json から遅延量を出す
const jstNow=new Date(Date.now()+9*3600000);
const today=jstNow.toISOString().slice(0,10);
let pax=0,cnt=0;
try{
  const a=JSON.parse(readFileSync(R('data/arrivals.json'),'utf8'));
  const r=lateShiftFrom(a.flights); pax=r.pax; cnt=r.count;
}catch(e){ console.error('arrivals読み込み失敗:',e.message); }
const p=predictNight(today,pax,model,holidays);
if(!p){ console.error('予測できません'); process.exit(1); }
// 羽田の雷(METAR)。取れないときは警告なしで続行する。
let tsHours=0, warn=null;
try{
  const M=JSON.parse(readFileSync(R('data/airport-metar-history.json'),'utf8'));
  const hn=Object.values(M).find(v=>v.name==='羽田');
  if(hn){ tsHours=hanedaLightningHours(hn.rows, today); warn=lightningWarning(tsHours); }
}catch(e){}
const out={
  schema_version:1,
  generatedAt:new Date(Date.now()+9*3600000).toISOString().replace('Z','+09:00'),
  night:today,
  dayType:p.dayType,
  lateShiftPax:pax, lateShiftFlights:cnt,
  endMin:Math.round(p.endMin), endTime:fmtMin(p.endMin),
  baseEndTime:fmtMin(p.baseEndMin),
  total:Math.round(p.total), baseTotal:Math.round(p.baseTotal),
  vsUsualMin:Math.round(p.endMin-p.baseEndMin),
  vsUsualRatio:Number((p.total/p.baseTotal).toFixed(2)),
  hanedaLightningHours:tsHours,
  warning:warn,
  note:'夜(20:00〜翌4:00)の動きが終わる目安。実測92夜から学習。誤差の目安は約30分',
};
writeFileSync(R('data/night-forecast.json'), JSON.stringify(out,null,2)+'\n');
console.log(`【今夜(${today})の見込み】`);
console.log(`  区分: ${p.dayType}`);
console.log(`  遅延で23時以降に押し出された客: ${pax}人 (${cnt}便)  ※平均は${model.delay.meanShift.toFixed(0)}人`);
console.log(`  動きの終わり: ${out.endTime}  (ふつうのこの曜日は ${out.baseEndTime} / 差 ${out.vsUsualMin>=0?'+':''}${out.vsUsualMin}分)`);
if(warn) console.log(`  ⚠ ${warn.text} (羽田の雷 ${tsHours}時間)`);
console.log(`  動きの総量  : ${out.total}回  (ふつう ${out.baseTotal}回 / いつもの${out.vsUsualRatio}倍)`);
