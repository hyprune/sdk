import {cpSync, chmodSync, existsSync, rmSync} from 'node:fs';
cpSync('vendor','dist/vendor',{recursive:true});
for (const path of ['dist/src/cli.js','dist/src/mock-cli.js']) if(existsSync(path)) chmodSync(path,0o755);


cpSync('LICENSE','dist/LICENSE');

rmSync('dist/contracts',{recursive:true,force:true});
