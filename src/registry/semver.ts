// SemVer and the tag convention (RFC-0015 "Repository and tags"), shared with the schema validator.
import {parseSemver,compareSemver,tagVersion} from '../validation.js';
export {parseSemver,compareSemver,tagVersion};
export const isPrerelease=(version:string)=>(parseSemver(version)?.prerelease.length ?? 0)>0;
/** The tag for a version: v<version>, or <name>-v<version> in a multi-package repository. */
export const versionTag=(version:string,name?:string|null)=>name?`${name}-v${version}`:`v${version}`;
/** Sort newest first by SemVer. */
export const newestFirst=<T extends {version:string}>(items:T[]):T[]=>[...items].sort((a,b)=>compareSemver(b.version,a.version));
/**
 * Find the version a user's `@<tag>` names: an exact tag, else a bare SemVer mapped by the tag
 * convention (`@1.2.0` matches tag v1.2.0 or <name>-v1.2.0).
 */
export function matchTag<T extends {tag:string;version:string}>(versions:T[],wanted:string):T|undefined {
 return versions.find(v=>v.tag===wanted) ?? (parseSemver(wanted)?versions.find(v=>v.version===wanted && tagVersion(v.tag)?.version===wanted):undefined);
}
