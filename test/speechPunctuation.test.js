const test = require('node:test');
const assert = require('node:assert/strict');
const { punctuationFromCandidate, punctuationBody } = require('../src/helpers/speechPunctuation');
const { NaturalTextFormatter } = require('../src/helpers/naturalTextFormatter');

test('采用真实口述的断句修复，同时保持所有字词及其顺序', () => {
  for (const [source, candidate] of [
    ['如果我确认的话。你就执行。那条指令。', '如果我确认的话，你就执行那条指令。'],
    ['如果需要。加工的话也告诉我。', '如果需要加工的话，也告诉我。'],
    ['你就把。桌面。程序。都关闭掉，并且。启动链接。', '你就把桌面程序都关闭掉，并且启动链接。'],
  ]) {
    const r = punctuationFromCandidate(source, candidate);
    assert.equal(r.ok, true); assert.equal(r.text, candidate);
    assert.equal(punctuationBody(r.text), punctuationBody(source));
  }
});
test('模型轻微改词不能进入输出；大幅删除、倒序和补充完成声明拒绝', () => {
  for (const [source, candidate] of [
    ['本地模型是兜底的。', '本地模型是到底的。'],
    ['还是要重新下吗？', '还是要重新写吗？'],
    ['我按照之前规划的切模型。', '我按照之前规划的模型。'],
    ['占用4G 显存。', '占用4G 闪存。'],
  ]) {
    const r = punctuationFromCandidate(source, candidate);
    assert.equal(r.ok, true); assert.equal(r.text, source); assert.ok(r.discarded_word_edits > 0);
  }
  for (const candidate of ['已执行，已确认。', '执行后再确认。', '完成。']) {
    assert.equal(punctuationFromCandidate('点击后确认，确认后执行。', candidate).ok, false);
  }
});
test('保留代码、路径、小数、引用和英文词间空格，不接受破坏性标点', () => {
  for (const source of ['用 /home/nx/a.js 和 1.25 GB。', '使用 foo.bar 和 --dry-run。', '不要把“确认后执行”改掉。', 'Work Buddy 项目。']) {
    const r = punctuationFromCandidate(source, source.replace(/\./g, '。').replace(/ /g, ''));
    assert.equal(r.ok, true); assert.equal(r.text, source);
  }
  assert.equal(punctuationFromCandidate('不要删除文件。','不，要删除文件。').text, '不要删除文件。');
});
test('保留疑问、不把逗号改成问号，保留正常末尾标点', () => {
  assert.equal(punctuationFromCandidate('我不太懂你的意思，是什么意思？', '我不太懂你的意思？是什么意思？').text, '我不太懂你的意思，是什么意思？');
  assert.equal(punctuationFromCandidate('是否完成？', '是否完成。').text, '是否完成？');
  assert.equal(punctuationFromCandidate('已完成。', '已完成，').text, '已完成。');
  assert.equal(punctuationFromCandidate('这是让你。我说你。切换界面。', '这是让你我说你切换界面。').text, '这是让你。我说你切换界面。');
  assert.equal(punctuationFromCandidate('不要让我的。你重启之后又不行。', '不要让我的你重启之后又不行。').text, '不要让我的。你重启之后又不行。');
  assert.equal(punctuationFromCandidate('没有上下文。他是怎么回事？', '没有上下文他是怎么回事？').text, '没有上下文。他是怎么回事？');
});
test('拒绝把多个短片段全部吞成无标点长串', () => {
  const original = '没有那种本地。一下。其他不开玩项目。然后。不需要联网，然后能调语言大模型运行的。比较有名的。多数渠道是比较高的。';
  assert.equal(punctuationFromCandidate(original, original.replace(/[。，]/g, '') + '。').reason, 'over_merged');
});
test('标点模式 SSE 使用受限策略，不经过允许改词的旧校验器', async () => {
  let request;
  const f = new NaturalTextFormatter({ profile: 'qwen-punctuation', fetchImpl: async (_url, options) => {
    request = JSON.parse(options.body);
    return { ok: true, body: (async function* () {
      yield new TextEncoder().encode('data: '+JSON.stringify({choices:[{delta:{content:'本地模型是到底的。'},finish_reason:'stop'}]})+'\n');
    })() };
  }});
  const r = await f.format('本地模型是兜底的。');
  assert.equal(r.text, '本地模型是兜底的。'); assert.equal(r.degraded, null);
  assert.equal(r.body_preserved, true); assert.equal(r.prompt_version, 'qwen-punctuation-v2');
  assert.match(request.messages[0].content, /只修复明显错误/);
  assert.equal(f.isApproved({ passed: true, prompt_version: 'cec3-natural-v1', revision: 'e6d757fa285d66b5bd7faa97f93d085dbb51aee4' }), false);
  assert.equal(f.isApproved({ passed: true, profile: 'qwen-punctuation', scope: 'natural', prompt_version: 'qwen-punctuation-v2' }), false);
});
