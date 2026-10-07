export const MAX_FRAME = 1_048_576;
export class FrameError extends Error {
  constructor(message: string, public readonly parseError = false) { super(message); }
}
/** Strict JSON: duplicate keys (including escaped equivalents), finite numbers,
 * valid Unicode bytes and at most 64 nested containers. No eval or reviver. */
export function parseJson(text: string): unknown {
  let i=0;
  const ws=()=>{ while (/[\x20\t\r\n]/.test(text[i] || '\0')) i++; };
  const string=(): string => {
    const start=i++;
    while(i<text.length) {
      const c=text[i++];
      if(c==='"') { try { return JSON.parse(text.slice(start,i)); } catch { break; } }
      if(c==='\\') i++;
    }
    throw new FrameError('Invalid JSON string',true);
  };
  const value=(depth: number): unknown => {
    ws(); const c=text[i];
    if(c==='"') return string();
    if(c==='{' || c==='[') {
      if(depth>=64) throw new FrameError('JSON nesting exceeds 64');
      const object=c==='{'; i++; ws();
      const result: any=object?{}:[]; const keys=new Set<string>();
      if(text[i]===(object?'}':']')) { i++; return result; }
      for(;;) {
        ws(); let key='';
        if(object) {
          if(text[i]!=='"') throw new FrameError('Expected object key',true);
          key=string(); if(keys.has(key)) throw new FrameError('Duplicate JSON key'); keys.add(key);
          ws(); if(text[i++]!==':') throw new FrameError('Expected colon',true);
        }
        const v=value(depth+1);
        if(object) Object.defineProperty(result,key,{value:v,enumerable:true,writable:true,configurable:true}); else result.push(v);
        ws(); const end=text[i++];
        if(end===(object?'}':']')) return result;
        if(end!==',') throw new FrameError('Expected comma',true);
      }
    }
    for(const [token,v] of [['true',true],['false',false],['null',null]] as const) if(text.startsWith(token,i)) { i+=token.length; return v; }
    const number=/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
    if(number) { i+=number[0].length; const n=Number(number[0]); if(!Number.isFinite(n)) throw new FrameError('Nonfinite number'); return n; }
    throw new FrameError('Invalid JSON',true);
  };
  const result=value(0); ws(); if(i!==text.length) throw new FrameError('Trailing JSON data',true); return result;
}
export function encodeFrame(value: unknown): Buffer {
  const text=JSON.stringify(value,(_k,v)=>{ if(typeof v==='number' && !Number.isFinite(v)) throw new FrameError('Nonfinite number'); return v; });
  if(text===undefined) throw new FrameError('Not JSON');
  parseJson(text);
  const data=Buffer.from(text); if(data.length<1 || data.length>MAX_FRAME) throw new FrameError('Invalid frame length');
  const frame=Buffer.allocUnsafe(4+data.length); frame.writeUInt32BE(data.length); data.copy(frame,4); return frame;
}
export class FrameDecoder {
  private pending: Buffer=Buffer.alloc(0);
  partialSince: number | undefined;
  feed(chunk: Uint8Array, deliver: (message: unknown)=>void): void {
    this.pending=Buffer.concat([this.pending,chunk]);
    while(this.pending.length>=4) {
      const length=this.pending.readUInt32BE(0);
      if(length===0 || length>MAX_FRAME) throw new FrameError('Invalid frame length');
      if(this.pending.length<4+length) break;
      const bytes=this.pending.subarray(4,4+length); this.pending=this.pending.subarray(4+length);
      let text: string; try { text=new TextDecoder('utf-8',{fatal:true}).decode(bytes); } catch { throw new FrameError('Invalid UTF-8'); }
      deliver(parseJson(text));
      this.partialSince=undefined;
    }
    if(this.pending.length && this.partialSince===undefined) this.partialSince=Date.now();
    if(!this.pending.length) this.partialSince=undefined;
  }
  checkDeadline(now=Date.now()): void { if(this.partialSince!==undefined && now-this.partialSince>=10_000) throw new FrameError('Frame deadline exceeded'); }
}
