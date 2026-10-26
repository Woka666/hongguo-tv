const {test,after}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),crypto=require('node:crypto');
const audio=require('../webos/service/audio-range'),cancel=require('../webos/service/audio-cancel');
require('../research/webos-audio/multipart.test.cjs');
after(()=>audio.close());
async function server(handler){const s=http.createServer(handler);await new Promise(r=>s.listen(0,'127.0.0.1',r));return{source:{url:'http://127.0.0.1:'+s.address().port+'/media',etag:'"stable"',length:1000,samples:[]},close:()=>new Promise(r=>{s.close(r);s.closeAllConnections();})};}
function respond(req,res,body,mode='standard'){
 const ranges=req.headers.range.slice(6).split(',').map(x=>x.split('-').map(Number));
 res.statusCode=206;res.setHeader('ETag','"stable"');
 if(ranges.length===1){const [a,b]=ranges[0];res.setHeader('Content-Range','bytes '+a+'-'+b+'/'+body.length);return res.end(body.subarray(a,b+1));}
 res.setHeader('Content-Type',mode==='standard'?'multipart/byteranges; boundary=test':'video/mp4');
 res.end(Buffer.concat([Buffer.from(mode==='body'?'\r\n':''),...ranges.map(([a,b])=>Buffer.concat([Buffer.from('--test\r\nContent-Type: video/mp4\r\nContent-Range: bytes '+a+'-'+b+'/'+body.length+'\r\n\r\n'),body.subarray(a,b+1),Buffer.from('\r\n')])),Buffer.from('--test--\r\n')]));
}
test('actual HTTP batch reads use If-Range, preserve disjoint bytes, and support body-only boundaries',async()=>{
 const bytes=crypto.randomBytes(1000);let mode='standard',requests=0;
 const s=await server((req,res)=>{requests++;assert.equal(req.headers['if-range'],'"stable"');respond(req,res,bytes,mode);});
 try{const spans=[{start:7,end:20},{start:700,end:740}];for(mode of ['standard','body'])assert.deepEqual(await audio.read(s.source,spans),spans.map(x=>bytes.subarray(x.start,x.end+1)));assert.deepEqual(await audio.read(s.source,[spans[0]]),[bytes.subarray(7,21)]);assert.equal(requests,3);}
 finally{await s.close();}
});
test('batch decryption matches CENC at unaligned offsets',async()=>{
 const key=crypto.randomBytes(16),iv=Buffer.alloc(16),plain=crypto.randomBytes(1000),cipher=crypto.createCipheriv('aes-128-ctr',key,iv),encrypted=Buffer.concat([cipher.update(plain),cipher.final()]);
 const s=await server((req,res)=>respond(req,res,encrypted));Object.assign(s.source,{key,samples:[{offset:0,size:1000,iv}]});
 try{const spans=[{start:19,end:74},{start:517,end:579}];assert.deepEqual(await audio.read(s.source,spans),spans.map(x=>plain.subarray(x.start,x.end+1)));}finally{await s.close();}
});
test('ignored ranges, changed ETags and oversized requests fail without a full-media fallback',async()=>{
 let mode='ignored',requests=0;const s=await server((req,res)=>{requests++;if(mode==='ignored'){res.statusCode=200;res.end('ignored');}else{res.statusCode=206;res.setHeader('ETag','"changed"');res.end('x');}});
 try{await assert.rejects(audio.read(s.source,[{start:1,end:2}]),{code:'AUDIO_RANGE_UNSUPPORTED'});mode='changed';await assert.rejects(audio.read(s.source,[{start:1,end:2}]),{code:'AUDIO_SOURCE_CHANGED'});await assert.rejects(audio.read(s.source,Array.from({length:129},()=>({start:1,end:2}))),{code:'AUDIO_RANGE_SOURCE'});assert.equal(requests,2);}finally{await s.close();}
});
test('cancellation closes the real upstream request and does not retry',async()=>{
 let received,closed;const opened=new Promise(r=>received=r),ended=new Promise(r=>closed=r);let requests=0;
 const s=await server((req,res)=>{requests++;received();res.once('close',closed);});const c=cancel.create();
 try{const promise=audio.read(s.source,[{start:1,end:2}],c.signal);await opened;c.abort();await assert.rejects(promise,{code:'WEBOS_AUDIO_CANCELLED'});await Promise.race([ended,new Promise((_,reject)=>setTimeout(()=>reject(Error('request remained open')),1000).unref())]);assert.equal(requests,1);}finally{await s.close();}
});
test('a CDN returning an oversized body is disconnected at the audio response budget',async()=>{
 const s=await server((_req,res)=>{res.statusCode=206;res.setHeader('ETag','"stable"');res.end(Buffer.alloc(1024*1024+1));});
 try{await assert.rejects(audio.read(s.source,[{start:1,end:2}]),{code:'AUDIO_RANGE_LIMIT'});}finally{await s.close();}
});
