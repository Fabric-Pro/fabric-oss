---
title: "A bigger structured-output schema can be refused before any repair runs — put optional output in its own call and pin the existing one"
category: integration-issues
date: 2026-10-16
module: proposal internal analysis model call (packages/temporal analysis activity, packages/ai model factory)
problem_type: integration_issue
component: background_job
severity: high
symptoms:
  - "A planned extension of a generateObject schema (findings plus an optional report) would have had 17 union-typed parameters, over Anthropic's documented limit of 16"
  - "The provider rejects such a schema with an APICallError before the model runs, so a repairText salvage never sees any text and the run fails with no findings"
  - "Long Markdown inside a JSON string field breaks parsing on routes that run structured output non-strictly or prompt-steered"
root_cause: logic_error
resolution_type: code_fix
tags: [ai-sdk, generate-object, structured-output, json-schema, anthropic, union-limit, repair-text, nullable, model-output, characterization-tests]
related_components: [service_layer]
---

# A bigger structured-output schema can be refused before any repair runs

## Problem

An existing `generateObject` call returned findings for a document review. A new requirement asked the same review to also return a long free-form report plus a few structured fields, with the rule that a bad or missing report must never cost the findings. The first design added a nullable `report` object to the existing schema and relied on the AI SDK's `repairText` hook to salvage the findings when the report part failed to parse or validate.

## Symptoms

- Counting the JSON Schema the SDK would emit (draft-7, `io: "input"`) gave 5 union-typed parameters for the findings schema and 17 with the report added: every zod `.nullable()` becomes an `anyOf`/type array, and Anthropic's structured outputs allow 16 per request.
- A schema the provider refuses fails as an `APICallError` (HTTP 400) before any model output exists. `repairText` runs only on a `JSONParseError` or `TypeValidationError` over returned text, so it never fires, and the error is retryable, so the activity retried three times and then failed the run with no findings.
- Routes that run structured output non-strictly (`strictJsonSchema: false` for OpenAI-family providers, prompt-steered JSON for some served models, `json_object` without a schema) parse the model's raw text; a 60,000-character Markdown string inside JSON is where an unescaped quote or a cut-off answer breaks the whole object.

## What Didn't Work

- **One call with a repair hook.** It protects only against failures that happen after text exists. A schema-size refusal, an empty answer and a reasoning-only answer all skip it.
- **A separate *structured* report call.** It still carries the long Markdown inside JSON, so the non-strict routes keep the parse failure, just in a different call.
- **Reducing unions by making report fields non-nullable.** It fixes the count but not the Markdown-in-JSON fragility, and it changes the findings call's schema, which existing behaviour (stable finding keys) depends on.

## Solution

Keep the existing findings call byte for byte and add a second, plain-text call for the optional output (`draftAnalysisReport` in `packages/temporal/src/activities/proposal-artifact/analysis.ts:577`):

- The report call is `generateText` with the same instructions plus a format-only block that asks for the report as Markdown and one trailing fenced block (info string `json fabric-report`) holding the structured fields. The worker strips that block and parses it leniently; a missing or invalid block keeps the text with empty fields, and an answer of `NONE` means no report.
- Every report failure (provider refusal, content-filter or error finish, deadline, empty or unreadable answer, a write error) becomes a fixed log code and the run completes with its findings.
- Characterization tests written against the untouched code pin the findings call's instructions, prompt, schema (an inline snapshot of `z.toJSONSchema` of the schema) and output budget (`describe("the findings call, pinned")` in the activity test, around line 1014), and stay green as the report path lands.

## Why This Works

The optional output no longer shares a failure domain with the required one: nothing about the report can change what the findings call sends, and the report travels as plain text that no provider schema limit or JSON escaping applies to. The pinned tests turn "the findings call is unchanged" from a review claim into a check.

## Prevention

- Before adding fields to a structured-output schema, **count its union-typed parameters** in the emitted JSON Schema and compare against each provider's limits; nullable fields count.
- Remember what a repair hook can see: only returned text. **Request-level refusals bypass it**, so it cannot be the guarantee for a must-not-fail output.
- Put **optional, failure-tolerant output in its own call**, and keep long prose out of JSON strings.
- **Pin the existing call with characterization tests first**, then build beside it.
