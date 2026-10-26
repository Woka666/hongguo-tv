const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {install}=require('../webos/app/webos-audio');
function fixture(saved){
 const counters={contexts:0,workers:0,observers:0,controllers:0,destroyed:0},storage=new Map(saved?[['hongguo-webos-audible-speed',saved]]:[]),listeners={};let options,rate=1,muted=false;
 function Media(){this.nativeRate=1;this.nativeDefault=1;this.nativeMuted=false;this.src='/minireel-proxy/media/'+('1'.repeat(24))+'.mp4';this.events={};}
 for(const [name,field] of [['playbackRate','nativeRate'],['defaultPlaybackRate','nativeDefault'],['muted','nativeMuted']])Object.defineProperty(Media.prototype,name,{configurable:true,get(){return this[field]},set(v){this[field]=v}});
 const video=new Media();video.getAttribute=()=>video.src;video.addEventListener=(name,cb)=>video.events[name]=cb;video.dispatchEvent=()=>{};
 const doc={hidden:false,querySelector:()=>video,addEventListener(){},createEvent:()=>({initCustomEvent(){}})};
 const win={HongguoWebOS:{mediaPath:v=>v},HTMLMediaElement:Media,AudioContext:function(){counters.contexts++;},OfflineAudioContext:function(){},Worker:function(){counters.workers++;},
  MutationObserver:function(){counters.observers++;this.observe=()=>{};this.disconnect=()=>{counters.observers--;};},localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},addEventListener:(name,cb)=>listeners[name]=cb,
  HongguoWebOSAudioController:{create(o){counters.controllers++;options=o;return{getRate:()=>rate,setRate:v=>{rate=v;},getMuted:()=>muted,setMuted:v=>{muted=v;},sourceChanged(){},foregroundChanged(){},event(){},diagnostics:()=>({phase:'idle'}),destroy(){counters.destroyed++;o.setNativeRate(1);o.setNativeMuted(muted);}}}}};
 const api=install(win,doc);return{win,doc,video,api,storage,counters,listeners,get options(){return options;}};
}
test('default off does not override video, construct contexts/workers, or issue audio requests',()=>{
 const f=fixture();assert.equal(f.api.isEnabled(),false);assert.deepEqual(f.counters,{contexts:0,workers:0,observers:0,controllers:0,destroyed:0});
 for(const k of ['playbackRate','defaultPlaybackRate','muted'])assert.equal(Object.hasOwn(f.video,k),false);
 f.video.playbackRate=1.5;f.video.events.play();assert.equal(f.video.playbackRate,1.5);assert.equal(f.api.diagnostics().phase,'disabled');
});
test('one persistent switch enables lazily and disabling restores original descriptors without reloading video',()=>{
 const f=fixture();const src=f.video.src;assert(f.api.choose(true));assert.equal(f.storage.get('hongguo-webos-audible-speed'),'1');assert.equal(f.api.isEnabled(),true);assert.equal(f.counters.contexts,0);
 assert(Object.hasOwn(f.video,'playbackRate'));f.api.chooseSpeed(2);assert.equal(f.video.playbackRate,2);
 assert(f.api.choose(false));assert.equal(f.api.isEnabled(),false);assert.equal(f.counters.destroyed,1);assert.equal(f.counters.observers,0);assert.equal(f.video.src,src);assert.equal(f.video.playbackRate,1);assert(!Object.hasOwn(f.video,'playbackRate'));
 const restored=fixture('1');assert.equal(restored.api.isEnabled(),true);restored.api.choose(false);
});
test('storage failure and non-webOS never enable a partially applied route',()=>{
 const f=fixture();f.win.localStorage.setItem=()=>{throw Error('quota')};assert.equal(f.api.choose(true),false);assert.equal(f.counters.controllers,0);
 const other=fixture();delete other.win.HongguoWebOS;assert.equal(install(other.win,other.doc),null);assert.equal(other.counters.controllers,0);
});
test('binary transport cancellation works without AbortController and decoder work never queues',async()=>{
 const f=fixture();f.api.choose(true);let xhr;
 f.win.XMLHttpRequest=function(){xhr=this;this.open=()=>{};this.send=()=>{};this.abort=()=>{this.aborted=true;if(this.onabort)this.onabort();};this.getResponseHeader=()=>null;};
 const c=f.options.createAbort(),pending=f.options.requestAudio('/minireel-proxy/media/'+('1'.repeat(24))+'.mp4',c.signal);c.abort();await assert.rejects(pending,{code:'WEBOS_AUDIO_CANCELLED'});assert.equal(xhr.aborted,true);
 let complete;f.win.OfflineAudioContext.prototype.decodeAudioData=function(_,ok){complete=ok;};
 let current=true;const decoding=f.options.decode(new ArrayBuffer(3),()=>current);assert.equal(f.options.decoderBusy(),true);
 await assert.rejects(f.options.decode(new ArrayBuffer(3),()=>true),{code:'WEB_AUDIO_DECODER_BUSY'});current=false;complete({numberOfChannels:1,length:10,getChannelData:()=>new Float32Array(10)});assert.equal(await decoding,null);assert.equal(f.options.decoderBusy(),false);f.api.choose(false);
});
const source=fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'),'utf8');
test('other platform bundles do not load the webOS audio scripts',()=>{
 const html=fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/index.html'),'utf8');assert(!/src=["'][^"']*webos-(audio|wsola)/.test(html));
});
test('webOS audible speed settings stay hidden and clear old enabled state; other platforms leave it hidden',()=>{
 const a=source.indexOf('  var webosAudio = webosShell'),body=source.slice(a,source.indexOf('  var licenses =',a));let enabled=true,disabled=0,cardHidden=false;
 const toggle={tabIndex:0,setAttribute(){}};
 const card={classList:{add(name){if(name==='is-hidden')cardHidden=true;}}};
 const c={webosShell:true,window:{HongguoWebOSAudio:{supported:true,isEnabled:()=>enabled,choose:v=>{if(!v)disabled++;enabled=v;return true;}}},document:{getElementById:id=>id==='webos-audio-toggle'?toggle:card}};
 vm.runInNewContext(body,c);assert.equal(cardHidden,true);assert.equal(disabled,1);assert.equal(enabled,false);assert.equal(toggle.tabIndex,-1);
 vm.runInNewContext(body,{webosShell:false,window:{},document:{getElementById(){throw Error('other platform touched')}}});
});
test('actual remote focus graph enters the experiment and returns from update controls',()=>{
 const cinema={},audio={},updates={},sidebar={};const c={coreConnectionModalOpen:false,scanModalOpen:()=>false,supportModalOpen:false,confirmOpen:false,rankFilterOpen:false,playerOptionsOpen:false,detailModalOpen:false,discussionOpen:false,
 zoneOf:n=>n===cinema?'autoCinema':n===audio?'webosAudio':'appUpdates',firstVisible:s=>({'.webos-audio-action':audio,'.auto-cinema-action':cinema,'.app-update-action':updates})[s]||null,activeSidebar:()=>sidebar};
 const a=source.indexOf('  function moveFrom(');vm.runInNewContext(source.slice(a,source.indexOf('  function accountKeypadOpen(',a)),c);
 assert.equal(c.moveFrom(cinema,'down'),audio);assert.equal(c.moveFrom(audio,'up'),cinema);assert.equal(c.moveFrom(audio,'down'),updates);assert.equal(c.moveFrom(updates,'up'),audio);assert.equal(c.moveFrom(audio,'left'),sidebar);
});
