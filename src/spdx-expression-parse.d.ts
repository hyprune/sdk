declare module 'spdx-expression-parse' {
 /** Parse an SPDX licence expression; throws when it is invalid. */
 export default function parse(expression:string):unknown;
}
