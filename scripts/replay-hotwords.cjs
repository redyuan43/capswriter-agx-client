// Same audio / same Tencent flash API, paired old/new dictionary. This measures
// hotword sensitivity; human gold text is required before claiming ASR benefit.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),{spawnSync}=require('child_process');
const {TencentProvider}=require('../src/helpers/tencentProvider');
const {HotWordsStore}=require('../src/platform/electron/hotWordsStore');
const [metadata,dataDirectory,credentialsFile,output]=process.argv.slice(2);
if(!output) throw Error('Usage: replay-hotwords.cjs metadata.jsonl DATA_DIRECTORY CREDENTIALS_FILE OUTPUT.jsonl');
// Read credentials privately, never log URLs/headers/provider errors containing them.
const environment={}; for(const line of fs.readFileSync(credentialsFile,'utf8').split('\n')) { const m=line.match(/^Environment=([A-Z_]+)=(.*)$/); if(m) environment[m[1]]=m[2].replace(/^"|"$/g,''); }
const credentials={tencentAppId:environment.TENCENTCLOUD_APP_ID,tencentSecretId:environment.TENCENTCLOUD_SECRET_ID,tencentSecretKey:environment.TENCENTCLOUD_SECRET_KEY};
const provider=new TencentProvider({getCredentials:()=>credentials});
const store=new HotWordsStore({dataDirectory});
const baseline=store.snapshot().hotword;
store.activeGroups=['coding','hardware','network','personal'];store.managedWeights=true;
// snapshot reloads persisted preferences, so form the experimental list without writes.
const proposed=store.entries.filter(e=>e.enabled!==false && store.activeGroups.includes(e.group)).slice(0,128).map(e=>`${e.term}|${e.strong?11:5}`).join(',');
fs.mkdirSync(path.dirname(output),{recursive:true});
const done=new Set(fs.existsSync(output)?fs.readFileSync(output,'utf8').split('\n').filter(Boolean).map(s=>JSON.parse(s).id):[]);
(async()=>{
 for(const [i,line] of fs.readFileSync(metadata,'utf8').split('\n').filter(Boolean).entries()) {
  const id=crypto.createHash('sha256').update(line).digest('hex'); if(done.has(id))continue;
  const sample=JSON.parse(line), file=path.resolve(path.dirname(metadata),sample.audio_path);
  const audio=spawnSync(require('../src/helpers/ffmpegExecutable').ffmpegExecutable(),['-v','error','-i',file,'-f','mp3','-ar','16000','-ac','1','pipe:1'],{maxBuffer:20*1024*1024});
  if(audio.status!==0)throw Error('Audio conversion failed');
  const results={};
  // Alternating order reduces a consistent time/order bias.
  for(const label of i%2?['proposed','baseline']:['baseline','proposed']) {
   const start=Date.now();
   try {
    const result=await provider.flash(audio.stdout,label==='baseline'?baseline:proposed);
    results[label]={result,elapsed_ms:Date.now()-start};
   } catch { results[label]={error:'asr_request_failed',elapsed_ms:Date.now()-start}; }
  }
  fs.appendFileSync(output,JSON.stringify({id,index:i+1,audio_path:sample.audio_path,baseline_hotword:baseline,proposed_hotword:proposed,...results})+'\n');
  console.log(JSON.stringify({index:i+1,total:111,baseline:results.baseline.error||'ok',proposed:results.proposed.error||'ok'}));
  if(results.baseline.error&&results.proposed.error)throw Error('Both ASR requests failed; stopping paired replay to avoid repeated failures');
 }
})().catch(e=>{console.error(e.message);process.exitCode=1;});
