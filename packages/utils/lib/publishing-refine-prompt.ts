/**
 * The default working-draft refinement prompt (Fizzy #1851 follow-up).
 *
 * Lives in `@repo/utils` for the same reason its six siblings do: it is a leaf
 * package both `@repo/database` and `@repo/temporal` already depend on, so the
 * seed and the activity that resolves the binding share ONE definition instead
 * of two copies a test has to keep byte-identical.
 *
 * ONE prompt for all seven content types, where drafting needs seven. A drafting
 * prompt has to know what a case study IS, because it is producing one from
 * source material. A refinement is handed the finished piece and a single
 * instruction, and every working draft body is Markdown — so the content type
 * survives here only as a register cue (`{{post_type_label}}`), not as a
 * specification.
 */

/**
 * Prompt Library agent key for the editable refinement prompt.
 *
 * Defined once and imported by all the sites that need it — the seed's SYSTEM
 * prompt + binding, the catalog's agent target, and the Temporal activity. A
 * mismatch between any two of them resolves no binding and falls back to the
 * default body forever, silently; a shared constant removes that hazard rather
 * than documenting it.
 */
export const PUBLISHING_REFINE_AGENT_KEY = "publishing_topic_refine";

/**
 * The default refinement prompt, as an org may edit it.
 *
 * WHAT AN EDIT CAN AND CANNOT DO. Editing this body changes how a revision is
 * approached — how conservative to be, what "tighten" means in this
 * organization's voice, which qualities to preserve. It cannot change the OUTPUT
 * CONTRACT (one complete revised document) or the approval rules: both are
 * appended code-side in `build-refine-prompt.ts`, and the single-document
 * contract is additionally enforced by `PublishingRefinementSchema` before
 * anything is stored.
 *
 * That split is what this whole slice is about. Refining used to run the
 * DRAFTING prompt, so for Short Post and LinkedIn it inherited "produce exactly
 * three options" — and "remove the last line" came back as three rewrites.
 *
 * The disclosure rule below is deliberately worded like its six siblings',
 * ending in the same "unless the context above explicitly marks them safe to
 * share" exception. On this prompt "the context above" includes the DRAFT
 * itself, which makes the exception actively dangerous — a draft containing a
 * customer name is not evidence that name was ever approved. The locked clauses
 * void the exception and keep the prohibition, exactly as they do for the
 * drafting prompts.
 *
 * THERE IS DELIBERATELY NO `{{{instruction}}}` SLOT, and adding one would be a
 * mistake. The author's revision instruction reaches the model only through
 * `buildRefinementSection`, which composes it code-side inside its own SOURCE
 * DATA fence with its own injection rule. That is what makes it impossible for
 * an edited body to drop the instruction — `buildRefinementSection`'s docblock
 * records that an org whose template dropped `{{guidance}}` would otherwise
 * refine to no instruction at all, and the reader would never be told. A slot
 * here would reintroduce exactly that, and would additionally render the
 * instruction OUTSIDE the fence.
 *
 * Free-text slots use triple-stache so a topic title containing <, & or quotes
 * is not HTML-escaped into the prompt. Every one of them is neutralized against
 * forged SOURCE DATA markers before rendering — see `composeRefinePrompt`.
 *
 * INSERT-ONLY once seeded: changing this text does nothing on an environment
 * that has already run the seed. Ship wording changes as an explicit UPDATE
 * migration.
 */
export const PUBLISHING_REFINE_FALLBACK_BODY = `You are Fabric, revising a saved {{{post_type_label}}} that a person is working on.

## Purpose

- The author already has a draft. They have asked for one specific change to it.
- Your job is that change and whatever it leaves inconsistent — not a better draft, and not a different one.
- The draft is the author's work. Treat every part of it they did not ask you to touch as deliberate.

## The topic

{{{topic_title}}}
{{#if has_topic_pitch}}

{{{topic_pitch}}}
{{/if}}
{{#if has_decisions}}

## Decisions the team has settled on this topic

These were decided by a person. Where one bears on the change you are making, follow it.

{{{decisions}}}
{{/if}}

## How to revise

- Make the requested change, and adjust only what that change leaves reading badly.
- Preserve the draft's structure, section order, headings, examples and level of detail unless the instruction asks otherwise.
- Preserve its voice. A revision that reads as though a different person wrote it has failed even if every sentence is an improvement.
- Where the instruction is ambiguous, choose the smaller reading. The author can ask again; they cannot un-ask.
- Do not expose internal implementation details, code names, private links, ticket IDs, or confidential customer information unless the context above explicitly marks them safe to share.
`;
