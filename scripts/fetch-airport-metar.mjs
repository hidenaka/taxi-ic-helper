#!/usr/bin/env node
// 羽田の気象通報(METAR)を毎日取り足す。雷はここでしか取れない
// (Open-Meteo の天気コードは5〜8月で雷0件だった)。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const OUT=path.join(ROOT,'data/airport-metar-history.json');
const ST={RJTT:'羽田',RJCC:'新千歳',RJFF:'福岡',ROAH:'那覇',RJOO:'伊丹',RJFK:'鹿児島'};
let db={}; try{ db=JSON.parse(readFileSync(OUT,'utf8')); }catch{}
const jst=new Date(Date.now()+9*3600000);
const end=jst.toISOString().slice(0,10);
const start=new Date(jst.getTime()-5*86400000).toISOString().slice(0,10);
for(const [code,name] of Object.entries(ST)){
  const [y1,m1,d1]=start.split('-'), [y2,m2,d2]=end.split('-');
  const u=`https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?station=${code}&data=wxcodes&data=p01i`
    +`&year1=${y1}&month1=${+m1}&day1=${+d1}&year2=${y2}&month2=${+m2}&day2=${+d2}`
    +`&tz=Asia/Tokyo&format=onlycomma&latlon=no&missing=empty&trace=0.0001&direct=no&report_type=3`;
  let txt=null;
  try{ const r=await fetch(u); if(r.ok) txt=await r.text(); }catch(e){}
  if(!txt){ console.error(`${name}: 取得できず`); continue; }
  const cur=db[code]||{name,rows:[]};
  const have=new Set(cur.rows.map(r=>r.t));
  let added=0;
  for(const l of txt.trim().split('\n').slice(1)){
    const p=l.split(',');
    if(p.length<3||have.has(p[1])) continue;
    cur.rows.push({t:p[1],wx:p[2]||'',p1:Number(p[3]||0)}); added++;
  }
  cur.rows.sort((a,b)=>a.t.localeCompare(b.t));
  db[code]=cur;
  console.log(`${name}: +${added}時間 (計${cur.rows.length})`);
}
writeFileSync(OUT, JSON.stringify(db));
