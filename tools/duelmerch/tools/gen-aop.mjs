import { Resvg } from '@resvg/resvg-js';
import fs from 'node:fs';
import { patternDefs } from './monogram.mjs';
const OUT='C:/Users/mypc/Documents/Codex/2026-08-12/i-create-a-p2p-crypto-poker/tools/duelmerch/public/print';
// Printful all-over templates: hoodie body 6000x6000, tee body 5250x6750,
// tee sleeves 5250x3000. Tile scaled so a motif reads ~0.5in on the garment.
const JOBS=[
  ['monogram-black-6000',6000,6000,'#141414','#262626',300],
  ['monogram-navy-6000',6000,6000,'#202a47','#2e3d64',300],
  ['monogram-black-tee',5250,6750,'#141414','#262626',300],
  ['monogram-navy-tee',5250,6750,'#202a47','#2e3d64',300],
  ['monogram-black-sleeve',5250,3000,'#141414','#262626',300],
  ['monogram-navy-sleeve',5250,3000,'#202a47','#2e3d64',300],
];
for(const [name,w,h,base,ink,tile] of JOBS){
  const svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'">'+patternDefs('m',base,ink,tile)+'<rect width="'+w+'" height="'+h+'" fill="url(#m)"/></svg>';
  const png=new Resvg(svg,{font:{loadSystemFonts:true}}).render().asPng();
  fs.writeFileSync(OUT+'/'+name+'.png',png);
  console.log(name.padEnd(26)+w+'x'+h+'  '+Math.round(png.length/1024)+'KB');
}