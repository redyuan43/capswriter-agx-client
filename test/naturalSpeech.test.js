const test = require('node:test');
const assert = require('node:assert/strict');
const { NaturalTextFormatter, validateNatural } = require('../src/helpers/naturalTextFormatter');
const { SpeechJobs } = require('../src/helpers/speechJobs');
const { HotRuleReplacer } = require('../src/helpers/hotRuleReplace');
const { segmentWithOffsets } = require('../src/helpers/protectedText');
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

test('自然整理允许断句、去口头语及局部语序调整', () => {
  for (const [a,b] of [['这个项目我们可以优化一下。', '我们可以优化一下这个项目。'], ['我我觉得，嗯，这个项目需要优化。', '我觉得这个项目需要优化。'], ['如果服务离线。就继续使用基础文本。', '如果服务离线，就继续使用基础文本。']]) assert.equal(validateNatural(a,b).ok, true, `${a} -> ${b}`);
});
test('拒绝技术参数、单位、路径、否定和条件变化，以及数字对应关系互换', () => {
  for (const [a,b] of [['CPU 8 GB，GPU 16 GB', 'CPU 16 GB，GPU 8 GB'], ['内存8，线程4', '线程8，内存4'], ['不要删除 /home/nx/file.txt', '删除 /home/nx/file.txt'], ['超时 2 秒', '超时 2 分钟'], ['如果离线就保留原文', '离线就保留原文'], ['禁止启用 GPU。可以启用 CPU。', '可以启用 GPU。禁止启用 CPU。']]) assert.equal(validateNatural(a,b).ok, false, `${a} -> ${b}`);
  assert.equal(validateNatural('请检查日志。','好的，我已检查日志。').ok,false);
});
test('不把原话的不确定判断整理成确定事实', () => {
  const source = '这个应该在传统的录音卡功能里面是有的。';
  assert.equal(validateNatural(source, '这个在传统的录音卡功能里面是有的。').reason, 'uncertainty_changed');
  assert.equal(validateNatural('好像是处理有点出错，有一个错误提示。', '是处理有点出错，有一个错误提示。').reason, 'uncertainty_changed');
  assert.equal(validateNatural(source, '这个功能在传统的录音卡里面应该是有的。').ok, true);
});
test('新增完成声明留在候选历史，不成为整理成功的正文', async () => {
  const source = '所有代码汇总，总结一下，提交到 GitHub 上去。';
  const candidate = '所有代码已汇总，已总结，已提交到 GitHub 上去。';
  assert.equal(validateNatural(source, candidate).reason, 'completion_claim_changed');
  const formatter = new NaturalTextFormatter({fetchImpl: async () => ({ok: true,body:(async function* () {
    yield new TextEncoder().encode('data: '+JSON.stringify({choices:[{delta:{content:candidate},finish_reason:'stop'}]})+'\n');
  })()})});
  const result = await formatter.format(source);
  assert.equal(result.text, source);
  assert.equal(result.candidate_text, candidate);
  assert.equal(result.degraded, 'fidelity:completion_claim_changed');
  assert.equal(validateNatural('代码已经提交到 GitHub。', '代码已经提交到 GitHub。').ok, true);
});
test('中英分词保持原文偏移和空格', () => {
  const input = '请检查 GitHub 的 /home/nx/test.js，不要加空格。';
  const words = segmentWithOffsets(input);
  assert.equal(words.map(w => w.text).join(''), input);
  for (const word of words) assert.equal(input.slice(word.start, word.end), word.text);
});
test('SSE 流跨 UTF-8 分片，关闭思考并使用词级停顿参考', async () => {
  let body;
  const fetchImpl = async (_url, request) => {
    body = JSON.parse(request.body);
    const bytes = new TextEncoder().encode('data: '+JSON.stringify({ choices: [{ delta: { content: '我们优化这个项目。' } }] })+'\n\ndata: '+JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })+'\n\ndata: [DONE]\n\n');
    return { ok: true, body: (async function* () { for(let i=0;i<bytes.length;i+=7) yield bytes.slice(i,i+7); })() };
  };
  const f = new NaturalTextFormatter({ fetchImpl });
  const r = await f.format('我们优化这个项目。', { segments: [{ words: [{ text: '我们', startTime: 0, endTime: 100 },{ text: '优化这个项目', startTime: 1300, endTime: 2300 }] }] });
  assert.equal(r.degraded,null); assert.equal(r.text,'我们优化这个项目。');
  assert.equal(body.chat_template_kwargs.enable_thinking,false); assert.match(body.messages[0].content,/1200/);
  assert.ok(r.first_token_ms >= 0);
});
test('不完整流、离线、超时均回退；拒绝结果仅以候选保存', async () => {
  const stream = (text, reason) => async () => ({ ok: true, body: (async function* () { yield new TextEncoder().encode('data: '+JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: reason }] })+'\n'); })() });
  assert.equal((await new NaturalTextFormatter({ fetchImpl: stream('不要删除文件','length') }).format('不要删除文件')).degraded,'incomplete_response');
  const changed = await new NaturalTextFormatter({ fetchImpl: stream('删除文件','stop') }).format('不要删除文件');
  assert.equal(changed.text,'不要删除文件'); assert.equal(changed.candidate_text,'删除文件');
  assert.equal((await new NaturalTextFormatter({ fetchImpl: async () => { throw Error('offline'); }, readStatus: () => 'request_failed' }).format('输入')).degraded,'request_failed');
  const timeout = new NaturalTextFormatter({ fetchImpl: (_url,{signal}) => new Promise((_,reject) => signal.addEventListener('abort',()=>reject(Error('abort')),{once:true})) });
  assert.equal((await timeout.format('输入',{timeoutMs:5})).degraded,'timeout');
});
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
