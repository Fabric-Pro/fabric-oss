import type { OnboardingTourAction, OnboardingTourState } from "@repo/database";
import { z } from "zod";

/** Mirrors `OnboardingTourState` from `@repo/database` (the JSON column shape). */
const onboardingTourStateSchema = z.object({
	version: z.number(),
	status: z.enum(["not_started", "in_progress", "completed", "dismissed"]),
	currentStepId: z.string().nullable(),
	steps: z.record(z.string(), z.enum(["completed", "skipped"])),
	autoLaunched: z.boolean(),
	seenPages: z.record(z.string(), z.boolean()),
	pageToursOptedOut: z.boolean(),
	functionTagsPromptOptOut: z.boolean(),
	pointerDismissed: z.boolean(),
	completedAt: z.string().nullable(),
	dismissedAt: z.string().nullable(),
});

/** Mirrors `OnboardingTourAction` from `@repo/database`. */
export const onboardingTourActionSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("start") }),
	z.object({
		type: z.literal("step"),
		stepId: z.string().min(1),
		outcome: z.enum(["completed", "skipped"]),
		currentStepId: z.string().nullable().optional(),
	}),
	z.object({ type: z.literal("setCurrent"), stepId: z.string().nullable() }),
	z.object({ type: z.literal("complete") }),
	z.object({ type: z.literal("dismiss") }),
	z.object({ type: z.literal("markAutoLaunched") }),
	z.object({
		type: z.literal("markPageSeen"),
		pageId: z.string().min(1),
	}),
	z.object({
		type: z.literal("clearPageSeen"),
		pageId: z.string().min(1),
	}),
	z.object({ type: z.literal("markPageToursOptedOut") }),
	z.object({ type: z.literal("markFunctionTagsPromptSeen") }),
	z.object({ type: z.literal("optOutFunctionTagsPrompt") }),
	z.object({ type: z.literal("dismissPointer") }),
	z.object({ type: z.literal("restart") }),
]);

/**
 * Response-only compat for the FR4 prompt rollout. Pre-redesign client bundles
 * read `state.functionTagsPromptSeen` to gate the old one-shot prompt; the
 * current server no longer stores that field. During a rolling deploy the
 * response includes it (always `true`) so cached OLD bundles keep the
 * pre-redesign prompt suppressed and cannot open/loop it. The current client
 * ignores this field. Remove once old SPA bundles have aged out of caches.
 */
export const onboardingTourStateResponseSchema =
	onboardingTourStateSchema.extend({ functionTagsPromptSeen: z.boolean() });

/** Adds the legacy `functionTagsPromptSeen` compat flag to a state for the wire. */
export function withLegacyPromptCompat(
	state: OnboardingTourState,
): z.infer<typeof onboardingTourStateResponseSchema> {
	return { ...state, functionTagsPromptSeen: true };
}

// Compile-time guard: these Zod schemas are the wire contract for the JSON
// state + reducer actions defined in `@repo/database`. If either side drifts
// (a new action variant, a renamed field), one of these assertions stops
// resolving to `true` and `type-check` fails — so the "mirror" can't rot.
type Equal<A, B> = (<G>() => G extends A ? 1 : 2) extends <G>() => G extends B
	? 1
	: 2
	? true
	: false;
type Expect<T extends true> = T;
type _StateInSync = Expect<
	Equal<z.infer<typeof onboardingTourStateSchema>, OnboardingTourState>
>;
type _ActionInSync = Expect<
	Equal<z.infer<typeof onboardingTourActionSchema>, OnboardingTourAction>
>;
