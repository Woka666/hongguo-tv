const {test}=require('node:test'),assert=require('node:assert/strict'),{parse}=require('./multipart.cjs');
const spans=[{start:2,end:5},{start:90,end:92}],chunks=[Buffer.from([1,2,13,10]),Buffer.from([3,4,5])];
function fixture(options={}){const b=options.boundary||'testBoundary';return Buffer.concat([Buffer.from(options.leading?'\r\n':''),...spans.map((s,i)=>Buffer.concat([Buffer.from('--'+b+'\r\nContent-Type: audio/mp4\r\nContent-Range: bytes '+s.start+'-'+s.end+'/'+(options.total||100)+'\r\n\r\n'),chunks[i],Buffer.from('\r\n')])),Buffer.from('--'+b+'--\r\n')]);}
test('declared multipart and CDN body boundary both preserve exact bytes',()=>{for(const leading of [false,true])for(const declared of [false,true]){const r=parse(fixture({leading}),declared?'multipart/byteranges; boundary=testBoundary':'video/mp4',spans,100);assert.deepEqual(r.parts,chunks);assert.equal(r.boundary_source,declared?'CONTENT_TYPE':'BODY_FIRST_LINE');}});
test('bad lengths, missing or duplicate parts, different object lengths and extra body fail closed',()=>{
 const good=fixture();for(const bad of [good.subarray(0,good.length-5),Buffer.concat([good,Buffer.from('extra')]),fixture({total:101}),Buffer.from(good.toString('latin1').replace('bytes 90-92/100','bytes 2-5/100'),'latin1'),Buffer.from('not multipart')])assert.throws(()=>parse(bad,'video/mp4',spans,100));
 assert.throws(()=>parse(good,'multipart/byteranges; boundary=other',spans,100));assert.throws(()=>parse(good,'video/mp4',[spans[0],spans[0]],100));
 assert.throws(()=>parse(good,'video/mp4',[spans[0]],100));
});
