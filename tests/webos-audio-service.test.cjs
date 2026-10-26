const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),Module=require('node:module'),http=require('node:http');
const cancel=require('../webos/service/audio-cancel'),createService=require('../webos/service/service');
const tick=()=>new Promise(r=>setImmediate(r));
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hongguo-audio-service-')),old=process.env.HONGGUO_WEBOS_CACHE_DIR;
 process.env.HONGGUO_WEBOS_CACHE_DIR=root;
 const timers=new Map();let timerID=0;const clock={setTimeout(fn,ms){const id=++timerID;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id)};
 const stats={jobs:[],protected:0,released:0,aborted:0},file=require.resolve('../webos/service/provider'),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));const normal=m.require.bind(m);
 m.require=id=>id==='./__audio_test_clock'?clock:id==='./audio-media'?{buildBatched(_p,_l,_read,signal){return new Promise((resolve,reject)=>{const abort=()=>{stats.aborted++;reject(cancel.error(signal));};signal.addEventListener('abort',abort);stats.jobs.push({signal,resolve:value=>{signal.removeEventListener('abort',abort);resolve(value);}});});}}:id==='./audio-range'?{read(){throw Error('unexpected network')},close(){}}:id==='./media-cache'?()=>({start(){},close(){},protect(){stats.protected++;return()=>stats.released++;}}):normal(id);
 m._compile("var __clock=require('./__audio_test_clock');var setTimeout=__clock.setTimeout,clearTimeout=__clock.clearTimeout;\n"+fs.readFileSync(file,'utf8').replace('module.exports = {','module.exports = { _testSources: rangeSources,'),file);
 const provider=m.exports;
 for(const c of ['a','b','c'])provider._testSources[c.repeat(24)]={prefix:Buffer.alloc(1),length:1000};
 return{provider,stats,timers,media:'/minireel-proxy/media/'+('a'.repeat(24))+'.mp4',value:{body:Buffer.from('AAC-fixture'),duration:2,channels:2},close(){provider.closeCache();if(old===undefined)delete process.env.HONGGUO_WEBOS_CACHE_DIR;else process.env.HONGGUO_WEBOS_CACHE_DIR=old;fs.rmSync(root,{recursive:true,force:true});}};
}
test('shared preparation cancels only after the last consumer and caches a successful encoded track',async()=>{
 const f=fixture(),a=cancel.create(),b=cancel.create();
 try{
  const p=f.provider.prepareAudio(f.media,a.signal),q=f.provider.prepareAudio(f.media,b.signal);await tick();assert.equal(f.stats.jobs.length,1);
  a.abort();await assert.rejects(p,{code:'WEBOS_AUDIO_CANCELLED'});assert.equal(f.stats.jobs[0].signal.aborted,false);
  f.stats.jobs[0].resolve(f.value);assert.equal(await q,f.value);assert.equal(f.stats.released,1);
  assert.equal(await f.provider.prepareAudio(f.media),f.value);assert.equal(f.stats.jobs.length,1);
 }finally{f.close();}
});
test('all-consumer cancellation releases the lease, and new work does not inherit the cancelled task',async()=>{
 const f=fixture(),a=cancel.create(),b=cancel.create();
 try{
  const p=f.provider.prepareAudio(f.media,a.signal),q=f.provider.prepareAudio(f.media,b.signal);await tick();a.abort();b.abort();await assert.rejects(p);await assert.rejects(q);await tick();
  assert.equal(f.stats.aborted,1);assert.equal(f.stats.released,1);
  const next=f.provider.prepareAudio(f.media);await tick();assert.equal(f.stats.jobs.length,2);f.stats.jobs[1].resolve(f.value);assert.equal(await next,f.value);assert.equal(f.stats.released,2);
 }finally{f.close();}
});
test('invalid sources never resolve new media and only two audio preparations are admitted',async()=>{
 const f=fixture(),a=cancel.create(),b=cancel.create();
 try{
  await assert.rejects(f.provider.prepareAudio('https://example.test/media.mp4'),{code:'WEBOS_AUDIO_SOURCE'});
  const p=f.provider.prepareAudio(f.media,a.signal),q=f.provider.prepareAudio('/minireel-proxy/media/'+('b'.repeat(24))+'.mp4',b.signal);
  await assert.rejects(f.provider.prepareAudio('/minireel-proxy/media/'+('c'.repeat(24))+'.mp4'),{code:'WEBOS_AUDIO_BUSY'});
  a.abort();b.abort();await assert.rejects(p);await assert.rejects(q);await tick();
 }finally{f.close();}
});
test('the service deadline aborts unfinished audio and releases its protected cache lease',async()=>{
 const f=fixture();try{const p=f.provider.prepareAudio(f.media);await tick();const timer=[...f.timers.values()][0];assert.equal(timer.ms,18000);timer.fn();await assert.rejects(p,{code:'WEBOS_AUDIO_TIMEOUT'});assert.equal(f.stats.aborted,1);assert.equal(f.stats.released,1);assert.equal(f.timers.size,0);}finally{f.close();}
});
async function service(f){const s=createService({service:{register(){}},provider:f.provider,account:{},numberInput:{close(){}},updates:{},port:0});await s.ensureReady();return s;}
function request(s,method='GET'){return new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:s.address().port,method,path:'/api/v1/player/audio?media='+encodeURIComponent('/minireel-proxy/media/'+('a'.repeat(24))+'.mp4'),headers:{Origin:'null'}},res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));});req.on('error',reject);req.end();});}
async function waitFor(fn){for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,5));}throw Error('test operation not received');}
test('the real binary endpoint exposes audio metadata and HEAD cannot initiate extraction',async()=>{
 const f=fixture(),s=await service(f);
 try{
  assert.equal((await request(s,'HEAD')).status,405);assert.equal(f.stats.jobs.length,0);
  const pending=request(s);await waitFor(()=>f.stats.jobs.length===1);f.stats.jobs[0].resolve(f.value);const result=await pending;
  assert.equal(result.status,200);assert(result.body.equals(f.value.body));assert.equal(result.headers['content-type'],'audio/mp4');assert.equal(result.headers['x-hongguo-audio-duration'],'2');assert.equal(result.headers['access-control-allow-origin'],'null');assert.match(result.headers['access-control-expose-headers'],/X-Hongguo-Audio-Duration/);
 }finally{await s.shutdown();f.close();}
});
test('disconnecting an actual HTTP client cancels the service-side audio consumer',async()=>{
 const f=fixture(),s=await service(f);
 try{
  const req=http.get('http://127.0.0.1:'+s.address().port+'/api/v1/player/audio?media='+encodeURIComponent(f.media));req.on('error',()=>{});
  await waitFor(()=>f.stats.jobs.length===1);req.destroy();await waitFor(()=>f.stats.aborted===1&&f.stats.released===1);
  assert.equal(f.stats.jobs[0].signal.aborted,true);
 }finally{await s.shutdown();f.close();}
});
