---
"fabric-app": patch
---

Make every AI surface refuse a missing provider the same way, and stop the provider notice from hiding while calls fail.

Four review findings sharing one cause: the refusal work landed on the paths
someone was looking at, and a tenant without its own provider key went from a
rare case to the common one, so the paths that were missed are now exercised
routinely.

`canResolveProvider` asked whether ANY enabled provider row carried a
credential, while the resolver reads only the row marked `isDefault`. An
organization whose default was saved without a credential, but which has another
row that has one, reported resolvable while every real call refused — the exact
divergence the field was added to remove. All three of its queries now filter to
the row the resolver actually reads.

Atlas mapped `NO_AI_PROVIDER` to `BAD_REQUEST`. Two procedures had been moved to
`PRECONDITION_FAILED`, but the ten-odd others route their refusal through a
shared map that was not, so the same tenant with the same missing key got two
different semantics depending on which procedure they reached. `BAD_REQUEST`
also says the caller sent something wrong, which is not what happened.

Two Temporal workflows that call a model still had no non-retryable
classification, so a configuration refusal spent a full retry budget reaching
the same answer. The duplicate scan had the same gap in a different shape: it
never checked whether the resolver came back with credentials, and its catch
rewrapped the refusal into a type the non-retry list does not name.

Also closes a coverage hole this branch introduced: the legacy `config.apiKey`
credential location had no test, while a mock in the API layer claimed it was
pinned. It is now pinned for real, and the mock's comment points at the tests
that do it.
