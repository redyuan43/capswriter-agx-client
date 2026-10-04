// Recompute timing summaries with generation and validation kept separate.
const fs=require('fs');
for(const file of process.argv.slice(2)) {
 const rows=fs.readFileSync(file,'utf8').trim().split('\n').map(JSON.parse);
 for(const r of rows) {
  r.generation_complete= !r.degraded || r.degraded.startsWith('fidelity:');
  r.model_complete_within_2s=r.generation_complete && r.complete_ms<=2000;
  r.accepted_within_2s=!r.degraded && r.complete_ms<=2000;
 }
 fs.writeFileSync(file,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
 const percentile=(xs,q)=>xs.sort((a,b)=>a-b)[Math.min(xs.length-1,Math.floor(xs.length*q))]??null;
 const report={model:rows[0]?.model,count:rows.length,human_reviewed:0,quality_gate:'not_approved',note:'文本回放。完整生成、通过检查和人工可接受率是不同指标；没有测量真实松键到交付。',buckets:{}};
 for(const group of ['short','medium','long','all']) {
  const x=rows.filter(r=>group==='all'||r.length_bucket===group);
  report.buckets[group]={count:x.length,fully_generated:x.filter(r=>r.generation_complete).length,passed_guard:x.filter(r=>!r.degraded).length,
    complete_within_2s:x.filter(r=>r.model_complete_within_2s).length,accepted_within_2s:x.filter(r=>r.accepted_within_2s).length,
    first_token_p50_ms:percentile(x.map(r=>r.first_token_ms).filter(v=>v!=null),.5),
    complete_p50_ms:percentile(x.filter(r=>r.generation_complete).map(r=>r.complete_ms),.5),
    complete_p95_ms:percentile(x.filter(r=>r.generation_complete).map(r=>r.complete_ms),.95),
    failures:x.reduce((a,r)=>{if(r.degraded)a[r.degraded]=(a[r.degraded]||0)+1;return a;},{})};
 }
 fs.writeFileSync(file+'.summary.json',JSON.stringify(report,null,2));
 console.log(JSON.stringify({model:report.model,...report.buckets.all}));
}
