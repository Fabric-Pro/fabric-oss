---
"fabric-app": patch
---

AI now runs on the provider key you configure — the included $5 allowance, the card collection behind it, and the platform-key fallback are gone

Fizzy #1875 / Feature 552, FR10 and UC4.

What changed, in the order it had to happen:

- The access decision stopped consulting the credit ledger and the saved payment
  method, and the key resolvers stopped falling back to the deployment's own
  gateway credential on any path a person waits on. Split into named entry points
  at two levels rather than flagged, so an untouched caller stays on the safe half
  and two functions cannot be passed the wrong way round.
- The credits banner, the credit-status procedure, the balance it fed, and the
  Stripe card-collection surface all go. The external balance route survives
  answering zero, because released VS Code builds read it.
- The ledger stopped accruing. It had been incremented after every usage record
  without checking who paid, so spend on tenants' own keys accrued against a
  platform allowance — about $1,636 across eight rows while no usage row was ever
  categorised as platform-funded.
- The "AI provider required" notice moved into the chrome, so a keyless tenant is
  told what to do on every page rather than only on the dashboard. Three fixes
  came with the move: a project guest no longer queries an organization they do
  not belong to, a member who cannot edit organization settings is no longer sent
  to a read-only form, and the notice now agrees with the resolver about what
  "configured" means.
- A personal AI provider key has somewhere to be configured again. The form had
  been mounted nowhere since the personal settings tree was retired — it went dark
  by location rather than by decision, and a personal key is an account setting,
  not personal tenancy.
- A provider refusal now fails once instead of five times. Eighteen retry policies
  name it non-retryable, and the document workflow's fatality test was repaired: it
  matched on an ActivityFailure's generic message, so no provider refusal had ever
  matched and every one fell through as "carry on without RAG".

Measured before shipping, not assumed: no organization visible in the usage log
lacks its own provider configuration, no payment-provider customer exists, and the
purchase table is empty. Platform-funded AI was built, documented, and never used.

The credit table and the usage-category enum stay — reporting reads the categories
and historical rows keep them, and no migration means no exposure to this repo's
schema-wide migration drift.
