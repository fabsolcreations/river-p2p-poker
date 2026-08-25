import { Resvg } from '@resvg/resvg-js';
import fs from 'node:fs';
const SERIF='Tinos, Times New Roman, serif';
const SANS='Inter, Arial, sans-serif';

// One tile of the duelmerch monogram. base = garment colour, ink = motif colour.
export function monogramTile(base, ink, T=240){
  const g=(x,y,s,c)=>'<g transform="translate('+x+','+y+') scale('+s+')">'+c+'</g>';
  const DM='<text x="0" y="0" text-anchor="middle" dominant-baseline="central" font-family="'+SERIF+'" font-weight="700" font-size="58" letter-spacing="-6" fill="'+ink+'">DM</text>';
  const diamond='<path d="M0,-22 L15,0 L0,22 L-15,0 Z" fill="none" stroke="'+ink+'" stroke-width="5"/>';
  const ring='<circle r="13" fill="none" stroke="'+ink+'" stroke-width="5"/><circle r="3.5" fill="'+ink+'"/>';
  const inner=[g(60,60,1,DM),g(180,180,1,DM),
    g(180,60,1,diamond),g(60,180,1,diamond),
    g(120,120,1,ring),g(0,0,1,ring),g(240,0,1,ring),g(0,240,1,ring),g(240,240,1,ring)].join('');
  return {tile:'<rect width="'+T+'" height="'+T+'" fill="'+base+'"/>'+inner, size:T};
}

export function patternDefs(id, base, ink, T=240){
  const {tile}=monogramTile(base,ink,T);
  return '<defs><pattern id="'+id+'" width="'+T+'" height="'+T+'" patternUnits="userSpaceOnUse">'+tile+'</pattern></defs>';
}

if(process.argv[1].endsWith('monogram.mjs')){
  const sw=(base,ink,name)=>{
    const svg='<svg xmlns="http://www.w3.org/2000/svg" width="720" height="720">'+patternDefs('m',base,ink)+'<rect width="720" height="720" fill="url(#m)"/></svg>';
    fs.writeFileSync(name, new Resvg(svg,{font:{loadSystemFonts:true}}).render().asPng());
    console.log('wrote '+name);
  };
  sw('#141414','#262626','mono-black.png');
  sw('#202a47','#2e3d64','mono-navy.png');
}