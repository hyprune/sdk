// `world pack --release` and `library pack --release` (RFC-0015 "Release record"): the
// archive, its .sha256 file and <id>-<version>.release.json, plus up to four verified
// thumbnails, from a package directory at a tag.
import {copyFileSync,existsSync,linkSync,mkdirSync,mkdtempSync,readFileSync,rmSync,statSync,unlinkSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve,extname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {fail} from './errors.js';
import {tagVersion,versionTag} from './semver.js';
import {libraryRefs} from './sources.js';
import {validateWorld,packWorld,readAsset} from '../world.js';
import {validateLibrary,imageHeader} from '../object.js';
import {validateRegistry,objectLimits} from '../validation.js';
import type {ReleaseRecord} from './index.js';
import type {PackageType} from './archive.js';

export const SDK_VERSION:string=JSON.parse(readFileSync(new URL('../../../package.json',import.meta.url),'utf8')).version;
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
/** A deterministic library archive (one root named like the id), checked before and after staging. */
export async function packLibrary(directory:string,output?:string):Promise<{path:string;sha256:string;packageDigest:string}> {
 const root=resolve(directory),checked=await validateLibrary(root),id=checked.manifest.id;
 const destination=resolve(output || `${id}-${checked.manifest.version}.tar.zst`);
 if(destination===root || destination.startsWith(root+'/')) throw new Error('Archive output must be outside the package');
 if(existsSync(destination)) throw new Error('Refusing to overwrite archive');
 const staging=mkdtempSync(join(tmpdir(),'hyprune-pack-')),archiveDir=mkdtempSync(join(dirname(destination),'.hyprune-pack-')),temp=join(archiveDir,'library.tar.zst');
 try {
  const stageRoot=join(staging,id);mkdirSync(stageRoot);
  for(const f of checked.files) {const path=join(stageRoot,f.path);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,readAsset(root,f.path,objectLimits.fileBytes),{mode:0o644});}
  const again=await validateLibrary(stageRoot);if(again.digest!==checked.digest) throw new Error('Package changed during packing');
  execFileSync('tar',['--sort=name','--mtime=@0','--owner=0','--group=0','--numeric-owner','--format=ustar','--zstd','-cf',temp,'-C',staging,'--',id],{stdio:'pipe'});
  const hash=sha(readFileSync(temp));linkSync(temp,destination);unlinkSync(temp);
  return {path:destination,sha256:hash,packageDigest:checked.digest};
 } finally {rmSync(staging,{recursive:true,force:true});rmSync(archiveDir,{recursive:true,force:true});}
}
/** The repository URL of a git remote as https://host/owner/repo (from ssh or https forms). */
export function httpsRemote(remote:string):string|undefined {
 const ssh=/^(?:ssh:\/\/)?git@([^:/]+)[:/](.+?)(?:\.git)?\/?$/.exec(remote.trim());
 if(ssh) return `https://${ssh[1]}/${ssh[2]}`;
 const https=/^https:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(remote.trim());
 return https?`https://${https[1]}/${https[2]}`:undefined;
}
const git=(dir:string,...args:string[])=>{try {return execFileSync('git',['-C',dir,...args],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();} catch {return undefined;}};
export interface ReleaseOptions {type:PackageType;tag?:string;repo?:string;commit?:string;output?:string;thumbnails?:string[]}
export interface ReleaseResult {archive:string;sha256File:string;record:string;thumbnails:string[];sha256:string;tag:string;recordValue:ReleaseRecord}
/**
 * Pack a package for a release: validate, pack `<id>-<version>.tar.zst`, write its `.sha256`
 * line and the release record. The tag (default v<version>) must name the manifest version;
 * --repo defaults to the git remote `origin`, --commit to HEAD (and must match the tag's commit
 * when the tag exists locally).
 */
export async function packRelease(directory:string,o:ReleaseOptions):Promise<ReleaseResult> {
 const root=resolve(directory),out=resolve(o.output || '.');
 const checked=o.type==='world'?await validateWorld(root):await validateLibrary(root);
 const m:any=checked.manifest,stem=`${m.id}-${m.version}`;
 const tag=o.tag ?? versionTag(m.version);
 const named=tagVersion(tag);
 if(!named || named.version!==m.version) fail('package.invalid',`tag ${tag} must name the manifest version ${m.version} (v${m.version} or <name>-v${m.version})`);
 if(m.version.includes('+')) fail('package.invalid','published versions carry no build metadata');
 const repo=o.repo ?? httpsRemote(git(root,'remote','get-url','origin') ?? '');
 if(!repo || !/^https:\/\/[^\s/]+\/\S+$/.test(repo)) fail('package.invalid','--repo https://github.com/<owner>/<repo> is required (no git remote origin found)');
 const head=git(root,'rev-parse','HEAD'),tagged=git(root,'rev-parse','--verify','-q',`refs/tags/${tag}^{commit}`);
 const commit=o.commit ?? tagged ?? head;
 if(!commit || !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) fail('package.invalid','--commit <full sha> is required (not a git checkout)');
 if(tagged && tagged!==commit) fail('package.invalid',`tag ${tag} points to ${tagged}, not ${commit}`);
 if((o.thumbnails ?? []).length>4) fail('package.invalid','at most 4 thumbnails');
 mkdirSync(out,{recursive:true});
 const names=[`${stem}.tar.zst`,`${stem}.tar.zst.sha256`,`${stem}.release.json`];
 for(const n of names) if(existsSync(join(out,n))) fail('package.invalid',`${join(out,n)} exists; refusing to overwrite`);
 // Thumbnails first: nothing is written when one is wrong.
 const thumbs=(o.thumbnails ?? []).map((file,i)=>{
  const bytes=readFileSync(file),header=imageHeader(bytes);
  if(!header || header.format==='ktx2') fail('package.invalid',`${file}: thumbnails are PNG or JPEG`);
  if(bytes.length>512*1024) fail('package.invalid',`${file}: ${bytes.length} bytes, more than 512 KiB`);
  if(header!.width>1280 || header!.height>720) fail('package.invalid',`${file}: ${header!.width}x${header!.height}, more than 1280x720`);
  const ext=header!.format==='png'?'png':'jpg',name=`${stem}.thumb-${i+1}.${ext}`;
  if(existsSync(join(out,name))) fail('package.invalid',`${join(out,name)} exists; refusing to overwrite`);
  return {file,name,sha256:sha(bytes),width:header!.width,height:header!.height};
 });
 const packed=o.type==='world'?await packWorld(root,join(out,names[0])):await packLibrary(root,join(out,names[0]));
 const requires=o.type==='world'?libraryRefs(m):[];
 const record:ReleaseRecord={recordVersion:'0.1',type:o.type,id:m.id,version:m.version,formatVersion:m.formatVersion,name:String(m.name).slice(0,64),license:m.license,
  archive:{name:names[0],sha256:packed.sha256,bytes:statSync(packed.path).size,expandedBytes:checked.files.reduce((n,f)=>n+f.size,0),files:checked.files.length},
  ...(requires.length?{requires:{libraries:requires}}:{}),
  ...(thumbs.length?{thumbnails:thumbs.map(t=>({name:t.name,sha256:t.sha256,width:t.width,height:t.height}))}:{}),
  source:{repo,tag,commit:commit!},tool:{name:'hyprune',version:SDK_VERSION},
  checks:{schema:'pass',[o.type==='world'?'sdkWorldCheck':'libraryCheck']:'pass'}};
 const valid=validateRegistry('release-record',record);
 if(!valid.valid) {unlinkSync(packed.path);fail('package.invalid',`release record: ${valid.errors.join('; ')}`);}
 writeFileSync(join(out,names[1]),`${packed.sha256}  ${names[0]}\n`);
 writeFileSync(join(out,names[2]),JSON.stringify(record,null,2)+'\n');
 for(const t of thumbs) copyFileSync(t.file,join(out,t.name));
 return {archive:packed.path,sha256File:join(out,names[1]),record:join(out,names[2]),thumbnails:thumbs.map(t=>join(out,t.name)),sha256:packed.sha256,tag,recordValue:record};
}
export const thumbnailExt=(file:string)=>extname(file).toLowerCase();
