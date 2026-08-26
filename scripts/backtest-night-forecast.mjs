// 過去データでの本格的な検証。平均誤差だけでなく、
// ①誤差のばらつき ②期間をまたぐ検証(前半で学習→後半で試す) ③当たり方の偏り
// ④単純な予測との比較 ⑤外した夜の中身 を見る。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { nightsFromCounts, lateShiftFrom, trainNightModel, predictNight, dayType, fmtMin }
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
const days=[...nights.keys()].filter(d=>LS.has(d)).sort();
const pct=(a,p)=>{const s=[...a].sort((x,y)=>x-y);return s[Math.floor(s.length*p)];};
const avg=(a)=>a.reduce((s,v)=>s+v,0)/a.length;

// --- ① ウォークフォワードの誤差分布 ---
const rec=[];
for(let i=30;i<days.length;i++){
  const tr=days.slice(0,i);
  const m=trainNightModel(new Map(tr.map(d=>[d,nights.get(d)])),new Map(tr.map(d=>[d,LS.get(d)])),holidays);
  const d=days[i], p=predictNight(d,LS.get(d),m,holidays), a=nights.get(d);
  if(!p||!a)continue;
  rec.push({d,pred:p.endMin,act:a.endMin,base:p.baseEndMin,
            predT:p.total,actT:a.total,baseT:p.baseTotal,ls:LS.get(d),type:p.dayType});
}
const e=rec.map(r=>Math.abs(r.pred-r.act)), eb=rec.map(r=>Math.abs(r.base-r.act));
console.log(`=== ① 終わり時刻の誤差(${rec.length}夜) ===`);
console.log(`  補正あり: 中央${pct(e,.5).toFixed(0)}分  半分は${pct(e,.25).toFixed(0)}〜${pct(e,.75).toFixed(0)}分  最悪${Math.max(...e).toFixed(0)}分`);
console.log(`  15分以内 ${(100*e.filter(x=>x<=15).length/e.length).toFixed(0)}% / 30分以内 ${(100*e.filter(x=>x<=30).length/e.length).toFixed(0)}% / 60分以内 ${(100*e.filter(x=>x<=60).length/e.length).toFixed(0)}%`);
console.log(`  土台だけ: 30分以内 ${(100*eb.filter(x=>x<=30).length/eb.length).toFixed(0)}%`);

// --- ④ 単純な予測との比較 ---
const gm=avg([...nights.values()].map(v=>v.endMin));
const eNaive=rec.map(r=>Math.abs(gm-r.act));
console.log(`\n=== ④ 単純な予測との比較(平均誤差) ===`);
console.log(`  いつも同じ時刻と言う : ${avg(eNaive).toFixed(0)}分`);
console.log(`  曜日タイプだけ      : ${avg(eb).toFixed(0)}分`);
console.log(`  ＋遅延補正          : ${avg(e).toFixed(0)}分`);

// --- ② 期間をまたぐ検証 ---
const mid=Math.floor(days.length/2);
const tr=days.slice(0,mid), te=days.slice(mid);
const m2=trainNightModel(new Map(tr.map(d=>[d,nights.get(d)])),new Map(tr.map(d=>[d,LS.get(d)])),holidays);
const e2=[],e2b=[];
for(const d of te){const p=predictNight(d,LS.get(d),m2,holidays),a=nights.get(d);
  if(!p||!a)continue; e2.push(Math.abs(p.endMin-a.endMin)); e2b.push(Math.abs(p.baseEndMin-a.endMin));}
console.log(`\n=== ② 前半(${tr.length}夜)で学習 → 後半(${e2.length}夜)で試す ===`);
console.log(`  土台だけ ${avg(e2b).toFixed(0)}分 → 遅延補正あり ${avg(e2).toFixed(0)}分`);

// --- ③ 当たり方の偏り(遅延が多い夜ほど当たる?) ---
console.log(`\n=== ③ 遅延の量ごとの当たり具合 ===`);
const q=[...rec].sort((a,b)=>a.ls-b.ls);
const th=Math.floor(q.length/3);
for(const [name,g] of [['遅延すくない',q.slice(0,th)],['ふつう',q.slice(th,2*th)],['遅延おおい',q.slice(2*th)]]){
  const ge=g.map(r=>Math.abs(r.pred-r.act)), gb=g.map(r=>Math.abs(r.base-r.act));
  console.log(`  ${name.padEnd(7)} (${g.length}夜) 押し出し平均${avg(g.map(r=>r.ls)).toFixed(0)}人  誤差 土台${avg(gb).toFixed(0)}分 → 補正後${avg(ge).toFixed(0)}分`);
}
// --- ⑤ 外した夜 ---
console.log(`\n=== ⑤ 大きく外した夜(上位5) ===`);
for(const r of [...rec].sort((a,b)=>Math.abs(b.pred-b.act)-Math.abs(a.pred-a.act)).slice(0,5)){
  console.log(`  ${r.d} ${r.type.padEnd(13)} 予測${fmtMin(r.pred)} 実際${fmtMin(r.act)} (${(r.act-r.pred>0?'+':'')}${(r.act-r.pred).toFixed(0)}分) 押し出し${r.ls}人`);
}
