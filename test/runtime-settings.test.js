import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Repository} from '../src/repository.js';
import {applyRuntimeSettings} from '../src/runtime-settings.js';
test('provider environment overrides existing observer SQLite on restart without repeated version changes',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'runtime-settings-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const filename=path.join(dir,'db.sqlite');let repo=new Repository(filename,{observer:true});
  applyRuntimeSettings(repo,{MATRIX_PROVIDER:'yandex'});assert.equal(repo.scenario().settings.matrixProvider,'yandex');
  const version=repo.scenario().version;applyRuntimeSettings(repo,{MATRIX_PROVIDER:'yandex'});assert.equal(repo.scenario().version,version);
  repo.db.close();repo=new Repository(filename,{observer:true});t.after(()=>repo.db.close());
  applyRuntimeSettings(repo,{MATRIX_PROVIDER:'local'});assert.equal(repo.scenario().settings.matrixProvider,'local');
  assert.throws(()=>applyRuntimeSettings(repo,{MATRIX_PROVIDER:'invalid'}));
  applyRuntimeSettings(repo,{});assert.equal(repo.scenario().settings.matrixProvider,'local');
});
