---
"fabric-app": patch
---

QA Suite Phase 1 enabled on production workers

The temporal worker now declares `FABRIC_FEATURE_TEST_CASES` through a new
`enableTestCases` Bicep parameter, set true for every environment by the
deploy workflow. The web half of the flag was already live on Vercel; this
keeps the worker half (automatic pipeline-result sync sweep and QA evidence
retention) alive across deploys instead of relying on a hand-set container
env var that the next deployment would wipe. Setting the parameter false
stops both sweeps on the next tick with no redeploy.
