const {test}=require('node:test');
const assert=require('node:assert/strict');
const {create}=require('../webos/app/webos-wsola.js');
const sr=24000;
function sine(frequency,seconds=2){return Float32Array.from({length:sr*seconds},(_,i)=>.6*Math.sin(2*Math.PI*frequency*i/sr));}
function render(processor,frames){const out=[];while(frames>0){const n=Math.min(4096,frames);out.push(processor.render(n));frames-=n;}return out;}
function flatten(blocks,channel=0){const result=new Float32Array(blocks.reduce((n,b)=>n+b.channels[channel].length,0));let at=0;for(const b of blocks){result.set(b.channels[channel],at);at+=b.channels[channel].length;}return result;}
function frequency(data){const begin=Math.floor(data.length*.15),end=Math.floor(data.length*.85);let crossings=0;for(let i=begin+1;i<end;i++)if(data[i-1]<=0&&data[i]>0)crossings++;return crossings*sr/(end-begin);}
function rms(data){let sum=0;for(const x of data){assert(Number.isFinite(x));sum+=x*x;}return Math.sqrt(sum/data.length);}
test('WSOLA changes duration while keeping the original 440 Hz pitch across supported rates',()=>{
  const original=sine(440);
  for(const rate of [.5,.75,1,1.25,1.5,2]){
    const p=create([original],sr);p.reset(0,rate);
    const blocks=render(p,Math.round(original.length/rate)),audio=flatten(blocks);
    assert(Math.abs(frequency(audio)-440)<2,rate+' pitch '+frequency(audio));
    assert(rms(audio)>.35,rate+' amplitude');
    assert(Math.abs(blocks.at(-1).inputPosition-2)<1/sr,rate+' source clock');
  }
});
test('stereo alignment preserves opposite-phase channels without cancelling the similarity signal',()=>{
  const left=sine(330),right=Float32Array.from(left,x=>-x),p=create([left,right],sr);p.reset(0,2);
  const blocks=render(p,sr),l=flatten(blocks),r=flatten(blocks,1);
  for(let i=0;i<l.length;i++)assert(Math.abs(l[i]+r[i])<1e-6);
  assert(Math.abs(frequency(l)-330)<2);assert(rms(l)>.35);
});
test('seek resets pending overlap and tempo without playing the previous region',()=>{
  const pcm=new Float32Array(sr*2);pcm.set(sine(220,1));pcm.set(sine(660,1),sr);
  const p=create([pcm],sr);p.reset(0,2);p.render(513);p.reset(1.1,.75);
  const audio=flatten(render(p,Math.round(.6*sr)));
  assert(Math.abs(frequency(audio)-660)<3);
});
test('silence and the end of the source stay finite and work is bounded',()=>{
  const p=create([new Float32Array(sr)],sr);p.reset(0,2);
  assert.equal(rms(flatten(render(p,sr))),0);
  assert.throws(()=>p.render(0));assert.throws(()=>p.render(sr*2+1));assert.throws(()=>p.reset(0,3));
  assert.throws(()=>create([new Float32Array(2),new Float32Array(3)],sr));
});
