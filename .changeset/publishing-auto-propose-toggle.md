---
"fabric-app": patch
---

Let a project turn off the AI's suggested answers

Feature Maturation has an "auto-propose answers" switch; the Publishing Suite now has one too (Fizzy #1851).

**Per project, where FMv2's is per feature** — because the two are asked at different moments. FMv2 mints questions continuously as a spec matures, so a person can turn it off for the one feature that is noisy. Publishing mints them once, when the analysis runs, so a per-topic switch is one nobody could reach in time.

**Gated in the prompt, not by filtering the answer.** Turning it off tells the model to raise the question and stop, so it genuinely stops writing suggestions. Stripping them afterwards would spend the tokens and throw the result away — a setting that costs exactly what it claims to save.

On by default, and the column is `NOT NULL` with that default, so every existing project is already in the right state and nothing needed backfilling. The suggestions are the feature; a switch that starts off is a feature nobody finds.
