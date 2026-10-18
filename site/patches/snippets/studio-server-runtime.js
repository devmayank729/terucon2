/* ---- Terucon server mode (added by the site build, site/patches/studio.json) ------------------------------------ */
var srSrv=await(async function(){try{if(!/^https?:$/.test(location.protocol))return null;var c=new AbortController(),t=setTimeout(function(){c.abort()},4000),r;try{r=await fetch(`/api/config`,{cache:`no-store`,signal:c.signal})}finally{clearTimeout(t)}if(!r.ok)return null;var j=await r.json();return j&&j.server===!0?j:null}catch(e){return null}})();
var srSession=srSrv&&srSrv.google&&srSrv.google.configured?{account:{projectId:srSrv.google.projectId||``,clientEmail:srSrv.google.clientEmail||(srSrv.google.mode===`api-key`?`Gemini API key`:`server credentials`)},tokenManager:{server:!0,getToken:async function(){return`server`},invalidate:function(){}}}:null;
function srSamName(){return srSrv&&srSrv.sam&&srSrv.sam.enabled&&srSrv.sam.model?srSrv.sam.model+` (server)`:`SAM server`}
function srDefaults(o,keepSize){
  if(!srSrv)return o;
  var s=srSrv.segmentation||{},m=srSrv.models||{},sam=srSrv.sam||{};
  if(m.image)o.imageModel=m.image;
  if(m.detect)o.polygonModel=m.detect;
  if(m.mask)o.maskModel=m.mask;
  if(m.insight)o.insightModel=m.insight;
  if(s.engine&&s.engine!==`auto`)o.segmentationEngine=s.engine;
  if(!keepSize&&s.analysisMaxSide)o.analysisMaxSide=Math.min(1536,s.analysisMaxSide);
  if(sam.enabled){o.samUrl=`/api/sam`;o.samKey=``}
  return o
}
function srStored(){var s=srRawSettings();if(!srSrv)return s;var v=0;try{var r=JSON.parse(window.localStorage.getItem(ft)||`null`);v=r&&r.version||0}catch(e){}if(v<4){s.segmentationEngine===`scene`&&(s.segmentationEngine=`auto`);s.analysisMaxSide===1024&&(s.analysisMaxSide=ht.analysisMaxSide)}s.version=4;return srDefaults(s,!0)}
async function srInflate(lm){
  var bin=atob(lm.data),b=new Uint8Array(bin.length);
  for(var i=0;i<bin.length;i+=1)b[i]=bin.charCodeAt(i);
  var raw=new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream(`deflate`))).arrayBuffer());
  if(lm.encoding===`zlib-u16le`){var o=new Uint16Array(raw.length>>1);for(var k=0;k<o.length;k+=1)o[k]=raw[2*k]|raw[2*k+1]<<8;return o}
  return Uint16Array.from(raw)
}
async function srTerucon(e,n){
  var sam=srSrv&&srSrv.sam;
  e.onStage&&e.onStage(`Finding surfaces with Gemini`+(sam&&sam.enabled&&sam.status===`ready`?` and SAM`:``));
  var r=await fetch(`/api/segment`,{method:`POST`,headers:{"Content-Type":`application/json`},body:JSON.stringify({image:e.imageBase64,options:{location:e.location,model:e.polygonModel,useSam:!0}}),signal:e.signal}),i=null;
  try{i=await r.json()}catch(x){i=null}
  if(!r.ok||!i||!i.labelMap)throw Error(i&&i.error&&i.error.message||`The server could not segment the photo (HTTP `+r.status+`).`);
  if(i.width!==e.width||i.height!==e.height)throw Error(`The server answered for a different image size.`);
  e.onStage&&e.onStage(`Building the surface map`);
  var lab=await srInflate(i.labelMap),c=vr(lab,i.metas.map(function(m){return{index:m.index,label:m.label,kind:m.kind,source:m.source}}),i.width,i.height);
  c.engine=`terucon`;c.model=i.engine;c.notes=(i.notes||[]).concat(n);c.samImageId=i.sam&&i.sam.imageId||``;
  return c
}
function srAutoText(){
  if(!srSession)return`No Terucon server was found, so the in-browser scene parser is used. Start the server (npm start) to use Google Cloud from your .env file, and SAM if you switch it on.`;
  var sam=srSrv.sam||{};
  return`Gemini on Google Cloud (from your .env) finds and names the surfaces, `+(sam.enabled?`SAM (`+(sam.status===`ready`?`ready`:sam.status===`error`?`not working: `+(sam.error||`see the server window`):`still loading`)+`) sharpens their edges`:`edge snapping sharpens them (SAM is off)`)+`. If that fails, the in-browser scene parser takes over.`
}
function srServerNote(){
  if(!srSrv)return location.protocol===`file:`?(0,P.jsx)(`p`,{className:`form-error`,role:`note`,children:`This page was opened straight from a file. From a file the in-browser detection tools cannot start, so surfaces come out much coarser, and your .env credentials cannot be used. Start the server (npm start in the project folder) and open http://localhost:8080/design-studio instead.`}):null;
  var g=srSrv.google||{};
  return(0,P.jsx)(`p`,{className:`form-error`,role:`note`,children:g.error?`The Terucon server could not use its Google credentials: `+g.error:`The Terucon server is running but has no Google credentials yet. Paste them into the .env file next to package.json (see .env.example), save it, then reload this page. Or use a key file here.`})
}
