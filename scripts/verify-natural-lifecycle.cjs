// Isolated temporary history, real local model, synthetic delivery callback only.
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const DatabaseManager=require('../src/helpers/database');
const {NaturalTextFormatter}=require('../src/helpers/naturalTextFormatter');
const {AiNaturalFormatter}=require('../src/helpers/aiNaturalFormatter');
const {TextPolisher}=require('../src/platform/electron/textPolish');
const {SpeechJobs}=require('../src/helpers/speechJobs');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'caps-lifecycle-'));
const database=new DatabaseManager();database.initialize(dir);
const profile=process.argv[2] || 'cec3';
const formatter=profile==='ai-natural'?new AiNaturalFormatter():new NaturalTextFormatter({profile,endpoint:process.argv[3],model:process.argv[4]});const polisher=new TextPolisher({dataDirectory:dir,naturalFormatter:formatter});
const jobs=new SpeechJobs({database,polisher,approved:()=>true});
(async()=>{
 try {
  assert.equal((await formatter.probe()).available,true);
  const text='请检查 nx6 上的服务，如果连接失败，不要删除 /home/nx/config.json。';
  const before=Date.now();
  const foreground=await jobs.run(text,{sessionId:'late',stoppedAtMs:Date.now()-2500},1);
  assert.equal(foreground.text,text);assert.equal(foreground.degraded,'background_pending');
  let delivered=0;
  await Promise.all([jobs.deliver('late',1,async()=>{delivered++;return {success:true,mode:'copied'};}),jobs.deliver('late',1,()=>assert.fail('duplicate'))]);
  await jobs.jobs.get('late').work;
  const row=database.getTranscriptionById(foreground.history_id);
  assert.equal(delivered,1);assert.equal(row.delivered_text,text);assert.ok(['completed','review_required','failed'].includes(row.processing_status));
  const first=await jobs.run('请检查日志。'.repeat(50),{sessionId:'old',stoppedAtMs:Date.now()-2500},1);
  const next=await jobs.run('请检查日志。',{sessionId:'next'},1);
  await jobs.jobs.get('old').work;
  assert.equal(database.getTranscriptionById(first.history_id).processing_status,'preempted');
  assert.notEqual(next.degraded,'cancelled');
  const remove=await jobs.run('请保留这些原始内容。'.repeat(40),{sessionId:'delete',stoppedAtMs:Date.now()-2500},1);
  jobs.cancel('delete','deleted');database.deleteTranscription(remove.history_id);await jobs.jobs.get('delete').work;
  assert.equal(database.getTranscriptionById(remove.history_id),undefined);
  const cancelled=await jobs.run('请保留原始内容，不要删除任何资料。'.repeat(20),{sessionId:'cancelled',stoppedAtMs:Date.now()-2500},1);
  jobs.cancel('cancelled');await jobs.jobs.get('cancelled').work;
  assert.equal((await jobs.deliver('cancelled',1,()=>assert.fail('cancelled delivery'))).success,false);
  assert.equal(database.getTranscriptionById(cancelled.history_id).processing_status,'cancelled');
  const corpus=path.join(os.homedir(),'Documents/CapsWriter-Voice-Dataset/metadata.jsonl');
  const longest=fs.readFileSync(corpus,'utf8').split('\n').filter(Boolean).map(JSON.parse).map(r=>r.raw_asr_text||r.text||'').sort((a,b)=>b.length-a.length)[0];
  const release=Date.now();const deadlineOutput=await jobs.run(longest,{sessionId:'deadline',stoppedAtMs:release},1);
  const foregroundMs=Date.now()-release;
  assert.equal(deadlineOutput.degraded,'background_pending');assert.ok(foregroundMs>=1900 && foregroundMs<2300, `foreground ${foregroundMs}`);
  await jobs.deliver('deadline',1,async()=>({success:true,mode:'copied'}));
  const frozen=database.getTranscriptionById(deadlineOutput.history_id).delivered_text;
  await jobs.jobs.get('deadline').work;
  const background=database.getTranscriptionById(deadlineOutput.history_id);
  assert.equal(background.delivered_text,frozen);assert.ok(background.processed_text || background.candidate_text);
  const result={realModel:true, profile, simulatedReleaseForegroundMs:foregroundMs, backgroundFullMs:Date.now()-release,
lateHistoryOnly:true,duplicateDeliveryBlocked:true,preemption:true,cancellation:true,lateAfterDeleteBlocked:true,elapsed_ms:Date.now()-before,
    model_status:row.processing_status,next_status:next.processing_status,synthetic_delivery:true};
  fs.mkdirSync(path.join(__dirname,'../artifacts/natural'),{recursive:true});fs.writeFileSync(path.join(__dirname,`../artifacts/natural/lifecycle-${profile}.json`),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 } finally {jobs.dispose();polisher.dispose();database.close();fs.rmSync(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
