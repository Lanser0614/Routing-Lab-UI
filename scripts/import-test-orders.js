import fs from 'node:fs';
import path from 'node:path';
import { Repository } from '../src/repository.js';
import { fixture } from '../src/historical-scenario.js';

const filename=path.resolve('data/routing-lab.sqlite');
const repository=new Repository(filename);
const backup=path.resolve(`data/backups/routing-lab-before-import-${Date.now()}.sqlite`);
fs.mkdirSync(path.dirname(backup),{recursive:true});
repository.db.exec(`VACUUM INTO '${backup.replaceAll("'","''")}'`);
const data=fixture();
const result=repository.importOrders(data.orders);
console.log(JSON.stringify({imported:data.orders.length,total:result.orders.length,
  provider:result.settings.matrixProvider,backup}));
repository.db.close();
