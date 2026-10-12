// RFC-0015 error rules. A RegistryError carries the rule the CLI prints (error.rule) and
// decides the exit code: 3 for a refusal by a rule, 1 for an operational failure.
export type Rule='fetch.failed'|'hash.mismatch'|'archive.unsafe'|'archive.limit'|'data.executable'|'format.unsupported'|
 'package.invalid'|'content.conflict'|'requirement.missing'|'disk.full'|'managed.system'|'source.invalid'|
 'world.active'|'source.change'|'confirm.required'|'not.found';
/** Rules that are operational failures (exit 1); every other rule is a refusal (exit 3). */
const FAILURES=new Set<Rule>(['fetch.failed','disk.full','not.found']);
export class RegistryError extends Error {
 constructor(readonly rule:Rule,message:string,readonly data?:Record<string,unknown>) {super(message);this.name='RegistryError';}
 get exitCode():1|3 {return FAILURES.has(this.rule)?1:3;}
 toJSON() {return {rule:this.rule,message:this.message,...(this.data?{data:this.data}:{})};}
}
export function fail(rule:Rule,message:string,data?:Record<string,unknown>):never {throw new RegistryError(rule,message,data);}
/** ENOSPC or EDQUOT (Node names some errnos only by number). */
export const diskFull=(e:any)=>e?.code==='ENOSPC' || e?.code==='EDQUOT' || e?.errno===-28 || e?.errno===-122;
