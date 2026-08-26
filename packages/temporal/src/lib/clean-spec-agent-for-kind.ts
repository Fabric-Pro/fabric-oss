/**
 * The single source of truth for "which prompt-catalog agent serves this work
 * item's kind".
 *
 * Fizzy #2048: a work item's kind can be changed from one surface (the roadmap
 * card kebab) while a different surface (the detail view) still holds the old
 * kind in its cache. Every server-side path that resolves a Clean Spec prompt
 * must therefore derive the agent name from the item's STORED kind — and must
 * do it through THIS helper. A second copy of the mapping is exactly how a
 * converted item keeps getting the previous kind's template: the copies drift,
 * or one of them is fed a kind the server never verified.
 *
 * The keys below are the ones the Clean Spec prompts are seeded and bound under
 * (`seed-prompts-only.ts`, documentType `CLEAN_SPEC`). Binding resolution is
 * exact-match on kind with NO cross-kind fallback (see `getBoundPromptVersion`),
 * so a missing binding surfaces as "nothing bound" rather than as the other
 * kind's prompt.
 *
 * Lives in `@repo/temporal/src/lib` — alongside `create-story-from-proposal.ts`
 * and `reanalyze-body-by-kind.ts`, for the same reason those do: `@repo/api`
 * already depends on `@repo/temporal` and never the reverse, so this is the
 * only side of the pair both server packages can import without a cycle.
 */

import type { StoryKind } from "@repo/database";

/**
 * Agent keys the Clean Spec prompts are bound under, keyed by work item kind.
 * See `seed-prompts-only.ts`.
 */
export const CLEAN_SPEC_AGENT_BY_KIND: Record<StoryKind, string> = {
	BUG: "bug_clean_spec_generator",
	FEATURE: "feature_clean_spec_generator",
};

/** The documentType both kinds' Clean Spec prompts are bound at. */
export const CLEAN_SPEC_DOCUMENT_TYPE = "CLEAN_SPEC";

/**
 * Collapse a possibly-absent kind to exactly one of the two values before any
 * template lookup runs (#2048 R4). `StoryKind` is a two-value enum, but callers
 * hand us optional/nullable rows and a legacy third value existed until
 * recently — resolving here means no ambiguous value ever reaches the resolver,
 * and the fallback is deterministic rather than incidental.
 */
export function resolveStoryKind(
	kind: StoryKind | null | undefined,
): StoryKind {
	return kind === "BUG" ? "BUG" : "FEATURE";
}

/** The Clean Spec agent name for a work item of this kind. */
export function cleanSpecAgentForKind(
	kind: StoryKind | null | undefined,
): string {
	return CLEAN_SPEC_AGENT_BY_KIND[resolveStoryKind(kind)];
}

/**
 * The lowercase word a reviewer-facing message uses for this kind ("bug" /
 * "feature"). Returned alongside the resolved prompt so the message wording and
 * the template that was actually chosen cannot disagree.
 */
export function storyKindWord(
	kind: StoryKind | null | undefined,
): "bug" | "feature" {
	return resolveStoryKind(kind) === "BUG" ? "bug" : "feature";
}
