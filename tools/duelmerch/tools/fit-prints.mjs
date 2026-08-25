import { Resvg } from '@resvg/resvg-js';
import fs from 'node:fs';
// NOTE: printChestWordmark / printChestDates are deliberately small and offset
// to the left chest — they are NOT in AREA, so the fitter leaves them alone.
const SITE='C:/Users/mypc/Documents/Codex/2026-08-12/i-create-a-p2p-crypto-poker/tools/duelmerch/public/index.html';
let html=fs.readFileSync(SITE,'utf8');
const src=html.slice(html.indexOf('const INK ='), html.indexOf('/* ---------- catalog ----------'));
const names=[...src.matchAll(/const (print[A-Za-z0-9]+) =/g)].map(m=>m[1]);
const vals=new Function(src+';return {'+names.map(n=>n+':'+n).join(',')+'};')();
const AREA={printGamblingEasy:[130,270],printCow:[130,270],print2029:[130,270],printDM:[130,270],
  printReceipt:[130,270],printOnTheTeam:[130,270],printRTP:[130,270],printNoOne:[130,270],
  printDayCount:[130,270],printBackBillion:[130,270],printSoWhy:[130,270],printNotHard:[130,270],printLore:[108,262],printTrademarked:[108,262],printEV:[132,268]};
function bbox(frag){
  const svg='<svg xmlns="http://www.w3.org/2000/svg" width="400" height="460" viewBox="0 0 400 460">'+frag+'</svg>';
  return new Resvg(svg,{font:{loadSystemFonts:true}}).innerBBox();
}
let changed=0;
for(const [n,frag] of Object.entries(vals)){
  const area=AREA[n]; if(!area) continue;
  const b=bbox(frag); if(!b) continue;
  const lo=area[0], hi=area[1], maxW=hi-lo, target=(lo+hi)/2;
  const w=b.width, cx=b.x+b.width/2, cy=b.y+b.height/2;
  const s=Math.min(1,(maxW-4)/w);
  const needsShift=Math.abs(cx-target)>1.5;
  if(s>=0.999 && !needsShift){ console.log(n.padEnd(20),'fits'); continue; }
  const g='<g transform="translate('+target.toFixed(1)+','+cy.toFixed(1)+') scale('+s.toFixed(4)+') translate('+(-cx).toFixed(1)+','+(-cy).toFixed(1)+')">';
  const after=bbox(g+frag+'</g>');
  console.log(n.padEnd(20),'x'+s.toFixed(3),Math.round(w)+' -> '+Math.round(after.width),'['+Math.round(after.x)+'-'+Math.round(after.x+after.width)+']');
  const marker='const '+n+' = `';
  const i=html.indexOf(marker);
  const j=html.indexOf('`;', i+marker.length);
  html=html.slice(0,i+marker.length)+g+html.slice(i+marker.length,j)+'</g>'+html.slice(j);
  changed++;
}
fs.writeFileSync(SITE,html);
console.log(changed+' prints refitted');