---
"fabric-app": patch
---

AI Update no longer surfaces a raw Zod error dump when the model's structured output fails validation

The `changes` array in `ChangeProposalSchema` is deliberately strict — a response carrying no `changes` is a wholesale generation failure and must not be reported as "nothing proposed". What was broken is what the user saw when that check fired.

`generateObject` reports a schema rejection as `NoObjectGeneratedError` → `.cause` `TypeValidationError` → `.cause` `ZodError`. `descendToProviderError` in `classify-analysis-error.ts` (added to reach a provider `statusCode`) walks straight past both wrappers to the `ZodError` leaf whenever no node in the chain carries a status code, and the `schema_parse` branch matched a regex against only that leaf's name and message — "ZodError" plus a JSON dump of Zod issues, which matches none of its alternatives. Every malformed-output run therefore fell through to `transient_or_unknown`, the one class that appends the raw cause to the user-facing message. Prod logged it twice on 2 Sep 2026 as `ZodError: invalid_type` on path `["changes"]`, with `received undefined` and `received string`.

Two changes:

- `isSchemaValidationError` walks the original error (not the descended leaf) and matches on the AI SDK's symbol markers, so any structured-output validation failure classifies as `schema_parse` and gets its actionable copy. The existing name regex stays for shapes that arrive without markers. Ordering is preserved: an output-token cut-off still classifies as `output_limit`, and a chain carrying a provider status code still classifies as a limit error.
- `changes` arriving as a JSON string is now parsed and salvaged, in the same spirit as the existing per-element filter — the content is a valid list that a provider encoded twice. A string that does not parse, or does not parse to an array, still rejects, and a missing `changes` is still never defaulted to an empty list.

The earlier tests could not have caught this: they built a bare `Error` merely named `NoObjectGeneratedError` with no cause chain. New tests construct the real three-link SDK error.

Fizzy #2395.

Review follow-up: a `NoObjectGeneratedError` whose `finishReason` is `content-filter` is a policy rejection, not malformed output — the completion was stopped mid-flight so no object could form. It is now classified as `provider_content_filter` ahead of the schema-parse branch, so the user gets copy saying retrying the same selection won't help rather than being told to retry a deterministic refusal.
