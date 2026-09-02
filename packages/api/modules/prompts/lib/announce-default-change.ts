import {
	db,
	listActionsForPrompt,
	listPromptDefaultAudience,
	markOwnOverrides,
	type PromptDefaultAudience,
} from "@repo/database";
import { logger } from "@repo/logs";
import {
	findPromptAgentTarget,
	promptActionId,
	promptDocumentTypeLabel,
} from "@repo/utils/prompt-action-catalog";
import { fanOut } from "../../../lib/notification-service";
import { resolveOrgBasePath } from "./org-base-path";

/**
 * What every announcement for one prompt version shares: the prompt's name, its
 * change note and the link's base path depend on the version and the tier, never
 * on which action is being announced.
 *
 * Resolved lazily and at most once. Lazily because the common outcome is that an
 * action has nobody to tell — the actor is excluded, and often they are the only
 * one — and neither lookup is worth doing to then send nothing. Once because a
 * prompt that wins N actions would otherwise refetch the same row and re-derive
 * the same path N times on the author's save.
 */
type AnnounceContext = {
	scope: "SYSTEM" | "ORG";
	organizationId: string | null | undefined;
	actorUserId: string;
	shared: () => Promise<SharedAnnouncement | null>;
};

type SharedAnnouncement = {
	promptId: string;
	promptName: string;
	changeNote: string | null;
	basePath: string;
	/** Who is subject to this tier — the same people for every action. */
	audience: PromptDefaultAudience;
};

function announceContext({
	scope,
	organizationId,
	promptVersionId,
	actorUserId,
}: {
	scope: "SYSTEM" | "ORG";
	organizationId: string | null | undefined;
	promptVersionId: string;
	actorUserId: string;
}): AnnounceContext {
	let pending: Promise<SharedAnnouncement | null> | undefined;

	const resolve = async (): Promise<SharedAnnouncement | null> => {
		// Audience first: it decides whether any of the rest is worth doing. With
		// the actor excluded there is often nobody left, and a prompt name and a
		// base path are wasted work when the answer is "tell no one".
		const audience = await listPromptDefaultAudience({
			scope,
			organizationId,
			excludeUserId: actorUserId,
		});
		if (audience.length === 0) {
			return null;
		}

		const version = await db.promptVersion.findUnique({
			where: { id: promptVersionId },
			select: {
				changeNote: true,
				prompt: { select: { id: true, name: true } },
			},
		});
		if (!version) {
			return null;
		}

		// FR8: lands on the action in the catalog, where the reader can switch.
		// An ORG change links into that organization's own context; a SYSTEM
		// change stays on /app, because its audience spans every organization.
		const basePath =
			scope === "ORG" ? await resolveOrgBasePath(organizationId) : "/app";

		return {
			promptId: version.prompt.id,
			promptName: version.prompt.name,
			changeNote: version.changeNote,
			basePath,
			audience,
		};
	};

	return {
		scope,
		organizationId,
		actorUserId,
		shared: () => {
			pending ??= resolve();
			return pending;
		},
	};
}

/**
 * The recipient list is resolved per action, not per prompt: whether a reader
 * already holds their own override for THIS action decides how the notice is
 * framed, so two actions of the same prompt can address the same person
 * differently.
 */
async function announceForAction(
	context: AnnounceContext,
	{
		targetKey,
		documentType,
		storyKind,
	}: { targetKey: string; documentType: string; storyKind: string | null },
) {
	const shared = await context.shared();
	if (!shared) {
		return;
	}

	const recipients = await markOwnOverrides({
		audience: shared.audience,
		targetKey,
		documentType,
		storyKind,
	});
	if (recipients.length === 0) {
		return;
	}

	const agent = findPromptAgentTarget(targetKey);
	const actionLabel = agent
		? `${agent.label} — ${promptDocumentTypeLabel(documentType)}`
		: promptDocumentTypeLabel(documentType);

	await fanOut.promptDefaultUpdated({
		recipients,
		scope: context.scope,
		promptId: shared.promptId,
		promptName: shared.promptName,
		targetKey,
		documentType,
		storyKind,
		actionLabel,
		changeNote: shared.changeNote,
		link: `${shared.basePath}/prompts/catalog?action=${encodeURIComponent(
			promptActionId(
				targetKey,
				documentType,
				(storyKind as "FEATURE" | "BUG" | null) ?? null,
			),
		)}`,
		actorUserId: context.actorUserId,
	});
}

