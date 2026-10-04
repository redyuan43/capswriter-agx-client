#!/usr/bin/env python3
"""Export paired model results; validate human CSV before enabling automatic delivery."""
import argparse, csv, hashlib, json, pathlib, sqlite3, sys
REVISION = 'e6d757fa285d66b5bd7faa97f93d085dbb51aee4'
PROMPT_VERSION = 'cec3-natural-v1'
COLS = ['ID','音频路径','音频SHA256','长度组','ASR原文','基础文本','CEC3结果','CEC3检查','CEC3首字ms','CEC3完整ms','Qwen结果','Qwen检查','人工正确逐字稿','关键事实无误(yes/no)','结果可接受(yes/no)','原句正常(yes/no)','正常句误改(yes/no)','校对人','备注','原热词识别','分组热词识别','热词对照状态']
def file_sha256(p):
 digest=hashlib.sha256()
 with open(p,'rb') as f:
  for chunk in iter(lambda:f.read(8*1024*1024),b''):digest.update(chunk)
 return digest.hexdigest()
def read_jsonl(p): return [json.loads(x) for x in pathlib.Path(p).read_text().splitlines() if x]
def safe(value):
 value = str(value if value is not None else '')
 return "'" + value if value.startswith(('=','+','-','@')) else value

def export(args):
 cec, qwen = read_jsonl(args.cec), {r['id']:r for r in read_jsonl(args.qwen)}
 if len(cec) != 111 or len(qwen) != 111: raise ValueError('固定评测集必须完整包含 111 条')
 if len({r['id'] for r in cec}) != 111: raise ValueError('重复样本 ID')
 asr = {r['id']:r for r in read_jsonl(args.hotwords)} if args.hotwords else {}
 output = pathlib.Path(args.output); output.parent.mkdir(parents=True,exist_ok=True)
 with output.open('w',encoding='utf-8-sig',newline='') as f:
  writer=csv.DictWriter(f,fieldnames=COLS); writer.writeheader()
  for r in cec:
   other=qwen[r['id']]
   if r['audio_sha256'] != other['audio_sha256']: raise ValueError('两组音频不一致')
   values=[r['id'],str(pathlib.Path(args.audio_root)/r['audio_path']),r['audio_sha256'],r['length_bucket'],r['raw'],r['base'],r['output'],r['degraded'] or 'passed',r['first_token_ms'],r['complete_ms'],other['output'],other['degraded'] or 'passed']
   row=dict(zip(COLS,map(safe,values)))
   pair=asr.get(r['id'])
   def transcript(side):
    data=pair.get(side,{}).get('result',{}); return ''.join(x.get('text','') for x in data.get('flash_result',[]))
   if pair:
    row['原热词识别']=safe(transcript('baseline'));row['分组热词识别']=safe(transcript('proposed'))
    row['热词对照状态']='同音频 / 腾讯极速识别 / 16k_zh' if 'result' in pair.get('baseline',{}) and 'result' in pair.get('proposed',{}) else '请求失败'
   writer.writerow(row)
 manifest={'revision':REVISION,'prompt_version':PROMPT_VERSION,'model_sha256':args.model_sha256,
  'samples':{r['id']:{'audio_sha256':r['audio_sha256'],'output':safe(r['output']),'raw':safe(r['raw']),'generation_complete':r.get('generation_complete',not r['degraded'] or r['degraded'].startswith('fidelity:'))} for r in cec}}
 output.with_suffix('.manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2))
 print(json.dumps({'exported':len(cec),'csv':str(output),'quality_gate':'待人工校对'},ensure_ascii=False))

def review(args):
 source=pathlib.Path(args.csv); manifest=json.loads(source.with_suffix('.manifest.json').read_text())
 rows=list(csv.DictReader(source.open(encoding='utf-8-sig',newline='')))
 if len(rows)!=111 or len({r['ID'] for r in rows})!=111 or {r['ID'] for r in rows} != set(manifest['samples']): raise ValueError('CSV 样本不完整或存在重复/未知 ID')
 missing=[]; stats={'count':len(rows),'critical_errors':0,'problem_count':0,'problem_acceptable':0,'normal_count':0,'normal_incorrect_changes':0}
 for r in rows:
  sample=manifest['samples'][r['ID']]
  if r['音频SHA256']!=sample['audio_sha256'] or r['CEC3结果']!=sample['output'] or r['ASR原文']!=sample['raw']: raise ValueError('来源列已修改，请只填写人工评分列')
  required=COLS[12:18]
  if any(not r.get(k,'').strip() for k in required) or any(r[k].strip().lower() not in ('yes','no') for k in COLS[13:17]): missing.append(r['ID']); continue
  yes=lambda k:r[k].strip().lower()=='yes'
  stats['critical_errors']+=not yes(COLS[13])
  if yes(COLS[15]):
   stats['normal_count']+=1; stats['normal_incorrect_changes']+=yes(COLS[16])
  else:
   stats['problem_count']+=1; stats['problem_acceptable']+=yes(COLS[14]) and sample.get('generation_complete',True)
 stats['unreviewed']=len(missing)
 stats['problem_acceptable_rate']=stats['problem_acceptable']/stats['problem_count'] if stats['problem_count'] else None
 stats['normal_mischange_rate']=stats['normal_incorrect_changes']/stats['normal_count'] if stats['normal_count'] else None
 passed=not missing and stats['critical_errors']==0 and stats['problem_count']>0 and stats['normal_count']>0 and stats['problem_acceptable_rate']>=.90 and stats['normal_mischange_rate']<=.02
 report={**stats,'passed':passed,'revision':manifest['revision'],'prompt_version':manifest['prompt_version'],'model_sha256':manifest['model_sha256'],'review_sha256':hashlib.sha256(source.read_bytes()).hexdigest()}
 source.with_suffix('.acceptance.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
 if args.enable:
  if not passed: raise ValueError('验收未通过，未启用自动交付；详情见 acceptance.json')
  if manifest['revision']!=REVISION or manifest['prompt_version']!=PROMPT_VERSION: raise ValueError('模型或提示词版本与本次发布不一致')
  if not args.model or file_sha256(args.model)!=manifest['model_sha256']: raise ValueError('实际模型与评测权重不一致')
  if not args.database or not pathlib.Path(args.database).is_file(): raise ValueError('需指定现有数据库，不创建新数据库')
  con=sqlite3.connect(args.database)
  with sqlite3.connect(str(source.with_suffix('.pre-acceptance.db'))) as backup: con.backup(backup)
  with con:
   for key,value in [('natural_model_approval',report),('natural_model_approved',True)]:
    con.execute('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',(key,json.dumps(value)))
  con.close(); report['auto_delivery_enabled']=True
 print(json.dumps(report,ensure_ascii=False,indent=2))
 if not passed: sys.exit(2)

parser=argparse.ArgumentParser(description=__doc__); sub=parser.add_subparsers(dest='command',required=True)
p=sub.add_parser('export'); p.add_argument('--cec',required=True); p.add_argument('--qwen',required=True);p.add_argument('--output',required=True);p.add_argument('--audio-root',required=True);p.add_argument('--model-sha256',required=True);p.add_argument('--hotwords');p.set_defaults(run=export)
p=sub.add_parser('import');p.add_argument('csv');p.add_argument('--enable',action='store_true');p.add_argument('--database');p.add_argument('--model');p.set_defaults(run=review)
args=parser.parse_args()
try: args.run(args)
except (ValueError,KeyError) as e: print(str(e),file=sys.stderr); sys.exit(2)
