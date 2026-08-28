/**
 * Register a monitored Slack channel as a ProjectContext INTEGRATION row
 * (Fizzy #2228).
 *
 * The Slack sibling of `teams-integration-context.ts`, and it exists for a
 * sharper reason than symmetry. A Slack channel linked from **Project
 * Settings** got a `ProjectLinkedSlackChannel` row and nothing else — no
 * `ProjectContext` at all. Conversation capture hangs its bundles off the
 * channel's context row, so without a pointer row capture is not merely
 * degraded for those channels, it is a permanent no-op: there is no parent to
 * find, forever.
 *
 * Only the Add-Context dialog and the project wizard were writing a Slack
 * INTEGRATION row, and the shape they write is the one this file matches
 * against and reproduces: `{ provider: "SLACK", channelId, channelName }`.
 * Matching on `channelId` alone — not on `(slackTeamId, channelId)` — is
 * deliberate: those two writers never persist a workspace id, so keying on it
 * would fail to recognize every row they created and cheerfully add a second
 * context row beside each one. `linkChannelProcedure` already reads them back
 * by `metadata.channelId` for the same reason.
 *
 * The find-then-create guard is not atomic — `metadata` is a JSON column with
 * no unique index, exactly as on the Teams side. A rare concurrent double-link
 * could create a duplicate INTEGRATION row (a redundant, harmless picker
 * entry). Acceptable because callers invoke this best-effort and non-fatally.
 */
import { db } from "../../client";
import { createContext } from "./contexts";

function readMetadata(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

export function buildSlackChannelContextMetadata(params: {
	channelId: string;
	channelName?: string | null;
	slackTeamId?: string | null;
	teamName?: string | null;
	channelWebUrl?: string | null;
}): Record<string, unknown> {
	const displayName = params.channelName
		? `#${params.channelName}`
		: "Slack channel";
	return {
		provider: "SLACK",
		channelId: params.channelId,
		title: displayName,
		...(params.channelName ? { channelName: params.channelName } : {}),
		// Written when known, never REQUIRED to match. See the file header:
		// the Add-Context writers have no workspace id, so this is enrichment
		// for readers that want it, not part of the identity.
		...(params.slackTeamId ? { slackTeamId: params.slackTeamId } : {}),
		...(params.teamName ? { teamName: params.teamName } : {}),
		...(params.channelWebUrl
			? { channelWebUrl: params.channelWebUrl }
			: {}),
	};
}

/** True when `metadata` already describes this monitored Slack channel. */
export function slackChannelContextMatches(
	metadata: unknown,
	params: { channelId: string },
): boolean {
	const m = readMetadata(metadata);
	return m?.provider === "SLACK" && m?.channelId === params.channelId;
}

/**
 * Idempotently ensure a ProjectContext INTEGRATION row exists for a monitored
 * Slack channel. Returns whether a row was created.
 *
 * Called from the LINK procedure, at link time — never from the capture path.
 * Capture locating its parent through `slackChannelContextMatches` and finding
 * nothing is the correct outcome for an unlinked channel; a capture-time
 * ensure would resurrect the pointer row for a channel the user just removed.
 *
 * Bypasses the Add-Context count cap, matching the Teams helper: a monitored
 * channel must always be selectable regardless of how many contexts the
 * project already has.
 */
export async function ensureSlackChannelIntegrationContext(params: {
	projectId: string;
	channelId: string;
	channelName?: string | null;
	slackTeamId?: string | null;
	teamName?: string | null;
	channelWebUrl?: string | null;
	userId: string;
	organizationId?: string;
}): Promise<{ created: boolean; contextId: string }> {
	const existing = await db.projectContext.findMany({
		where: { projectId: params.projectId, type: "INTEGRATION" },
		select: { id: true, metadata: true },
	});
	const match = existing.find((ctx) =>
		slackChannelContextMatches(ctx.metadata, params),
	);
	if (match) {
		return { created: false, contextId: match.id };
	}
	const created = await createContext({
		projectId: params.projectId,
		type: "INTEGRATION",
		content: "",
		metadata: buildSlackChannelContextMetadata(params),
		extractionStatus: "COMPLETED",
		userId: params.userId,
		organizationId: params.organizationId,
	});
	return { created: true, contextId: created.id };
}
