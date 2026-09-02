---
"fabric-app": patch
---

Testing settings: the coverage target splits into an Automation target (reporting) and a Test Coverage Target Done-gate that ships off; device defaults become one Chrome window size with custom support, and sceptic roles default to UX Skeptic only.

One number used to drive two unrelated policies: the automation rings on the Testing tab and the blocking gate on marking a feature Done — measured over different denominators. Setting "how much automation to show" silently armed a Done refusal over acceptance criteria, and disarming it zeroed the ring target too. The reporting field is renamed Automation target and blocks nothing; the new Test Coverage Target gate lives under Sign-off, ships off for every project including ones with a saved row (nobody knowingly configured it), and pre-fills 30% when switched on.

Devices & browsers now ship a single combination — 1920×1080 in Chrome — matching what a run actually reads, pick from six laptop/mobile presets or type any WxH. Sceptic roles default to UX Skeptic only, and the policy summary counts roles the depth leaves audible instead of stored switches. The shared slider primitive clears WCAG 2.1 1.4.11 non-text contrast in both themes (filled/unfilled previously measured 1.34:1 light / 2.25:1 dark) and exposes its accessible name on the Radix thumb.

Internal context: schema adds `ProjectQaSettings.testCoverageTarget` (default 0, hand-written migration `20260825140000_add_test_coverage_target`); Done gate in `update-story.ts` reads the new column; committed-but-stale `prisma/zod/index.ts` regenerated through the generate pipeline in its own commit (HEAD's copy threw ReferenceError on import); suites touched: update-story-qa-sign-off-gate (13 tests incl. two new split-pins), theme-token-contrast (slider pair assertions), testing-sections (draft-field guard).
