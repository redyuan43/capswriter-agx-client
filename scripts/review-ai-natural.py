#!/usr/bin/env python3
"""Version-bound CSV review. AI text review is explicitly separate from human review."""
import argparse
import csv
import hashlib
import json
from pathlib import Path

SOURCE = ['ID', '样本序号', '长度组', '原句类型', '音频路径', '音频SHA256', 'ASR原文', '基础文本', '候选文本', '检查后文本', '前台回放文本', '检查原因', '首字ms', '生成ms', '复核ms', '总耗时ms', '模型', '提示词版本']
RATINGS = ['关键事实无误', '问题已有效整理', '正常句误改']
FIELDS = SOURCE + ['AI' + k for k in RATINGS] + ['AI审读说明', '审读来源'] + ['人工' + k for k in RATINGS] + ['人工正确文本', '人工校对人', '人工备注']

def safe(value):
    value = str(value if value is not None else '')
    return "'" + value if value.startswith(('=', '+', '-', '@', '\t', '\r')) else value

def export(args):
    results = [json.loads(line) for line in Path(args.results).read_text().splitlines() if line.strip()]
    assert not any(r.get('experimental_prompt') for r in results), '外部提示词对照不能作为生产配置的验收证据'
    reviews = json.loads(Path(args.reviews).read_text()) if args.reviews else {}
    assert len({r['id'] for r in results}) == len(results), '重复样本'
    policies = {(r.get('model') or '', r.get('model_root'), r['prompt_version'], r['policy_hash']) for r in results if r.get('model_requested')}
    assert len(policies) == 1, '必须只有一个模型与流程版本'
    model, model_root, prompt_version, policy_hash = policies.pop()
    manifest = {'profile': 'ai-natural', 'model': model, 'model_root': model_root, 'prompt_version': prompt_version,
                'policy_hash': policy_hash, 'review_scope': 'AI text review; not audio ground truth', 'samples': {}}
    target = Path(args.output)
    with target.open('w', encoding='utf-8-sig', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=FIELDS); writer.writeheader()
        for r in results:
            values = [r['id'], r.get('sample_index'), r['bucket'], r['kind'], r.get('audio_path'), r.get('audio_sha256'),
                      r.get('raw', r['base']), r['base'], r['output'], r['accepted_text'], r['frontend_text'], r.get('degraded'),
                      r.get('first_token_ms'), r.get('generation_ms'), r.get('verification_ms'), r.get('elapsed_ms'), model, prompt_version]
            row = dict(zip(SOURCE, map(safe, values)))
            review = reviews.get(r['id'], {})
            for name, key in zip(RATINGS, ['facts_preserved', 'acceptable', 'normal_mischange']):
                row['AI' + name] = ('yes' if review[key] else 'no') if key in review else ''
            row['AI审读说明'] = safe(review.get('notes', ''))
            row['审读来源'] = 'Codex AI 文本审读，未听音' if review else '待审读'
            writer.writerow(row)
            manifest['samples'][r['id']] = {'source': {k: row[k] for k in SOURCE}, 'ai_review': {k: row.get(k, '') for k in FIELDS if k.startswith('AI')},
                                          'model_requested': bool(r.get('model_requested')), 'generation_complete': bool(r.get('generation_complete')),
                                          'accepted': not r.get('degraded')}
    target.with_suffix('.manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    print(json.dumps({'exported': len(results), 'csv': str(target)}, ensure_ascii=False))

def review(args):
    source = Path(args.csv)
    manifest = json.loads(source.with_suffix('.manifest.json').read_text())
    rows = list(csv.DictReader(source.open(encoding='utf-8-sig', newline='')))
    assert len(rows) == len(manifest['samples']) and len({r['ID'] for r in rows}) == len(rows), '样本不完整或重复'
    assert {r['ID'] for r in rows} == set(manifest['samples']), '未知样本'
    groups = {k: {'count': 0, 'normal': 0, 'problems': 0, 'candidate_acceptable': 0, 'blocked_by_guard': 0,
                 'critical_errors': 0, 'normal_mischanges': 0, 'unreviewed': 0} for k in ['short', 'medium', 'long']}
    humans = 0
    for row in rows:
        sample = manifest['samples'][row['ID']]
        assert {k: row[k] for k in SOURCE} == sample['source'], '请勿修改来源列'
        assert {k: row.get(k, '') for k in sample['ai_review']} == sample['ai_review'], '请在人工栏填写更正，不修改AI审读列'
        g = groups[row['长度组']]; g['count'] += 1
        human = any(row.get('人工' + k, '').strip() for k in RATINGS) or bool(row.get('人工校对人', '').strip())
        prefix = '人工' if human else 'AI'
        values = [row.get(prefix + k, '').strip().lower() for k in RATINGS]
        if any(v not in ('yes', 'no') for v in values) or (human and not row.get('人工校对人', '').strip()):
            g['unreviewed'] += 1; continue
        humans += human
        facts, acceptable, mischange = [v == 'yes' for v in values]
        g['critical_errors'] += not facts
        if row['原句类型'] == 'normal':
            g['normal'] += 1; g['normal_mischanges'] += mischange
        else:
            g['problems'] += 1
            # Reverting an uncorrected problem or rejecting a good candidate is
            # not a successful natural edit. Short routing is assessed separately.
            generated = sample['model_requested'] and sample['generation_complete']
            g['candidate_acceptable'] += acceptable and generated
            # Track the model's raw candidate quality separately from the local
            # delivery guard. A candidate that reads well but fails the guard
            # still cannot be auto-delivered without a reviewed guard change.
            g['blocked_by_guard'] += acceptable and generated and not sample['accepted']
    for g in groups.values():
        g['problem_candidate_rate'] = g['candidate_acceptable'] / g['problems'] if g['problems'] else None
    passed = (all(g['count'] >= 20 and not g['unreviewed'] and not g['critical_errors'] and not g['normal_mischanges'] and g['normal'] for g in groups.values())
              and all(groups[k]['problems'] and groups[k]['problem_candidate_rate'] >= .9 and not groups[k]['blocked_by_guard'] for k in ['medium', 'long']))
    report = {k: v for k, v in manifest.items() if k != 'samples'}
    report.update(passed=bool(passed), groups=groups, human_reviewed=humans, ai_reviewed=len(rows)-humans,
                  review_sha256=hashlib.sha256(source.read_bytes()).hexdigest(), count=len(rows))
    source.with_suffix('.acceptance.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if passed else 2

def main():
    p = argparse.ArgumentParser(description=__doc__); sub = p.add_subparsers(dest='command', required=True)
    q = sub.add_parser('export'); q.add_argument('--results', required=True); q.add_argument('--reviews'); q.add_argument('--output', required=True); q.set_defaults(run=export)
    q = sub.add_parser('import'); q.add_argument('csv'); q.set_defaults(run=review)
    args = p.parse_args()
    try: return args.run(args) or 0
    except (AssertionError, KeyError, ValueError) as error: print(str(error)); return 2

if __name__ == '__main__':
    raise SystemExit(main())
