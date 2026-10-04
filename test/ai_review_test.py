import csv
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

spec = importlib.util.spec_from_file_location('ai_review', Path(__file__).resolve().parents[1] / 'scripts/review-ai-natural.py')
review = importlib.util.module_from_spec(spec)
spec.loader.exec_module(review)

class ReviewTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.root = Path(self.tmp.name)
        self.output = self.root / 'review.csv'; rows = []; scores = {}
        for bucket in ['short', 'medium', 'long']:
            for i in range(20):
                sid = f'{bucket}-{i}'
                rows.append(dict(id=sid, base='原文', output='候选', accepted_text='候选', frontend_text='原文', bucket=bucket,
                                 kind='normal' if i < 10 else 'problem', model='model', model_root='/model',
                                 prompt_version='version', policy_hash='hash', model_requested=True, generation_complete=True))
                scores[sid] = dict(facts_preserved=True, acceptable=True, normal_mischange=False)
        self.results = self.root / 'results.jsonl'; self.results.write_text('\n'.join(json.dumps(r) for r in rows))
        self.reviews = self.root / 'scores.json'; self.reviews.write_text(json.dumps(scores))
        review.export(SimpleNamespace(results=self.results, reviews=self.reviews, output=self.output))
    def tearDown(self): self.tmp.cleanup()
    def change(self, sid, **patch):
        with self.output.open(encoding='utf-8-sig', newline='') as f: rows = list(csv.DictReader(f))
        next(r for r in rows if r['ID'] == sid).update(patch)
        with self.output.open('w', encoding='utf-8-sig', newline='') as f:
            w = csv.DictWriter(f, fieldnames=review.FIELDS); w.writeheader(); w.writerows(rows)
    def run_gate(self): return review.review(SimpleNamespace(csv=self.output))
    def test_ai_source_is_explicit_and_human_correction_can_fail_gate(self):
        self.assertEqual(self.run_gate(), 0)
        report = json.loads(self.output.with_suffix('.acceptance.json').read_text())
        self.assertEqual(report['ai_reviewed'], 60); self.assertEqual(report['human_reviewed'], 0)
        self.change('long-19', **{'人工关键事实无误': 'no', '人工问题已有效整理': 'no', '人工正常句误改': 'no', '人工校对人': 'reviewer'})
        self.assertEqual(self.run_gate(), 2)
    def test_source_and_ai_scores_are_immutable(self):
        self.change('medium-1', **{'候选文本': 'tampered'})
        with self.assertRaises(AssertionError): self.run_gate()
    def test_partial_human_review_does_not_silently_use_ai_scores(self):
        self.change('medium-1', **{'人工关键事实无误': 'yes'})
        self.assertEqual(self.run_gate(), 2)
    def test_no_normal_mischange_and_separate_medium_long_gates(self):
        for i in [18, 19]:
            self.change(f'long-{i}', **{'人工关键事实无误': 'yes', '人工问题已有效整理': 'no', '人工正常句误改': 'no', '人工校对人': 'reviewer'})
        self.assertEqual(self.run_gate(), 2)

    def test_candidate_quality_is_separate_from_guard_and_blocked_candidate_prevents_cutover(self):
        rows = [json.loads(s) for s in self.results.read_text().splitlines()]
        for row in rows:
            if row['bucket'] == 'long': row['degraded'] = 'fidelity:protected_changed'
        self.results.write_text('\n'.join(json.dumps(r) for r in rows))
        scores = json.loads(self.reviews.read_text())
        self.reviews.write_text(json.dumps(scores))
        review.export(SimpleNamespace(results=self.results, reviews=self.reviews, output=self.output))
        self.assertEqual(self.run_gate(), 2)
        report = json.loads(self.output.with_suffix('.acceptance.json').read_text())
        self.assertEqual(report['groups']['long']['candidate_acceptable'], 10)
        self.assertEqual(report['groups']['long']['blocked_by_guard'], 10)

if __name__ == '__main__': unittest.main()
