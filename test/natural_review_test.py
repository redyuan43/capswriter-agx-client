import csv, hashlib, json, pathlib, sqlite3, subprocess, tempfile, unittest
SCRIPT=pathlib.Path(__file__).resolve().parents[1]/'scripts/natural-review.py'
class ReviewGate(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.tmp.name);self.csv=self.root/'review.csv'
  self.model=self.root/'test.gguf';self.model.write_bytes(b'isolated-test-model')
  self.rows=[];samples={}
  for i in range(111):
   row={'ID':str(i),'音频SHA256':'audio-'+str(i),'CEC3结果':'结果','ASR原文':'原文','人工正确逐字稿':'原文','关键事实无误(yes/no)':'yes','结果可接受(yes/no)':'yes','原句正常(yes/no)':'yes' if i<50 else 'no','正常句误改(yes/no)':'no','校对人':'test'}
   self.rows.append(row);samples[str(i)]={'audio_sha256':row['音频SHA256'],'output':'结果','raw':'原文'}
  self.csv.with_suffix('.manifest.json').write_text(json.dumps({'revision':'e6d757fa285d66b5bd7faa97f93d085dbb51aee4','prompt_version':'cec3-natural-v1','model_sha256':hashlib.sha256(self.model.read_bytes()).hexdigest(),'samples':samples}))
  self.db=self.root/'test.db'
  with sqlite3.connect(self.db) as c:c.execute('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT)')
 def tearDown(self):self.tmp.cleanup()
 def run_review(self,*args):
  with self.csv.open('w',encoding='utf-8-sig',newline='') as f:
   w=csv.DictWriter(f,fieldnames=list(self.rows[0]));w.writeheader();w.writerows(self.rows)
  return subprocess.run(['python3',str(SCRIPT),'import',str(self.csv),*args],capture_output=True,text=True)
 def test_missing_human_scores_never_enable(self):
  self.rows[5]['校对人']='';r=self.run_review('--enable','--database',str(self.db),'--model',str(self.model));self.assertEqual(r.returncode,2)
  with sqlite3.connect(self.db) as c:self.assertEqual(c.execute('SELECT count(*) FROM settings').fetchone()[0],0)
 def test_one_critical_error_blocks(self):
  self.rows[0]['关键事实无误(yes/no)']='no';self.assertEqual(self.run_review().returncode,2)
 def test_ninety_percent_and_two_percent_boundaries(self):
  for i in range(50,56):self.rows[i]['结果可接受(yes/no)']='no'
  self.rows[0]['正常句误改(yes/no)']='yes';self.assertEqual(self.run_review().returncode,0)
  self.rows[1]['正常句误改(yes/no)']='yes';self.assertEqual(self.run_review().returncode,2)
 def test_mismatched_model_blocks_and_success_is_audited(self):
  bad=self.root/'other.gguf';bad.write_bytes(b'wrong')
  self.assertEqual(self.run_review('--enable','--database',str(self.db),'--model',str(bad)).returncode,2)
  self.assertEqual(self.run_review('--enable','--database',str(self.db),'--model',str(self.model)).returncode,0)
  with sqlite3.connect(self.db) as c:self.assertEqual(c.execute("SELECT value FROM settings WHERE key='natural_model_approved'").fetchone()[0],'true')
  self.assertTrue(self.csv.with_suffix('.pre-acceptance.db').exists())
 def test_duplicate_or_modified_source_rejected(self):
  self.rows[1]['ID']='0';self.assertEqual(self.run_review().returncode,2)
  self.rows[1]['ID']='1';self.rows[1]['CEC3结果']='改过的';self.assertEqual(self.run_review().returncode,2)
if __name__=='__main__':unittest.main()
