import { ORPCError } from "@orpc/client";
import type { StoryKind } from "@repo/database";
import {
	assertPromptKindCompatible as assertPromptKindCompatibleCore,
	PromptKindMismatchError,
	type PromptKindScope,
	validatePromptForKind as validatePromptForKindCore,
} from "@repo/temporal/prompt-kind-guard";

/**
 * The api-side face of the prompt/kind guard.
 *
 * The decision itself and its binding lookup live in
 * `@repo/temporal/src/lib/prompt-kind-guard.ts` (Fizzy #2048, KTD6): the
 * creation path has to run the same guard, and it lives in `@repo/temporal`,
 * which cannot import from `@repo/api`. Read that file for the rule — deny by
 * default, an explicit NULL scope is the only kind-agnostic binding — and for
 * why the query is shaped the way it is.
 *
 * What stays here is the protocol mapping and nothing else: the core throws a
 * typed `PromptKindMismatchError` because the workflow package carries no orpc
 * dependency, and these wrappers turn it into the `BAD_REQUEST` the procedures
 * already contract for. The message is passed through untouched — it is written
 * for the reviewer and is rendered verbatim.
 *
 * Both the synchronous decision and the async lookup are re-exported. Callers
 * that already hold the binding rows use the former; callers that hold only a
 * prompt id use the latter.
 */

export type { PromptKindScope };

/** Re-thrown as a 400; see the module header. */
function asRefusal(error: unknown): never {
	if (error instanceof PromptKindMismatchError) {
		throw new ORPCError("BAD_REQUEST", { message: error.message });
	}
	throw error;
}

/**
 * Throws a 400 ORPCError if a hand-picked prompt is not valid for `kind`.
 *
 * Pure decision, no I/O — the caller supplies every kind scope visible on the
 * prompt's bindings at `documentType`.
 */
export function assertPromptKindCompatible(args: {
	/** Every kind scope visible on this prompt's bindings at `documentType`. */
	kindScopes: readonly PromptKindScope[];
	/** The kind read from the STORED work item row, never from the caller. */
	kind: StoryKind;
	/** Reviewer-facing prompt name, for the message. */
	promptLabel: string;
	/** The action's document type — stage name, or CLEAN_SPEC for a refresh. */
	documentType: string;
}): void {
	try {
		assertPromptKindCompatibleCore(args);
	} catch (error) {
		asRefusal(error);
	}
}

/**
 * Read the kind scopes a prompt's bindings carry at one document type, then
 * assert the work item's stored kind against them. Throws a 400 ORPCError on a
 * cross-kind or unbound prompt.
 */
export async function validatePromptForKind(args: {
	promptId: string;
	promptLabel: string;
	kind: StoryKind;
	documentType: string;
	userId?: string;
	organizationId?: string;
}): Promise<void> {
	try {
		await validatePromptForKindCore(args);
	} catch (error) {
		asRefusal(error);
	}
}
