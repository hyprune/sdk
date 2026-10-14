// Assimp compiled to WebAssembly (assimpjs): the part `hyprune object import` uses.
declare module 'assimpjs' {
 interface AssimpResult {IsSuccess(): boolean; GetErrorCode(): string; FileCount(): number; GetFile(index: number): {GetPath(): string; GetContent(): Uint8Array}}
 interface Assimp {FileList: new () => {AddFile(path: string, content: Uint8Array): void}; ConvertFileList(list: unknown, format: string): AssimpResult}
 const init: () => Promise<Assimp>;
 export default init;
}
