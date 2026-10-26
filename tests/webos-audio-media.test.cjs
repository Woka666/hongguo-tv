const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const audio=require('../webos/service/audio-media.js');
function box(type,payload){const p=Buffer.isBuffer(payload)?payload:Buffer.concat(payload),b=Buffer.alloc(p.length+8);b.writeUInt32BE(b.length);b.write(type,4);p.copy(b,8);return b;}
function ints(...values){const b=Buffer.alloc(values.length*4);values.forEach((v,i)=>b.writeUInt32BE(v,i*4));return b;}
function fixture({wide=false,tail=false,codec='mp4a',count=2}={}){
  const ftyp=box('ftyp',Buffer.from('isom0000isom')),a=Buffer.from('first-AAC'),b=Buffer.from('second-AAC'),v=Buffer.alloc(3000,77);
  function movie(offsets){
    const handler=type=>box('hdlr',[ints(0,0),Buffer.from(type),Buffer.alloc(12)]);
    const sample=Buffer.alloc(28);sample.writeUInt16BE(1,6);sample.writeUInt16BE(2,16);sample.writeUInt16BE(16,18);sample.writeUInt32BE(44100*65536,24);
    const stsd=box('stsd',[ints(0,1),box(codec,sample)]),stsz=box('stsz',ints(0,0,count,...Array.from({length:count},(_,i)=>i%2?b.length:a.length))),stsc=box('stsc',ints(0,1,1,1,1));
    const table=wide?box('co64',ints(0,count,...offsets.flatMap(x=>[0,x]))):box('stco',ints(0,count,...offsets));
    const mdhd=box('mdhd',ints(0,0,0,44100,88200,0));
    const track=box('trak',box('mdia',[mdhd,handler('soun'),box('minf',box('stbl',[stsd,stsz,stsc,table]))]));
    const video=box('trak',box('mdia',handler('vide')));
    return box('moov',[box('mvhd',ints(0,0,0,1000,2000)),video,track]);
  }
  let moov=movie(Array(count).fill(0));const base=ftyp.length+(tail?0:moov.length)+8;
  let at=base;const offsets=Array.from({length:count},(_,i)=>{at+=v.length;const offset=at;at+=i%2?b.length:a.length;return offset;});moov=movie(offsets);
  const mdat=box('mdat',Array.from({length:count},(_,i)=>[v,i%2?b:a]).flat()),bytes=Buffer.concat(tail?[ftyp,mdat,moov]:[ftyp,moov,mdat]);
  return {bytes,a,b,offsets};
}
test('audio export reads only AAC chunks and rewrites their offsets for an audio-only MP4',async()=>{
  for(const wide of [false,true]){
    const f=fixture({wide}),reads=[];
    const info=audio.inspect(f.bytes,f.bytes.length);
    const out=await audio.build(f.bytes,f.bytes.length,async(start,end)=>{reads.push([start,end]);return f.bytes.subarray(start,end+1);});
    assert.equal(out.duration,2);assert.equal(out.channels,2);assert.equal(out.sample_rate,44100);
    assert.deepEqual(reads,[[f.offsets[0],f.offsets[0]+f.a.length-1],[f.offsets[1],f.offsets[1]+f.b.length-1]]);
    assert(out.body.length<f.bytes.length/2);assert(!out.body.includes(Buffer.from('vide')));
    const exported=audio.inspect(out.body,out.body.length);
    assert.equal(exported.bytes,info.bytes);assert.equal(exported.spans.length,2);
    assert(out.body.subarray(exported.spans[0].start,exported.spans[0].end+1).equals(f.a));
    assert(out.body.subarray(exported.spans[1].start,exported.spans[1].end+1).equals(f.b));
  }
});
test('thousands of disjoint audio chunks use bounded batches and at most two active reads',async()=>{
  const f=fixture({count:1000});let active=0,max=0,calls=0;
  const out=await audio.buildBatched(f.bytes,f.bytes.length,async spans=>{active++;max=Math.max(max,active);calls++;assert(spans.length<=128);await new Promise(r=>setImmediate(r));active--;return spans.map(s=>f.bytes.subarray(s.start,s.end+1));});
  assert.equal(calls,8);assert.equal(max,2);assert.equal(audio.inspect(out.body,out.body.length).spans.length,1000);
  const cancel=require('../webos/service/audio-cancel').create();
  await assert.rejects(audio.buildBatched(f.bytes,f.bytes.length,async spans=>{cancel.abort();return spans.map(s=>f.bytes.subarray(s.start,s.end+1));},cancel.signal),{code:'WEBOS_AUDIO_CANCELLED'});
});
test('existing complete-file caches work with moov at either end and do not create another disk file',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hongguo-audio-file-'));
  try{
    for(const tail of [false,true]){const f=fixture({tail}),file=path.join(dir,tail?'tail.mp4':'fast.mp4');fs.writeFileSync(file,f.bytes);const out=await audio.fromFile(file);assert.equal(out.duration,2);assert(out.body.includes(f.a));}
    assert.deepEqual(fs.readdirSync(dir).sort(),['fast.mp4','tail.mp4']);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('unsupported codecs and malformed or truncated media fail before reading audio data',async()=>{
  let reads=0;const f=fixture({codec:'ac-3'});
  await assert.rejects(audio.build(f.bytes,f.bytes.length,async()=>{reads++;return Buffer.alloc(0)}),/AAC/);
  assert.equal(reads,0);assert.throws(()=>audio.inspect(Buffer.alloc(8),8));
  const good=fixture();await assert.rejects(audio.build(good.bytes,good.bytes.length,async()=>Buffer.alloc(0)),/读取不完整/);
});
