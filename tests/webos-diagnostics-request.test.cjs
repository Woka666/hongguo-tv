const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'),'utf8');
const refresh = source.match(/  function refreshPlaybackDiagnostics\(\) \{[\s\S]*?\n  \}/)[0];
const media = '/minireel-proxy/media/0123456789abcdef01234567.mp4';

function request({webos=true,preparing=false,mode='range',src='http://127.0.0.1:7655'+media}={}) {
  const calls=[];
  const video={getAttribute:()=>src};
  const context={
    playerOptionsOpen:true,diagnosticEpoch:1,diagnosticRequest:null,desktopShell:false,
    activePlayback:{episode:2,mode},playbackRequest:null,playbackQuality:'',playbackTiming:[],playbackInfoRequest:preparing?{}:null,playbackAudioHold:null,
    applicationInBackground:false,applicationHidden:()=>false,rangePlaybackEnabled:()=>true,
    cancelDiagnosticRead(){},readDiagnosticEnvironment:()=>({rows:[],userAgent:''}),readDiagnosticVideo:()=>({}),renderPlaybackDiagnostics(){},
    window:webos?{HongguoWebOS:{mediaPath:()=>media}}:{},
    document:{querySelector:()=>video,getElementById:id=>id==='hero-video'?video:{classList:{contains:name=>name==='is-diagnostics'||name==='is-hidden'||name==='is-preparing-video'&&preparing}}},
    XMLHttpRequest:class {open(method,url){calls.push({method,url});}send(){}}
  };
  vm.runInNewContext(refresh+'\nrefreshPlaybackDiagnostics();',context);
  assert.equal(calls.length,1,'diagnostics sends one local read and never resolves or fetches media');
  assert.equal(calls[0].method,'GET');
  return new URL(calls[0].url,'http://local.test').searchParams.get('media');
}

test('webOS preparation reads the current job even when the previous episode src is held',()=>{
  assert.equal(request({preparing:true,mode:''}),'');
});
test('webOS attached playback reads the exact normalized media path',()=>{
  assert.equal(request(),media);
});
test('other platforms retain their existing source-specific diagnostic request',()=>{
  assert.equal(request({webos:false,preparing:true,mode:'',src:media}),media);
});
