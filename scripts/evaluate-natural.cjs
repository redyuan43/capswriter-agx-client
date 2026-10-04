// Text replay only: never claims ASR accuracy or human semantic acceptance.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { NaturalTextFormatter } = require('../src/helpers/naturalTextFormatter');
const { TextPolisher } = require('../src/platform/electron/textPolish');
const { HotWordsStore } = require('../src/platform/electron/hotWordsStore');
const dataset = process.argv[2], dataDirectory = process.argv[3], output = process.argv[4];
if (!output) throw Error('Usage: node evaluate-natural.cjs DATASET DATA_DIRECTORY OUTPUT [URL] [MODEL]');
const endpoint = process.argv[5] || 'http://127.0.0.1:18088/v1/chat/completions';
const model = process.argv[6] || 'capswriter-cec3-4b';
const root=path.dirname(dataset); fs.mkdirSync(path.dirname(output),{recursive:true});
const store=new HotWordsStore({dataDirectory});
// Deliberately snapshot without changing the live user dictionary.
store.activeGroups=['coding','hardware','network','personal']; store.managedWeights=true;
const polisher=new TextPolisher({dataDirectory,hotWordsStore:store});
const formatter=new NaturalTextFormatter({endpoint,model});
const checksum=s=>crypto.createHash('sha256').update(s).digest('hex');
const old=fs.existsSync(output)?fs.readFileSync(output,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
const done=new Set(old.map(r=>r.id));
(async()=>{
 try {
  const lines=fs.readFileSync(dataset,'utf8').split('\n').filter(Boolean);
  for (const [index,line] of lines.entries()) {
    const sample=JSON.parse(line), id=checksum(line); if(done.has(id)) continue;
    const raw=String(sample.raw_asr_text || sample.asr_text || sample.text || '');
    const audio=path.resolve(root,sample.audio_path);
    if(!audio.startsWith(root+path.sep)||!fs.existsSync(audio)) throw Error('Missing source audio');
    const base=await polisher.polish(raw,{mode:'natural',skipModel:true});
    const segments=sample.result_payload?.segments || [];
    const result=await formatter.format(base.text,{segments,terms:store.entries.map(e=>e.term)});
    const row={id,index:index+1,audio_path:sample.audio_path,audio_sha256:checksum(fs.readFileSync(audio)),
      length_bucket:raw.length<=40?'short':raw.length<=100?'medium':'long',raw,base:base.text,
      dictionary_version:base.dictionary_version,rules_version:base.rules_version,
      model,output:result.candidate_text || result.text,validated_text:result.text,
      degraded:result.degraded,first_token_ms:result.first_token_ms,complete_ms:result.elapsed_ms,
      generation_complete:result.generation_complete === true,
      model_complete_within_2s:result.generation_complete === true && result.elapsed_ms<=2000,
      accepted_within_2s:!result.degraded && result.elapsed_ms<=2000,
      human:{gold_text:null,critical_facts_ok:null,acceptable:null,normal_input:null,reviewer:null},
      note:'Text replay, not ASR quality or measured release-to-delivery latency'};
    fs.appendFileSync(output,JSON.stringify(row)+'\n');
    console.log(JSON.stringify({model,index:index+1,total:lines.length,status:row.degraded||'completed',ms:row.complete_ms}));
  }
  const rows=fs.readFileSync(output,'utf8').trim().split('\n').map(JSON.parse);
  const percentile=(values,q)=>values.sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*q))] ?? null;
  const summary={model,count:rows.length,human_reviewed:0,quality_gate:'not_approved',note:'缺少人工音频真值，不报告可接受率或误改率；两秒率为模型文本回放，非真实松键到交付率。',buckets:{}};
  for(const bucket of ['short','medium','long','all']) {
    const selected=rows.filter(r=>bucket==='all'||r.length_bucket===bucket);
    summary.buckets[bucket]={count:selected.length,passed_guard:selected.filter(r=>!r.degraded).length,
      complete_within_2s:selected.filter(r=>r.model_complete_within_2s).length,
      accepted_within_2s:selected.filter(r=>r.accepted_within_2s).length,
      first_token_p50_ms:percentile(selected.map(r=>r.first_token_ms).filter(x=>x!=null),.5),
      complete_p50_ms:percentile(selected.map(r=>r.complete_ms),.5),complete_p95_ms:percentile(selected.map(r=>r.complete_ms),.95),
      failures:selected.reduce((a,r)=>{if(r.degraded)a[r.degraded]=(a[r.degraded]||0)+1;return a;},{})};
  }
  fs.writeFileSync(output+'.summary.json',JSON.stringify(summary,null,2));
 } finally {polisher.dispose();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
