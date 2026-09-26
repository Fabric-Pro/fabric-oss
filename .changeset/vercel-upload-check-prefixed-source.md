---
"fabric-app": patch
---

Web deployments now include application source files whose names start with `check-`, which the deployment upload had been skipping.

The `.vercelignore` rule `check-*.ts` matched any file in the tree, so the new duplicate-check procedure was left out of the Vercel upload and the web type-check failed with a missing module. The rule is now anchored to the tooling scripts it was written for.
