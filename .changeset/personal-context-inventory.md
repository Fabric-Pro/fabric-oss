---
"fabric-app": patch
---

Add a read-only inventory of what personal context actually holds

The surface map records `population not instrumented` against every decision it asks for: it enumerates the categories personal scope carries — projects, documents, chats, purchases, credit accounts, API keys, the audit trail — without counting a row in any of them. That leaves three questions the elimination cannot answer from the schema alone: how much is there, how many people have no organization to be moved to, and how many credentials resolve to nothing once personal context is gone.

`pnpm --filter @repo/database count:personal-context` answers all three. It writes nothing and locks nothing, and `--json` prints a machine-readable object so a figure can be quoted into a decision without being retyped.

The model list comes from the schema rather than from the tenancy-class sets, which are the authority on how a model is filtered, not on whether it has an organization column. Deriving it from the schema means a model added later is counted without anyone remembering the script exists. A model that fails to count is reported as uncounted rather than skipped — a silent skip would understate the total, which is the one thing an inventory must not do.
