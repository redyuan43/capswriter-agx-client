const test = require('node:test');
const assert = require('node:assert/strict');
const { NaturalTextFormatter, validateNatural } = require('../src/helpers/naturalTextFormatter');
const { segmentWithOffsets } = require('../src/helpers/protectedText');

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
