const test=require('node:test'),assert=require('node:assert/strict');
const {AiNaturalFormatter,MODEL,MODEL_ROOT,PROFILE,PROMPT_VERSION,POLICY_HASH,PROMPT}=require('../src/helpers/aiNaturalFormatter');
const {screenNatural,textEdits}=require('../src/helpers/naturalFidelity');
const original='请检查 GitHub 上的 issue，如果确认之后，再删除旧文件；如果尚未确认，就保留日志和配置。';
const candidate='请检查 GitHub 上的 issue，如果确认之后，再删除旧文件；如果尚未确认，就保留日志和配置。';
function setup(contents=[candidate]){
 const calls=[];
 const fetchImpl=async(url,init)=>{
  if(url.endsWith('/models'))return{ok:true,json:async()=>({data:[{id:MODEL,root:MODEL_ROOT}]})};
  const body=JSON.parse(init.body);calls.push({url,init,body});const content=contents.shift();
  if(typeof content==='function')return content(init);
  return{ok:true,json:async()=>({model:MODEL,choices:[{finish_reason:'stop',message:{content:JSON.stringify({transcription:content})}}]})};
 };
 return{calls,formatter:new AiNaturalFormatter({fetchImpl,getApiKey:()=> 'test-private',env:{}})};
}
test('忠实使用 Handy system/user 消息和结构化输出协议，并关闭思考',async()=>{
 const {calls,formatter}=setup();const result=await formatter.format(original);
 assert.equal(result.text,candidate);assert.equal(calls.length,1);
 const {body,init}=calls[0];assert.deepEqual(body.messages,[{role:'system',content:PROMPT.replace('${output}','').trim()},{role:'user',content:original}]);
 assert.equal(body.stream,false);assert.equal(body.reasoning_effort,'none');assert.equal(body.chat_template_kwargs.enable_thinking,false);
 assert.equal(body.response_format.type,'json_schema');assert.equal(body.response_format.json_schema.strict,true);
 assert.equal(init.headers.Authorization,'Bearer test-private');assert.equal(init.redirect,'error');
 assert.equal(JSON.stringify(result).includes('test-private'),false);
});
test('短句不调用模型；Handy 结构化返回保留在候选栏供独立审读',async()=>{
 const target='请在 GitHub 上检查 issue，并在确认之后删除旧文件。';
 const {calls,formatter}=setup([target]);
 assert.equal((await formatter.format('请检查。')).route,'short_basic');assert.equal(calls.length,0);
 const result=await formatter.format(original);
 assert.equal(calls.length,1);assert.equal(result.candidate_text,target);
 assert.equal(result.edits.length>0,true);
});
test('接口返回无效 JSON/schema、思考内容或未完成结果时回退原文',async()=>{
 for(const response of [
  {model:MODEL,choices:[{finish_reason:'stop',message:{content:'not json'}}]},
  {model:MODEL,choices:[{finish_reason:'length',message:{content:'{}'}}]},
  {model:MODEL,choices:[{finish_reason:'stop',message:{content:JSON.stringify({other:'x'})}}]},
  {model:MODEL,choices:[{finish_reason:'stop',message:{reasoning_content:'private',content:'{}'}}]},
 ]){
  const {formatter}=setup([()=>({ok:true,json:async()=>response})]);
  const result=await formatter.format(original);assert.equal(result.text,original);assert.ok(result.degraded);
 }
});
test('模型身份、凭据和安全 endpoint 仍受约束',async()=>{
 const missing=new AiNaturalFormatter({env:{},getApiKey:()=>''});assert.equal((await missing.format(original)).degraded,'natural_api_key_missing');
 const mismatch=new AiNaturalFormatter({env:{},getApiKey:()=> 'x',fetchImpl:async()=>({ok:true,json:async()=>({data:[{id:MODEL,root:'/different'}]})})});
 assert.equal((await mismatch.format(original)).degraded,'model_identity_mismatch');
 const {formatter}=setup();const evidence={passed:true,profile:PROFILE,model:MODEL,model_root:MODEL_ROOT,prompt_version:PROMPT_VERSION,policy_hash:POLICY_HASH};
 assert.equal(formatter.isApproved(evidence),true);assert.equal(formatter.isApproved({...evidence,policy_hash:'stale'}),false);
 assert.throws(()=>new AiNaturalFormatter({env:{CAPSWRITER_NATURAL_ENDPOINT:'http://example.com/v1/chat/completions'}}));
});
test('输出差异可重建，程序保真限制独立于原始模型候选',()=>{
 const a='嗯，请看 issue。不要删除日志。',b='请看 issue，不要删除日志。';let rebuilt=a;
 for(const e of [...textEdits(a,b)].reverse())rebuilt=rebuilt.slice(0,e.start)+e.after+rebuilt.slice(e.end);
 assert.equal(rebuilt,b);assert.equal(screenNatural('可能存在旧文件。','存在旧文件。').reason,'uncertainty_changed');
});
