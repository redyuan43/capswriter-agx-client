#!/usr/bin/env python3
"""Resumable official-revision download; verifies every finished weight by SHA256."""
import concurrent.futures, hashlib, json, os, pathlib, time, urllib.request
REV = 'e6d757fa285d66b5bd7faa97f93d085dbb51aee4'
FILES = {
 'model-00001-of-00002.safetensors': (4967215360, '28acad4933be8d1d44a8ff3dcc1f2acce3ed9043a36bf9feb32c10af2fe97dc6'),
 'model-00002-of-00002.safetensors': (3077766632, 'df435b82d09456f24bb55f6e3b1be091a1af1bc970799ac07aea23686af6dd7a'),
}
ROOT = pathlib.Path(os.environ.get('CEC3_SOURCE', str(pathlib.Path.home() / 'weight/capswriter/cec3-official')))
ROOT.mkdir(parents=True, exist_ok=True)
BASE = f'https://huggingface.co/twnlp/ChineseErrorCorrector3-4B/resolve/{REV}/'
CHUNK = 4 * 1024 * 1024

# Download tokenizer/config from the same immutable revision as the weights.
for name in ['config.json','generation_config.json','tokenizer_config.json','chat_template.jinja',
 'added_tokens.json','special_tokens_map.json','model.safetensors.index.json','merges.txt','vocab.json','tokenizer.json']:
 target = ROOT / name
 if target.is_file() and target.stat().st_size: continue
 with urllib.request.urlopen(BASE + name, timeout=60) as response:
  data = response.read()
 tmp = target.with_suffix(target.suffix + '.tmp'); tmp.write_bytes(data); tmp.replace(target)


def get_chunk(task):
 name, size, start = task
 end = min(size, start + CHUNK) - 1
 target = ROOT / '.ranges' / name / str(start)
 target.parent.mkdir(parents=True, exist_ok=True)
 if target.exists() and target.stat().st_size == end - start + 1: return target
 for attempt in range(40):
  try:
   # Unique range query avoids proxy caches incorrectly reusing another range.
   req = urllib.request.Request(BASE + name + f'?range={start}&attempt={attempt}', headers={'Range': f'bytes={start}-{end}'})
   with urllib.request.urlopen(req, timeout=60) as response:
    if response.status != 206 or response.headers.get('Content-Range') != f'bytes {start}-{end}/{size}': raise ValueError('wrong byte range')
    data = response.read(end - start + 2)
   if len(data) != end - start + 1: raise ValueError('short read')
   tmp = target.with_suffix('.tmp'); tmp.write_bytes(data); tmp.replace(target)
   return target
  except Exception as exc:
   if attempt == 39: raise RuntimeError(f'{name}:{start}: {type(exc).__name__}') from None
   time.sleep(min(10, 1 + attempt))

for name, (size, expected) in FILES.items():
 target = ROOT / name
 if target.exists() and hashlib.file_digest(target.open('rb'), 'sha256').hexdigest() == expected: continue
 jobs = [(name, size, n) for n in range(0, size, CHUNK)]
 with concurrent.futures.ThreadPoolExecutor(max_workers=24) as pool:
  for index, _ in enumerate(pool.map(get_chunk, jobs), 1):
   if index % 25 == 0: print(name, round(index / len(jobs) * 100, 1), '%', flush=True)
 digest = hashlib.sha256()
 with target.with_suffix('.assembling').open('wb') as out:
  for _, _, start in jobs:
   block = (ROOT / '.ranges' / name / str(start)).read_bytes(); digest.update(block); out.write(block)
 if digest.hexdigest() != expected: raise SystemExit('SHA256 mismatch: ' + name)
 target.with_suffix('.assembling').replace(target)
 print('VERIFIED', name, expected, flush=True)
 # Remove verified chunks only; incomplete downloads remain resumable.
 for _, _, start in jobs: (ROOT / '.ranges' / name / str(start)).unlink()
(ROOT / 'revision.lock.json').write_text(json.dumps({'repository': 'twnlp/ChineseErrorCorrector3-4B', 'revision': REV, 'sha256': {k:v[1] for k,v in FILES.items()}}, indent=2))
