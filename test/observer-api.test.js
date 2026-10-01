import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Repository} from '../src/repository.js';
import {createApp} from '../server.js';
test('observer API blocks input writes, exposes readiness and allows local calculation',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'observer-api-'));
  const repo=new Repository(path.join(dir,'live.sqlite'),{observer:true});
  const state={mode:'observer',streams:{orders:{connected:true},couriers:{connected:false}}};
  const server=createApp(repo,{observer:{status:()=>state}}).listen(0,'127.0.0.1');
  await new Promise(r=>server.once('listening',r));
  t.after(async()=>{await new Promise(r=>server.close(r));repo.db.close();fs.rmSync(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  for(const [url,method] of [['orders','POST'],['couriers/7','PATCH'],['orders/7','DELETE'],['settings','PATCH'],['test-orders','POST']]) {
    const res=await fetch(`${base}/api/v1/${url}`,{method,headers:{'content-type':'application/json'},body:method==='DELETE'?undefined:'{}'});
    assert.equal(res.status,403);
  }
  assert.equal((await fetch(`${base}/health`)).status,503);
  state.streams.couriers.connected=true;
  assert.equal((await fetch(`${base}/health`)).status,200);
  assert.equal((await fetch(`${base}/api/v1/bootstrap`).then(r=>r.json())).observer.mode,'observer');
  assert.equal((await fetch(`${base}/api/v1/runs`,{method:'POST'})).status,200);
});
