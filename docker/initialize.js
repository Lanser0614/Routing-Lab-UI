import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { Repository } from '../src/repository.js';
import { fixture } from '../src/historical-scenario.js';

const observer=process.env.KAFKA_OBSERVER_ENABLED==='true';
const filename=path.resolve(process.env.SQLITE_PATH || (observer?'data/observer.sqlite':'data/routing-lab.sqlite'));
if(!fs.existsSync(filename)) {
  const repository=new Repository(filename,{observer});
  try {
    if(!observer) {
      repository.importOrders(fixture().orders);
      repository.updateSettings({planningDate:'2026-10-01',planningHourFrom:13,planningHourTo:14,planningAt:'2026-10-01T13:30:00+05:00'});
      repository.createRun();
    }
    console.log(`Initialized ${observer?'Kafka observer':'fixture lab'} SQLite database`);
  } finally {repository.db.close();}
}
