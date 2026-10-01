import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Repository } from './src/repository.js';
import { prepareTestScenario, calculateTestScenario } from './src/historical-scenario.js';
import { matrixClientFromEnv } from './src/yandex-matrix.js';
import { problem } from './src/domain.js';
import { BRANCH } from './src/branch.js';
import { KafkaObserver, observerConfig } from './src/kafka-observer.js';

const root = path.dirname(fileURLToPath(import.meta.url));

export function createApp(repository, { matrixClient=null, observer=null }={}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  if(observer) app.use('/api/v1',(req,res,next)=>{
    if(req.method!=='GET' && req.path!=='/runs') return next(problem(403,'OBSERVER_READ_ONLY','Kafka: режим наблюдения, изменение входных данных отключено'));
    next();
  });
  const route = handler => async (req, res, next) => { try { const value = await handler(req, res); if (value !== undefined && !res.headersSent) res.json(value); } catch (error) { next(error); } };
  const withMatrix = async snapshot => {
    if (snapshot.settings?.matrixProvider==='local') return snapshot;
    if (!matrixClient && snapshot.settings?.matrixProvider==='yandex') throw problem(503,'MATRIX_KEY_MISSING','Яндекс Matrix не подключён: проверьте ключ и настройки сервера');
    if (!matrixClient && snapshot.settings?.matrixMode==='economy') throw problem(503,'MATRIX_KEY_MISSING','Экономный режим требует подключённую Яндекс Matrix');
    return matrixClient ? {...snapshot,roadMatrix:await matrixClient.forSnapshot(snapshot)} : snapshot;
  };
  const testScenario = async (at,settings,range) => calculateTestScenario(await withMatrix(prepareTestScenario(at,settings,range)));

  app.get('/health', route((req,res) => {
    const kafka=observer?.status();
    const ready=!observer || Object.keys(kafka.streams).length===2 && Object.values(kafka.streams).every(s=>s.connected);
    res.status(ready?200:503);
    return {status:ready?'ok':'not_ready',storage:'sqlite',kafka,matrixProvider:matrixClient?'YANDEX_DISTANCE_MATRIX':'LOCAL_DETERMINISTIC'};
  }));
  app.post('/api/v1/test-orders', route(async req => ({ ...await testScenario(req.body.at, req.body.settings, req.body.range), branch: BRANCH })));
  app.get('/api/v1/test-orders', route(async req => ({ ...await testScenario(req.query.at, {}, req.query.range), branch: BRANCH })));
  app.get('/api/v1/bootstrap', route(() => ({...repository.bootstrap(),observer:observer?.status()||null})));
  app.get('/api/v1/observer',route(()=>observer?.status()||{mode:'manual'}));
  app.get('/api/v1/buckets',route(()=>repository.buckets()));
  app.post('/api/v1/orders', route(req => repository.upsertOrder(req.body.id, req.body, true)));
  app.patch('/api/v1/orders/:id', route(req => repository.upsertOrder(req.params.id, req.body, false)));
  app.post('/api/v1/orders/:id/status', route(req => repository.setOrderStatus(req.params.id, req.body.status, req.body.reason)));
  app.delete('/api/v1/orders/:id', route(req => repository.deleteOrder(req.params.id)));
  app.get('/api/v1/orders/:id/history', route(req => repository.history('order', req.params.id)));
  app.post('/api/v1/couriers', route(req => repository.upsertCourier(req.body.id, req.body, true)));
  app.patch('/api/v1/couriers/:id', route(req => repository.upsertCourier(req.params.id, req.body, false)));
  app.post('/api/v1/couriers/:id/status', route(req => repository.setCourierStatus(req.params.id, req.body.status, req.body.reason)));
  app.get('/api/v1/couriers/:id/history', route(req => repository.history('courier', req.params.id)));
  app.patch('/api/v1/settings', route(req => repository.updateSettings(req.body)));
  app.post('/api/v1/runs', route(async () => repository.saveRun(await withMatrix(repository.snapshot()))));
  app.locals.calculate=async()=>repository.saveRun(await withMatrix(repository.snapshot()));
  app.get('/', (req, res) => res.sendFile(path.join(root, 'Routing Lab.dc.html')));
  app.get('/support.js', (req, res) => res.sendFile(path.join(root, 'support.js')));
  app.get('/leaflet-map.js', (req, res) => res.sendFile(path.join(root, 'leaflet-map.js')));

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.status || 500;
    res.status(status).type('application/problem+json').json({
      type: `https://routing-lab.local/problems/${error.code || 'INTERNAL_ERROR'}`,
      title: error.code || 'INTERNAL_ERROR', status,
      detail: status === 500 ? 'Внутренняя ошибка сервера' : error.detail || error.message,
      errors: error.errors || []
    });
    if (status === 500) console.error(error);
  });
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config=observerConfig();
  const repository = new Repository(path.resolve(root,process.env.SQLITE_PATH || (config.enabled?'data/observer.sqlite':'data/routing-lab.sqlite')), {observer:config.enabled});
  let dirty=true,calculating=false;
  const observer=config.enabled?new KafkaObserver(repository,config,()=>{dirty=true;}):null;
  const app = createApp(repository, { matrixClient: matrixClientFromEnv(),observer });
  const port = Number(process.env.PORT || 3000);
  const server=app.listen(port, () => console.log(`Routing Lab: http://localhost:${port}${observer?' · Kafka observer':''}`));
  const timer=observer?setInterval(async()=>{
    if(calculating) return;
    calculating=true;
    try {if(dirty || observer.status().streams.orders?.connected) {dirty=false;await app.locals.calculate();}}
    catch {dirty=true;console.error('Observer calculation failed');}
    finally {calculating=false;}
  },15000):null;
  if(observer) observer.start().catch(()=>{console.error('Kafka startup failed: check brokers/authentication; stopping server');shutdown(1);});
  let stopping=false;
  async function shutdown(code=0) {if(stopping)return;stopping=true;clearInterval(timer);await observer?.stop();server.close(()=>{repository.db.close();process.exit(code);});}
  process.on('SIGTERM',()=>shutdown());process.on('SIGINT',()=>shutdown());
}
