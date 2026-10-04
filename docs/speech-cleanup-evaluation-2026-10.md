# Chinese speech cleanup: evaluation and deployment status

Updated 2026-10-05. This report records aggregate results for the speech-cleanup work. Evaluation transcripts, audio, row-level model outputs, credentials, and host-specific paths are kept in the private local workspace and are not published with this repository.

## Current result

CapsWriter 1.0.39 can run natural-language cleanup separately from ASR, apply the Handy post-processing request protocol with reasoning disabled, retain model candidates in history, and fall back to the recognized base text within the foreground deadline. The model candidate is not enabled for automatic typing or clipboard delivery because quality acceptance failed.

The latest blind text review covered 60 examples, with 20 each in short, medium, and long groups. The model was called for 40 medium and long inputs. Codex's text-only review judged 3/10 medium problem cases and 6/14 long problem cases acceptable. Five candidates changed important meaning or facts, and two normal inputs were changed unnecessarily. The recordings were not listened to, so these judgments do not establish ASR accuracy or audio-grounded correctness.

Candidate generation had a median of 1.076 seconds for medium inputs and 1.527 seconds for long inputs. It completed within two seconds for 15/20 medium and 10/20 long inputs. These replay measurements exclude ASR and the complete release-to-paste path; they should not be read as end-to-end latency.

## Findings

- A high automatic-preservation score from a correction model did not show that it repaired sentence boundaries or spoken grammar. In a focused review of long inputs, the CEC3 configuration often left the source unchanged.
- A more capable general model could join fragments and remove some repetition, but also changed negation or conditions, translated Chinese content, merged ambiguous pauses, or completed unfinished phrases without evidence.
- Punctuation and pauses remain imperfect. A pause is supporting evidence, not a sentence boundary; text-only replay cannot determine whether a punctuation choice matches the speaker's intent.
- No tested model and prompt combination met the quality gate for automatic delivery. Fast fallback to base text is not counted as the model completing within the deadline.

## Verification

- Node regression suite on the merged cloud branch: 435 passed.
- Python evaluation-review tests: 10 passed.
- ESLint: zero errors and six warnings in existing code.
- The Vite renderer production build succeeded.
- The merged 1.0.39 ARM64 AppImage built successfully. Packaged ARM64 `uiohook` and SQLite modules passed architecture checks; package verification matched 137 shipped source files and confirmed the standalone serial diagnostic helper remains excluded. This validates the build artifact, but not a fresh install on the device.
- The lifecycle check covered single delivery, foreground fallback, late history-only completion, preemption, cancellation, and deletion preventing a late result from recreating a record.
- Rollback scripts passed syntax checks; production rollback was not exercised.

## Data handling

The detailed evaluation set contains private speech transcripts and associated audio references. It remains in the local ignored `artifacts/` directory. This public repository contains aggregate counts and conclusions only; row-level CSV/JSONL and recordings are intentionally excluded. API credentials and the deployment-specific model root are supplied by local service configuration and are not stored here.

The prompt comparison used fixed upstream revisions of [Handy](https://github.com/cjpais/Handy), [OpenWhispr](https://github.com/OpenWhispr/openwhispr), and [VoiceInk](https://github.com/Beingpax/VoiceInk). Those comparisons inform request structure and prompt design; they do not establish that the upstream products or their hosted models achieve the same results in this environment.
