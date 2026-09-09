---
"fabric-app": patch
---

The prompt that picks a project's publishing topics is now editable in the Prompt Library

Fizzy #1851. Every AI step in the Publishing Suite resolved its prompt through the library except the first one. `buildTopicSuggestionPrompt` was a hard-coded string whose own header called it "engineering-drafted per Q13", and it writes `topic.pitch` — the summary at the top of every Topic Item Page and the text every downstream draft is built from. Retuning that wording was a code change and a deploy.

The body now lives in `@repo/utils/publishing-suggestion-prompt` under the agent key `publishing_topic_suggestion`, imported by the three sites that need it (the seed's SYSTEM prompt and binding, the prompt action catalog, and `summarizeTopicSuggestions`), so no two copies can drift. Same arrangement as its four publishing siblings.

Text is unchanged, but four things left the editable body and are now appended code-side where an override cannot remove them: the output contract, and the three grounding rules — "Ground every claim in the given context", "Do not fabricate a topic to fill space", and "Never cite an id, PR number, or repo name that does not appear verbatim in the context below". Those matter more here than in the siblings, because content drifting off its topic is the one confirmed correctness bug in this feature and this prompt is where a topic's identity is decided.

One deliberate departure from the Planning & Analysis pattern: the serialized source context is appended code-side too, rather than exposed as a `{{{context}}}` slot. That prompt weaves ~15 named variables through its prose; this one has a single input that is always terminal. A slot would put the body's several references to "the context below" at the mercy of where an org moved it, and would make deleting the whole context a one-token edit that renders cleanly, passes every guard, and returns a full set of invented topics on a schedule nobody is watching. The body therefore takes no template variables at all.

The three render guards are inherited from `composePlanningAnalysisPrompt`, and a bound body that will not render falls back to the default with a warning naming which guard fired.

Insert-only, as always: existing environments keep whatever they seeded; a wording change ships as an explicit UPDATE migration.
