/**
 * The prompt/kind compatibility guard: may THIS hand-picked prompt run over
 * THIS work item?
 *
 * Lives in `@repo/temporal/src/lib` for the same reason
 * `clean-spec-agent-for-kind.ts` does: `@repo/api` already depends on
 * `@repo/temporal` and never the reverse, so this is the only side of the pair
 * both server packages can import without inverting the dependency.
 *
 * It has to be reachable from this side because of where the guard can honestly
 * run (Fizzy #2048). At creation time the caller's `kind` is a hint: the shipped
 * UI does not send it and the classifier is licensed to overrule it, so guarding
 * against that hint would pass a FEATURE-bound prompt for an item the classifier
 * then routes to BUG. The only point where a trustworthy kind and an explicit
 * prompt id coexist is inside `create-story-from-proposal.ts`, between
 * classification and prompt resolution — in this package.
 *
 * The refusal is a typed `PromptKindMismatchError`, never an `ORPCError`: no
 * orpc dependency is added to the workflow package. `@repo/api` catches it by
 * `instanceof` and maps it to a 400 refusal, the same shape
 * `ContextUpdateTruncatedError` from `update-with-context-core.ts` is mapped in.
 */

import { db, type StoryKind } from "@repo/database";

// Kind scopes a PromptBinding row can carry:
// - NULL: kind-agnostic. The non-stage bindings (PRD/PROPOSAL and friends) are
//   seeded this way and are legitimately valid for both kinds.
// - FEATURE / BUG: scoped to exactly that kind.
//
// A prompt VERSION can carry many binding rows — one per (documentType, scope,
// tenant) — so "the prompt's kind scope" is not a single value and may be
// absent entirely. That is why this reads the whole visible binding set for one
// documentType and decides from it, rather than reading a column off the prompt.
export type PromptKindScope = StoryKind | null;

/**
 * A hand-picked prompt was refused for the work item it was aimed at.
 *
 * `message` is reviewer-facing and is rendered verbatim by whichever caller
 * catches this, so it is written once here rather than re-worded per call site:
 * the api procedures re-throw it inside a `BAD_REQUEST`, and the creation path
 * surfaces it on the workflow's failure. The structured fields are for callers
 * that need to branch or log without parsing the sentence.
 */
export class PromptKindMismatchError extends Error {
	/** The kind read from the STORED work item row (or the classifier's verdict). */
	readonly kind: StoryKind;
	/** Reviewer-facing prompt name. */
	readonly promptLabel: string;
	/** The action's document type — stage name, or CLEAN_SPEC for a refresh. */
	readonly documentType: string;
	/**
	 * The kinds the prompt IS bound to at `documentType`, deduped. Empty means
	 * the prompt carries no visible binding there at all — which is a refusal in
	 * its own right, see `assertPromptKindCompatible`.
	 */
	readonly boundKinds: readonly StoryKind[];

	constructor(
		message: string,
		details: {
			kind: StoryKind;
			promptLabel: string;
			documentType: string;
			boundKinds: readonly StoryKind[];
		},
	) {
		super(message);
		this.name = "PromptKindMismatchError";
		this.kind = details.kind;
		this.promptLabel = details.promptLabel;
		this.documentType = details.documentType;
		this.boundKinds = details.boundKinds;
	}
}

/**
 * Throws `PromptKindMismatchError` if a hand-picked prompt is not valid for
 * `kind`.
 *
 * `promptId` is free input on the maturation, prompt-resolution and creation
 * paths, because Prisma can only constrain the binding column itself, not the
 * rule that ties a chosen prompt to the work item it will rewrite. This helper
 * layers that cross-column invariant on top so a stale client can't, e.g., run
 * a FEATURE-bound template over a BUG work item (Fizzy #2048, R3/AE2).
 *
 * DENY BY DEFAULT. Only a binding whose `storyKind` is explicitly NULL counts
 * as kind-agnostic. A prompt with NO binding at `documentType` is refused
 * rather than waved through — "no binding found" is not evidence that a prompt
 * is safe for both kinds, it is an absence of evidence either way, and reading
 * it as permission would turn this guard off for every prompt a caller can
 * name.
 *
 * The thrown message is rendered to the reviewer verbatim by the caller, so it
 * names the work item's kind, the prompt's bound kind, and the way out.
 */
export function assertPromptKindCompatible({
	kindScopes,
	kind,
	promptLabel,
	documentType,
}: {
	/** Every kind scope visible on this prompt's bindings at `documentType`. */
	kindScopes: readonly PromptKindScope[];
	/** The kind read from the STORED work item row, never from the caller. */
	kind: StoryKind;
	/** Reviewer-facing prompt name, for the message. */
	promptLabel: string;
	/** The action's document type — stage name, or CLEAN_SPEC for a refresh. */
	documentType: string;
}): void {
	// Explicit NULL scope, or an exact match on the stored kind. Nothing else.
	if (kindScopes.some((scope) => scope === null || scope === kind)) {
		return;
	}

	if (kindScopes.length === 0) {
		throw new PromptKindMismatchError(
			`Prompt "${promptLabel}" is not bound to any work item kind for this action (${documentType}), so it cannot be applied to a ${kind} work item. Pick a prompt from this work item's own prompt list, or clear the prompt selection to use the ${kind} template.`,
			{ kind, promptLabel, documentType, boundKinds: [] },
		);
	}

	// StoryKind has two values, so anything left here is scoped to the other
	// one; dedupe and list it rather than assuming which.
	const boundKinds = [...new Set(kindScopes)].filter(
		(scope): scope is StoryKind => scope !== null,
	);
	throw new PromptKindMismatchError(
		`Prompt "${promptLabel}" is bound to ${boundKinds.join(", ")} work items, and this work item is a ${kind}. Pick a prompt bound to ${kind}, or clear the prompt selection to use the ${kind} template.`,
		{ kind, promptLabel, documentType, boundKinds },
	);
}

/**
 * Read the kind scopes a prompt's bindings carry at one document type, then
 * assert the work item's kind against them.
 *
 * Binding visibility mirrors `listAvailablePromptsForAgent` — the query that
 * built the list the reviewer picked from — so this guard refuses cross-kind
 * choices without refusing choices the product itself offered. Tenant access to
 * the prompt RECORD is enforced by the caller (`getPromptById` on the api
 * paths); what is read here is only the binding's kind scope.
 *
 * `targetKey` is deliberately not filtered: the Clean Spec prompts are bound
 * under a different agent per kind, so pinning the agent name would make the
 * lookup circular. `documentType` is the axis that separates one action's
 * prompts from another's.
 */
export async function validatePromptForKind({
	promptId,
	promptLabel,
	kind,
	documentType,
	userId,
	organizationId,
}: {
	promptId: string;
	promptLabel: string;
	kind: StoryKind;
	documentType: string;
	userId?: string;
	organizationId?: string;
}): Promise<void> {
	const scopeConditions: Array<
		| { scope: "SYSTEM" }
		| { scope: "ORG"; organizationId: string }
		| { scope: "USER"; userId: string }
	> = [{ scope: "SYSTEM" }];
	if (organizationId) {
		scopeConditions.push({ scope: "ORG", organizationId });
	}
	if (userId) {
		scopeConditions.push({ scope: "USER", userId });
	}

	const bindings = await db.promptBinding.findMany({
		where: {
			targetType: "AGENT",
			documentType,
			promptVersion: { promptId },
			OR: scopeConditions,
		},
		select: { storyKind: true },
	});

	assertPromptKindCompatible({
		kindScopes: bindings.map((binding) => binding.storyKind),
		kind,
		promptLabel,
		documentType,
	});
}
