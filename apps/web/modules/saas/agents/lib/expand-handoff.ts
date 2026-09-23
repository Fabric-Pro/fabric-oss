import type { AttachedFile } from "@saas/shared/components/copilot/use-copilot-document-upload";

/**
 * What the ⌘J drawer hands the full page when the user clicks Expand
 * (Fizzy #2040): the unsent draft, the attached files and the project.
 *
 * Held in the launcher provider's memory rather than in sessionStorage. The
 * provider is mounted by `AppWrapper`, above the route, so it survives the
 * client navigation Expand performs — and in memory an attached file keeps
 * its `File`, which storage could not carry. Where the navigation remounts
 * the shell (personal context), the handoff goes with it, exactly as the
 * conversation's in-flight state does.
 */
export interface ExpandHandoff {
	/** The drawer conversation the page will open, `null` for a new chat. */
	conversationId: string | null;
	draft: string;
	attachments: AttachedFile[];
	projectId: string | null;
	createdAt: number;
}

/**
 * How long a handoff waits to be taken. One client navigation takes well
 * under this; an older one belongs to an Expand whose page never mounted.
 */
const EXPAND_HANDOFF_MAX_AGE_MS = 60_000;

/**
 * Files that can move: queued (still to upload with the next send) or
 * already uploaded. One mid-upload or failed would arrive in a state the
 * page's composer cannot resume.
 */
export function transferableAttachments(
	attachments: readonly AttachedFile[],
): AttachedFile[] {
	return attachments.filter(
		(file) =>
			file.status === "pending" ||
			(file.status === "ready" && Boolean(file.documentId)),
	);
}

export function buildExpandHandoff(input: {
	conversationId: string | null;
	draft: string;
	attachments: readonly AttachedFile[];
	projectId: string | null | undefined;
	now: number;
}): ExpandHandoff | null {
	const attachments = transferableAttachments(input.attachments);
	const draft = input.draft.trim() ? input.draft : "";
	const projectId = input.projectId ?? null;
	if (!draft && attachments.length === 0 && !projectId) {
		return null;
	}
	return {
		conversationId: input.conversationId,
		draft,
		attachments,
		projectId,
		createdAt: input.now,
	};
}

/**
 * Whether the page that just opened `conversationId` is the one this
 * handoff was written for. Taken at most once: the caller clears it.
 */
export function isExpandHandoffFor(
	handoff: ExpandHandoff | null,
	conversationId: string | null,
	now: number,
): handoff is ExpandHandoff {
	if (!handoff) {
		return false;
	}
	if (now - handoff.createdAt > EXPAND_HANDOFF_MAX_AGE_MS) {
		return false;
	}
	return handoff.conversationId === (conversationId ?? null);
}
