import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {withHeader} from './readme-header.mjs';
const root=new URL('../vendor/schema/',import.meta.url),source=JSON.parse(readFileSync(new URL('source.json',root)));
for(const [path,expected] of Object.entries(source.sha256)) {
 const actual=createHash('sha256').update(readFileSync(new URL(path,root))).digest('hex');
 if(actual!==expected) throw new Error('Pinned schema changed: '+path);
}
if(readFileSync(new URL('COMMIT',root),'utf8').trim()!==source.commit) throw new Error('Schema commit mismatch');
console.log('Pinned schema bytes verified: '+source.commit);
const readme=readFileSync(new URL('../README.md',import.meta.url),'utf8');
if(withHeader(readme)!==readme) throw new Error('README header is stale: run npm run generate');
console.log('README header matches the vendored pins');
