const test = require('node:test');
const assert = require('node:assert/strict');
const { SpeechJobs } = require('../src/helpers/speechJobs');
const { HotRuleReplacer } = require('../src/helpers/hotRuleReplace');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function setup(format, approved = true) {
  const rows = new Map(); let next = 1;
  const database = {
    createSpeechRecord: (id, text) => { if (!rows.has(id)) rows.set(id, { id: next++, raw_text: text, text, delivery_state: 'not_delivered' }); return rows.get(id); },
    updateSpeechRecord: (id, patch) => { if (rows.has(id)) Object.assign(rows.get(id), patch); },
    getTranscriptionById: id => [...rows.values()].find(row => row.id === id),
    markSpeechDelivery: (id, text, mode, ms) => { if (rows.has(id)) Object.assign(rows.get(id), { delivered_text: text, delivery_state: mode, delivery_ms: ms }); },
  };
  const polisher = { polish: async text => ({ text: text.replace('git hub', 'GitHub'), stages: [], corrected_text: text.replace('git hub', 'GitHub') }), naturalFormatter: { format } };
  return { jobs: new SpeechJobs({ polisher, database, approved: () => approved }), rows };
}
const formatted = text => ({ text, changed: true, degraded: null, elapsed_ms: 10 });

test('期限从松键计算；迟到结果只更新对应历史，交付始终只有一次', async () => {
  const task = deferred(), { jobs, rows } = setup(() => task.promise);
  const p = jobs.run('git hub 项目',{sessionId:'a',stoppedAtMs:Date.now()-1980},7);
  const output = await p; assert.equal(output.text,'GitHub 项目'); assert.equal(output.degraded,'background_pending');
  let pasted = 0;
  const action = async text => { pasted++; assert.equal(text,'GitHub 项目'); await sleep(5); return {success:true,mode:'pasted'}; };
  await Promise.all([jobs.deliver('a',7,action),jobs.deliver('a',7,action)]);
  task.resolve(formatted('GitHub 项目。')); await jobs.jobs.get('a').work;
  assert.equal(pasted,1); assert.equal(rows.get('a').delivered_text,'GitHub 项目'); assert.equal(rows.get('a').processed_text,'GitHub 项目。');
  assert.equal(await jobs.run('duplicate',{sessionId:'a'},7),output);
  jobs.dispose();
});
test('ASR 超过两秒立即交付基础文本；验收未通过即使模型及时完成也不自动交付', async () => {
  const task=deferred(), a=setup(()=>task.promise);
  const r=await a.jobs.run('git hub',{sessionId:'a',stoppedAtMs:Date.now()-4000},1);
  assert.equal(r.text,'GitHub'); assert.ok(r.frontend_ms<100);
  task.resolve(formatted('GitHub。')); await a.jobs.jobs.get('a').work;
  const b=setup(async()=>formatted('整理结果'),false);
  const r2=await b.jobs.run('基础文本',{sessionId:'b'},1); assert.equal(r2.text,'基础文本'); assert.equal(r2.degraded,'model_unverified'); await b.jobs.jobs.get('b').work; assert.equal(b.rows.get('b').processed_text,'整理结果');
});
test('新输入抢占、取消、删除后晚回调不得复活记录或覆盖状态', async () => {
  const old=deferred(); let call=0;
  const {jobs,rows}=setup(()=>++call===1?old.promise:Promise.resolve(formatted('新输入。')));
  await jobs.run('旧输入',{sessionId:'old',stoppedAtMs:Date.now()-3000},1);
  await jobs.run('新输入',{sessionId:'new'},1);
  assert.equal(rows.get('old').processing_status,'preempted');
  rows.delete('old'); old.resolve(formatted('旧输入。')); await jobs.jobs.get('old').work;
  assert.equal(rows.has('old'),false);
  assert.equal((await jobs.deliver('old',1,()=>assert.fail('late delivery'))).success,false);
  jobs.cancel('new'); assert.equal((await jobs.deliver('new',1,()=>assert.fail('cancelled delivery'))).success,false);
});
test('后台重试不抢占前台；发送者销毁取消推理；取消失败回调不覆盖状态',async()=>{
  const wait=deferred(); const {jobs,rows}=setup(()=>wait.promise);
  const p=jobs.run('当前输入',{sessionId:'live'},5); await sleep(2);
  assert.equal((await jobs.run('旧输入',{sessionId:'retry',backgroundOnly:true},6)).success,false);
  jobs.cancelOwner(5); wait.resolve(formatted('迟到')); await p;
  assert.equal(rows.get('live').processing_status,'cancelled');
});
test('正则工作进程复用；灾难回溯超时后重建且后续请求正常', async () => {
  const rules=new HotRuleReplacer();
  try {
    rules.load('foo = bar'); assert.equal((await rules.applyAsync('foo')).text,'bar'); const pid=rules.worker.pid;
    assert.equal((await rules.applyAsync('foo foo')).text,'bar bar'); assert.equal(rules.worker.pid,pid);
    rules.load('(a+)+$ = b'); assert.equal((await rules.applyAsync('a'.repeat(40)+'!',{timeoutMs:20})).error,'rule_timeout');
    rules.load('foo = bar'); assert.equal((await rules.applyAsync('foo')).text,'bar'); assert.notEqual(rules.worker.pid,pid);
  } finally { rules.dispose(); }
});
test('选中词组与近期确认词形成快照，强权重必须明确且可回退',()=>{
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  const {HotWordsStore}=require('../src/platform/electron/hotWordsStore');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'caps-groups-'));
  try {
    const original='GitHub|11\nTailscale|8\n其他词|5\n'; fs.writeFileSync(path.join(dir,'hot-words.txt'),original);
    const store=new HotWordsStore({dataDirectory:dir});
    const old=store.snapshot(); assert.match(old.hotword,/GitHub\|11/);
    const selected=store.configure({activeGroups:['coding'],managedWeights:true});
    assert.deepEqual(selected.terms,['GitHub']); assert.equal(selected.hotword,'GitHub|5');
    store.update({term:'Tailscale',weight:11,strong:true,group:'network'});
    assert.match(store.snapshot().hotword,/Tailscale\|11/);
    assert.equal(store.entriesForVersion(old.version).find(e=>e.term==='Tailscale').weight,8);
    const persisted=new HotWordsStore({dataDirectory:dir}); assert.equal(persisted.managedWeights,true);
    assert.equal(persisted.configure({managedWeights:false}).entries.find(e=>e.term==='GitHub').weight,11);
    assert.equal(fs.readFileSync(path.join(dir,'hot-words.txt'),'utf8'),original);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
test('确认只结束前台等待，后台继续；ASR 阶段已确认则不再等模型',async()=>{
  const task=deferred();const {jobs,rows}=setup(()=>task.promise);
  const waiting=jobs.run('基础结果',{sessionId:'confirm'},9);await sleep(1);
  jobs.finishWaitingForOwner(9);
  const r=await waiting;assert.equal(r.degraded,'background_pending');assert.equal(jobs.jobs.get('confirm').controller.signal.aborted,false);
  task.resolve(formatted('整理结果'));await jobs.jobs.get('confirm').work;assert.equal(rows.get('confirm').processed_text,'整理结果');
  const pending=deferred(),other=setup(()=>pending.promise);
  const early=await other.jobs.run('基础结果',{sessionId:'queued',waitForModel:false},10);assert.equal(early.degraded,'background_pending');
  pending.resolve(formatted('整理结果'));await other.jobs.jobs.get('queued').work;
});
