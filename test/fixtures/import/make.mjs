// Import fixtures (original, CC0-1.0; see PROVENANCE.md): run from the SDK root with
//   node test/fixtures/import/make.mjs
// barrel/: a glTF barrel modelled in centimetres with +Z up (as some exporters write it),
// about 12,500 triangles and a 2048 x 1024 stave texture, so an import has to convert units
// and axes, decimate and shrink the texture. crate/: a 60 cm OBJ cube with an MTL colour.
import {mkdirSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Document,NodeIO} from '@gltf-transform/core';
import {createRequire} from 'node:module';
const {PNG}=createRequire(import.meta.url)('pngjs');

const here=dirname(fileURLToPath(import.meta.url));
const SEG=128,RINGS=48,HEIGHT=120,RADIUS=35,BULGE=6;
const pos=[],nor=[],uv=[],idx=[];
// Body: the radius bulges at mid height; +Z is up.
for(let r=0;r<=RINGS;r++){
 const t=r/RINGS,z=t*HEIGHT,rad=RADIUS+BULGE*Math.sin(Math.PI*t),slope=BULGE*Math.PI*Math.cos(Math.PI*t)/HEIGHT;
 for(let s=0;s<=SEG;s++){
  const a=s/SEG*2*Math.PI,c=Math.cos(a),n=Math.sin(a);
  pos.push(rad*c,rad*n,z);const l=Math.hypot(1,slope);nor.push(c/l,n/l,-slope/l);uv.push(s/SEG,1-t);
 }
}
for(let r=0;r<RINGS;r++)for(let s=0;s<SEG;s++){const a=r*(SEG+1)+s,b=a+SEG+1;idx.push(a,a+1,b,a+1,b+1,b);}
// Caps (fans) at both ends.
for(const [z,nz] of [[0,-1],[HEIGHT,1]]){
 const centre=pos.length/3;pos.push(0,0,z);nor.push(0,0,nz);uv.push(.5,.5);
 const first=pos.length/3;
 for(let s=0;s<=SEG;s++){const a=s/SEG*2*Math.PI;pos.push(RADIUS*Math.cos(a),RADIUS*Math.sin(a),z);nor.push(0,0,nz);uv.push(.5+.5*Math.cos(a),.5+.5*Math.sin(a));}
 for(let s=0;s<SEG;s++)nz>0?idx.push(centre,first+s,first+s+1):idx.push(centre,first+s+1,first+s);
}
// Staves: 24 planks with dark seams and three iron hoops, 2048 x 1024.
const W=2048,H=1024,px=Buffer.alloc(W*H*4,255);
for(let y=0;y<H;y++)for(let x=0;x<W;x++){
 const stave=Math.floor(x/(W/24)),seam=(x%(W/24))<3,hoop=[.12,.5,.88].some(h=>Math.abs(y/H-h)<.025);
 const grain=.05*Math.sin(stave*7.3)+.03*Math.sin(y*.01+stave);
 const base=hoop?[.18,.18,.2]:seam?[.22,.13,.07]:[.62+grain+.03*(stave%3),.42+grain,.24+grain/2];
 const i=(y*W+x)*4;for(let k=0;k<3;k++)px[i+k]=Math.round(Math.max(0,Math.min(1,base[k]))*255);
}
const png=PNG.sync.write({width:W,height:H,data:px},{deflateLevel:9,colorType:2});
const doc=new Document(),buffer=doc.createBuffer();
const acc=(type,arr,T)=>doc.createAccessor().setType(type).setArray(new T(arr)).setBuffer(buffer);
const texture=doc.createTexture('staves').setImage(png).setMimeType('image/png').setURI('staves.png');
const mat=doc.createMaterial('oak').setBaseColorTexture(texture).setRoughnessFactor(.8).setMetallicFactor(0);
const prim=doc.createPrimitive().setAttribute('POSITION',acc('VEC3',pos,Float32Array)).setAttribute('NORMAL',acc('VEC3',nor,Float32Array))
 .setAttribute('TEXCOORD_0',acc('VEC2',uv,Float32Array)).setIndices(acc('SCALAR',idx,Uint32Array)).setMaterial(mat);
doc.createScene('barrel').addChild(doc.createNode('barrel').setMesh(doc.createMesh('barrel').addPrimitive(prim)));
doc.getRoot().getAsset().generator='hyprune sdk test/fixtures/import/make.mjs';
mkdirSync(join(here,'barrel'),{recursive:true});
buffer.setURI('barrel.bin');
await new NodeIO().write(join(here,'barrel/barrel.gltf'),doc);
// crate/: an OBJ cube, 60 cm, Y up, with a diffuse colour.
mkdirSync(join(here,'crate'),{recursive:true});
const v=[],f=[];for(const x of [-30,30])for(const y of [0,60])for(const z of [-30,30])v.push(`v ${x} ${y} ${z}`);
// Corners: index = 1 + 4*ix + 2*iy + iz.
const c=(ix,iy,iz)=>1+4*ix+2*iy+iz;
for(const q of [[c(0,0,0),c(0,0,1),c(0,1,1),c(0,1,0)],[c(1,0,0),c(1,1,0),c(1,1,1),c(1,0,1)],[c(0,0,0),c(1,0,0),c(1,0,1),c(0,0,1)],
 [c(0,1,0),c(0,1,1),c(1,1,1),c(1,1,0)],[c(0,0,0),c(0,1,0),c(1,1,0),c(1,0,0)],[c(0,0,1),c(1,0,1),c(1,1,1),c(0,1,1)]])f.push('f '+q.join(' '));
writeFileSync(join(here,'crate/crate.obj'),['# Hyprune import fixture (CC0-1.0)','mtllib crate.mtl','o crate',...v,'usemtl pine',...f,''].join('\n'));
writeFileSync(join(here,'crate/crate.mtl'),['newmtl pine','Kd 0.72 0.55 0.33','Ns 10',''].join('\n'));
console.log('fixtures written: triangles', idx.length/3);
