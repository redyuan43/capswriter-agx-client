// Real paced PCM -> Tencent -> nx6 -> ai, isolated history and synthetic delivery.
// Release is simulated at the final PCM frame; physical keyboard/paste latency is excluded.
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const {EventEmitter}=require('events');
const {spawnSync}=require('child_process');
const {TencentProvider}=require('../src/helpers/tencentProvider');
const {TencentQuota,freeSeconds}=require('../src/helpers/tencentQuota');
const {relayTencent}=require('../src/helpers/tencentRealtimeRelay');
const {HotWordsStore}=require('../src/platform/electron/hotWordsStore');
const {AiNaturalFormatter}=require('../src/helpers/aiNaturalFormatter');
const {TextPolisher}=require('../src/platform/electron/textPolish');
const {SpeechJobs}=require('../src/helpers/speechJobs');
const DatabaseManager=require('../src/helpers/database');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const [credentialsFile,output]=process.argv.slice(2);
if(!output)throw Error('Usage: verify-ai-audio-chain.cjs CREDENTIALS_FILE OUTPUT.jsonl');
const env={};
for(const line of fs.readFileSync(credentialsFile,'utf8').split('\n')){
  const m=line.match(/^Environment=([A-Z_]+)=(.*)$/);if(m)env[m[1]]=m[2].replace(/^"|"$/g,'');
}
const provider=new TencentProvider({getCredentials:()=>({tencentAppId:env.TENCENTCLOUD_APP_ID,
  tencentSecretId:env.TENCENTCLOUD_SECRET_ID,tencentSecretKey:env.TENCENTCLOUD_SECRET_KEY})});
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'caps-ai-audio-'));
const data=path.join(os.homedir(),'.config/语音转写');
// Copy settings inputs, never modify production dictionaries/history/usage ledger.
for(const name of fs.readdirSync(data))if(/^(hot-|hotwords|hotWords)/.test(name)&&fs.statSync(path.join(data,name)).isFile())fs.copyFileSync(path.join(data,name),path.join(temp,name));
const store=new HotWordsStore({dataDirectory:temp});
const quota=new TencentQuota({dataDirectory:temp});
const formatter=new AiNaturalFormatter();
const polisher=new TextPolisher({dataDirectory:temp,naturalFormatter:formatter,hotWordsStore:store});
const database=new DatabaseManager();database.initialize(temp);
const jobs=new SpeechJobs({database,polisher,approved:()=>true}); // Experimental eligibility only; no real paste.
async function recognize(pcm){
  const client=new EventEmitter();client.readyState=1;
  client.close=()=>{client.readyState=3;client.emit('close');};
  let readyResolve,doneResolve,doneReject,stopped;
  const ready=new Promise(r=>readyResolve=r);
  const done=new Promise((r,j)=>{doneResolve=r;doneReject=j;});
  // Attach a rejection handler before streaming starts.
  done.catch(()=>{});
  client.send=raw=>{const m=JSON.parse(raw);if(m.type==='ready')readyResolve();
    if(m.type==='error'){readyResolve();doneReject(Error(m.error));}
    if(m.type==='final')doneResolve({...m,stoppedAtMs:stopped,asr_ready_at_ms:Date.now()});};
  const relay=relayTencent(client,{provider,quota,snapshot:store.snapshot()});
  try{
    client.emit('message',Buffer.from(JSON.stringify({type:'start',sample_rate:16000})),false);
    await ready;
    const start=performance.now();
    for(let offset=0;offset<pcm.length;offset+=6400){
      if(client.readyState!==1)break;
      await delay(Math.max(0,start+offset/32-performance.now()));
      client.emit('message',pcm.subarray(offset,offset+6400),true);
    }
    await delay(Math.max(0,start+pcm.length/32-performance.now()));
    stopped=Date.now();
    if(client.readyState===1)client.emit('message',Buffer.from('{"type":"finish"}'),false);
    return await done;
  }finally{relay.cancel();}
}
(async()=>{
 try{
  assert.equal((await formatter.probe()).verified,true);
  // Use the same quota-based engine selection as the client.
  try{quota.observe(freeSeconds(await provider.resources()));}catch{quota.observe(null);}
  const corpus=path.join(os.homedir(),'Documents/CapsWriter-Voice-Dataset');
  const records=fs.readFileSync(path.join(corpus,'metadata.jsonl'),'utf8').split('\n').filter(Boolean).map(JSON.parse);
  for(const index of [53,67]){
    const sample=records[index-1];
    const audio=spawnSync(require('../src/helpers/ffmpegExecutable').ffmpegExecutable(),['-v','error','-i',path.join(corpus,sample.audio_path),'-f','s16le','-ar','16000','-ac','1','pipe:1'],{maxBuffer:20*1024*1024});
    assert.equal(audio.status,0);
    console.log(JSON.stringify({index,state:'streaming',audio_seconds:audio.stdout.length/32000}));
    const asr=await recognize(audio.stdout);
    const front=await jobs.run(asr.text,{sessionId:`audio-${index}`,stoppedAtMs:asr.stoppedAtMs,
      segments:asr.segments,dictionaryVersion:asr.dictionary_version},1);
    const foreground=Date.now()-asr.stoppedAtMs;
    let deliveries=0;
    await jobs.deliver(`audio-${index}`,1,async()=>{deliveries++;return{success:true,mode:'synthetic'};});
    await jobs.jobs.get(`audio-${index}`).work;
    const row=database.getTranscriptionById(front.history_id),meta=JSON.parse(row.processing_json);
    assert.equal(deliveries,1);assert.equal(row.delivered_text,front.text);
    const result={index,simulation:'paced recording end; no physical key or actual paste',engine:asr.engine,
      audio_seconds:audio.stdout.length/32000,asr_tail_ms:asr.asr_ready_at_ms-asr.stoppedAtMs,
      stop_to_synthetic_delivery_ms:foreground,front_degraded:front.degraded,asr_text:asr.text,
      delivered_text:front.text,background_text:row.processed_text||row.candidate_text,...meta};
    fs.appendFileSync(output,JSON.stringify(result)+'\n');
    console.log(JSON.stringify({index,asr_tail_ms:result.asr_tail_ms,foreground_ms:foreground,
      generation_ms:meta.generation_ms,total_ms:meta.total_ms,degraded:meta.degraded}));
  }
 }finally{jobs.dispose();polisher.dispose();database.close();fs.rmSync(temp,{recursive:true,force:true});}
})().catch(()=>{console.error('Audio chain verification failed; credentials and signed URLs omitted');process.exitCode=1;});
