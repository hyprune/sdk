declare module 'gltf-validator' {
 export function validateBytes(data:Uint8Array,options?:{uri?:string;format?:string;maxIssues?:number;writeTimestamp?:boolean;externalResourceFunction?:(uri:string)=>Promise<Uint8Array>}):Promise<{issues:{numErrors:number;numWarnings:number;messages:Array<{code:string;message:string;severity:number;pointer?:string}>}}>; 
}
