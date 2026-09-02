---
"fabric-app": patch
---

Stop writing Databricks prompt-cache entries on one-shot completions, where they can never be read back

The Databricks compat layer placed its rolling cache breakpoint on the last
conversation turn unconditionally. On a one-shot completion — a single user turn,
no tools, the shape `generateText({ system, prompt })` produces — the prefix that
breakpoint caches ends with content that is unique to that call, so the entry it
writes can never be matched by a later request. A cache write costs 1.25x the base
input price against 0.1x for a read, so every such request paid a 25% surcharge on
its entire prompt and recovered nothing.

`rollingBreakpointCanPayOff` now gates that second breakpoint on evidence the
conversation continues: the request carries `tools` (the model may call one, and
the results come back on the same prefix), or `messages` already holds an assistant
turn (a multi-turn exchange getting another user message). The leading system-run
breakpoint is unchanged and stays unconditional — tools plus the system prompt are
the genuinely shared prefix, reused across unrelated calls, and below a model's
minimum cacheable length the marker is ignored at no cost.

Measured against the Databricks billing and AI-gateway system tables over the two
weeks following the prompt-cache rollout. Modelling the bill with Anthropic's
multipliers reproduces it to within 0.3%, which confirms the rates being charged:

- Haiku 4.5: 10.65M tokens written to cache, 0.34M ever read (read/write 0.03).
  Caching cost 4.4% MORE on that model than not caching at all — break-even needs
  read/write above 0.278.
- Sonnet 5 (0.57) and Opus 4.7 (0.66) clear break-even and saved 10.0% and 11.1%.

The Haiku writes came from RAG chunk enrichment, which issues one one-shot call per
chunk. Its per-request write incidence tracks Haiku 4.5's 4096-token minimum
cacheable length exactly — on a day with a 4,214-token median prompt, 1,537 of 2,497
requests wrote an entry and none read one; on days with a ~2,650-token median,
almost none wrote, because the marker fell below the floor and was ignored.

Both mirrored copies of the compat layer are updated (`packages/ai` and
`packages/agent-core`). Several existing tests asserted the old unconditional
placement on bare `[system, user]` bodies and were updated deliberately, with tools
or an assistant turn added where the test's actual subject was breakpoint placement
rather than the payoff gate.

Not addressed here: chunk enrichment puts the shared document and the per-chunk text
in the same user message, so no breakpoint placement can cache the document. Making
that prefix cacheable also needs it to clear Haiku's 4096-token floor, which means
changing how much document context each call carries — a retrieval-behaviour change
rather than a caching fix.
