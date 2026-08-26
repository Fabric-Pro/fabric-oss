import { db, listPromptDefaultRecipients } from "@repo/database";
import {
	findPromptAgentTarget,
	promptActionId,
	promptDocumentTypeLabel,
} from "@repo/utils/prompt-action-catalog";
import { fanOut } from "../../../lib/notification-service";
import { resolveOrgBasePath } from "./org-base-path";

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

	const version = await db.promptVersion.findUnique({
		where: { id: promptVersionId },
		select: {
			changeNote: true,
			prompt: { select: { id: true, name: true } },
		},
	});
	if (!version) {
		return;
	}

	const recipients = await listPromptDefaultRecipients({
		scope,
		organizationId,
		targetKey,
		documentType,
		storyKind,
		excludeUserId: actorUserId,
	});
	if (recipients.length === 0) {
		return;
	}

	const agent = findPromptAgentTarget(targetKey);
	const actionLabel = agent
		? `${agent.label} — ${promptDocumentTypeLabel(documentType)}`
		: promptDocumentTypeLabel(documentType);

	// FR8: lands on the action in the catalog, where the reader can switch. An
	// ORG change links into that organization's own context; a SYSTEM change
	// stays on /app, because its audience spans every organization.
	const basePath =
		scope === "ORG" ? await resolveOrgBasePath(organizationId) : "/app";

	await fanOut.promptDefaultUpdated({
		recipients,
		scope,
		promptId: version.prompt.id,
		promptName: version.prompt.name,
		targetKey,
		documentType,
		storyKind,
		actionLabel,
		changeNote: version.changeNote,
		link: `${basePath}/prompts/catalog?action=${encodeURIComponent(
			promptActionId(
				targetKey,
				documentType,
				(storyKind as "FEATURE" | "BUG" | null) ?? null,
			),
		)}`,
		actorUserId,
	});
}
