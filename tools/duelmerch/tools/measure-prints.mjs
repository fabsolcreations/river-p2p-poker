import { Resvg } from '@resvg/resvg-js';
import fs from 'node:fs';
const SITE='C:/Users/mypc/Documents/Codex/2026-08-12/i-create-a-p2p-crypto-poker/tools/duelmerch/public/index.html';
const html=fs.readFileSync(SITE,'utf8');
const src=html.slice(html.indexOf('const INK ='), html.indexOf('/* ---------- catalog ----------'));
const names=[...src.matchAll(/const (print[A-Za-z0-9]+) =/g)].map(m=>m[1]);
const vals=new Function(src+';return {'+names.map(n=>n+':'+n).join(',')+'};')();
console.log('print'.padEnd(22),'width'.padEnd(7),'x-range'.padEnd(14),'verdict');
for(const [n,frag] of Object.entries(vals)){
  const wrapped='<svg xmlns="http://www.w3.org/2000/svg" width="400" height="460" viewBox="0 0 400 460">'+frag+'</svg>';
  let b=null;
  try { b=new Resvg(wrapped,{font:{loadSystemFonts:true}}).innerBBox(); } catch(e){ console.log(n.padEnd(22),'RENDER FAIL'); continue; }
  if(!b){ console.log(n.padEnd(22),'(empty)'); continue; }
  const w=Math.round(b.width), x0=Math.round(b.x), x1=Math.round(b.x+b.width);
  const over = x0<130 || x1>270;
  console.log(n.padEnd(22), String(w).padEnd(7), (x0+'-'+x1).padEnd(14), over?'*** OVERFLOWS':'ok');
}
