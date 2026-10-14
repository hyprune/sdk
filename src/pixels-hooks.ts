// Module resolution hook for `hyprune object import`: glTF-Transform's functions import
// ndarray-pixels, whose Node build imports sharp (native). Resolve it to ndarray-pixels.ts.
export async function resolve(specifier: string, context: unknown, next: (s: string, c: unknown) => Promise<unknown>): Promise<unknown> {
 if (specifier === 'ndarray-pixels') return {url: new URL('./ndarray-pixels.js', import.meta.url).href, shortCircuit: true};
 return next(specifier, context);
}
