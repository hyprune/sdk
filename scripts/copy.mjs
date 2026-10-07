import {cpSync, chmodSync, existsSync} from 'node:fs';
cpSync('vendor','dist/vendor',{recursive:true});
for (const path of ['dist/src/cli.js','dist/src/mock-cli.js']) if(existsSync(path)) chmodSync(path,0o755);

cpSync('contracts','dist/contracts',{recursive:true});
cpSync('LICENSE','dist/LICENSE');
