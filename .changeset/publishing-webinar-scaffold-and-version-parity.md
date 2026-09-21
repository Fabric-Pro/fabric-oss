---
"fabric-app": patch
---

Webinar / Demo Script drafts now generate for topics with little webinar context, and both newer content types show their version history

Three fixes found by QA on a topic whose own planning analysis said no live,
presenter-led session was indicated.

**Webinar / Demo Script could not generate at all on such a topic.** Six narrative
fields were required, each argued for by a comment saying the prompt instructs the
model to write a "[… TBD]" placeholder rather than leave one blank. Nothing
enforced that: `generateObject` runs with `strictJsonSchema: false` — Azure/OpenAI
reject a strict schema containing optional fields — so a provider is free to omit
a field, and on a thin topic it does. `generateObject` then threw
`NoObjectGeneratedError` before the activity's own validation could run,
deterministically, on every attempt. The prompt asks for a scaffold in exactly
that case and the feature requires "one editable draft or scaffold", so the
schema now lets one exist: `title` and `sessionPurpose` stay required, the other
six are nullable, and the working-draft composer omits a section rather than
interpolating null into it.

**The authored failure message was unreachable on the path that actually fails.**
`generateObject` validates against the zod schema itself and throws before
returning, so the `safeParse` below it — and the "generating again usually clears
it" copy its failure class carries — never ran. Readers got the neutral "the
reason is recorded in the run log" instead. All seven content types now catch
`NoObjectGeneratedError` and re-raise it as the same class, while letting an
unrelated provider failure through untouched.

**Restoring an earlier draft worked on five content types and not on the two
newest.** Their panels never rendered `DraftVersions`, and their adopt endpoints
matched `latestReady.id` alone — the same narrowing the five earlier types were
already fixed to remove, which makes every version but the last unreachable
rather than merely unlisted. Both halves had to land together: rendering the list
alone would have shipped one whose top row restores and whose every row below it
answers "Draft not found".

Test fixtures for the two adopt endpoints carried no `versions` array, which is
why nothing was red; they now match the shape the read path actually returns.