/**
 * Tell the people subject to a tier's default that it changed (FR6).
 *
 * Fire-and-forget on purpose: the binding is already written and correct, and a
 * notification failure must not fail the write or leave the caller thinking the
 * bind did not happen. Failures are logged inside the fan-out.
 *
 * Only SYSTEM and ORG. A personal default affects exactly the person who set
 * it, and telling them what they just did is noise.
 *
 * Shared between setting a default directly and approving a nomination that
 * sets one — the people affected and the message they need are identical, and
 * the moment there are two of these one of them starts lying about the link.
 */
export async function announceDefaultChange({
	scope,
	organizationId,
	targetKey,
	documentType,
	storyKind,
	promptVersionId,
	actorUserId,
}: {
	scope: "SYSTEM" | "ORG" | "USER";
	organizationId: string | null | undefined;
	targetKey: string;
	documentType: string;
	storyKind: string | null;
	promptVersionId: string;
	actorUserId: string;
}) {
	if (scope === "USER") {
		return;
	}

	await announceForAction(
		announceContext({
			scope,
			organizationId,
			promptVersionId,
			actorUserId,
		}),
		{ targetKey, documentType, storyKind },
	);
}

/**
 * The other half of FR6: a prompt's body was edited, and `createPromptVersion`
 * has repointed every same-scope binding at the new version. Publishing a
 * default and editing a published one are the same event to the reader, so both
 * announce — but an edit has no single action to name, only however many the
 * prompt currently wins.
 *
 * Lives here rather than in the procedure because the bind path already owns
 * "announce a default change" and a second copy is how the two start disagreeing
 * about who hears and what the link says.
 *
 * Every announcement is attempted even when an earlier one fails: they address
 * different actions and different readers, so one dead notification must not
 * silence the rest. Callers get no error — the version is already written, and
 * failing the author's save over a notification would be a worse outcome than a
 * missing bell.
 */
export async function announceDefaultChangeForWinningActions({
	promptId,
	scope,
	organizationId,
	promptVersionId,
	actorUserId,
}: {
	promptId: string;
	scope: "SYSTEM" | "ORG" | "USER";
	organizationId: string | null | undefined;
	promptVersionId: string;
	actorUserId: string;
}) {
	if (scope === "USER") {
		return;
	}

	try {
		const actions = await listActionsForPrompt({
			promptId,
			userId: actorUserId,
			organizationId: organizationId ?? undefined,
		});
		// Only the actions this prompt actually wins, at this prompt's own tier:
		// a bound-but-shadowed prompt changes nobody's runtime, and a binding at
		// another tier was never repointed by this edit.
		const winning = actions.filter(
			(action) => action.isDefault && action.scope === scope,
		);
		if (winning.length === 0) {
			return;
		}

		const context = announceContext({
			scope,
			organizationId,
			promptVersionId,
			actorUserId,
		});

		const settled = await Promise.allSettled(
			winning.map((action) =>
				announceForAction(context, {
					targetKey: action.targetKey,
					documentType: action.documentType,
					storyKind: action.storyKind ?? null,
				}),
			),
		);
		for (const [index, result] of settled.entries()) {
			if (result.status === "rejected") {
				logger.error(
					{
						error: result.reason,
						promptId,
						versionId: promptVersionId,
						targetKey: winning[index]?.targetKey,
					},
					"[prompts] failed to announce an edited default",
				);
			}
		}
	} catch (error) {
		logger.error(
			{ error, promptId, versionId: promptVersionId },
			"[prompts] failed to announce an edited default",
		);
	}
}
