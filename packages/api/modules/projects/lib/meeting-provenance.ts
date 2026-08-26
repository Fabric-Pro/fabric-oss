import { db } from "@repo/database";

/**
 * #1814: resolve the digest meeting a proposal came from, for stamping
 * `UserStory.sourceMeetingTranscriptId` on approve. Uses the existing
 * `ProjectMeetingTranscript.analyzedProposalId` back-link (set by
 * markMeetingTranscriptScanned) so it works for every historical proposal
 * without a sourceMetadata migration. Null for non-meeting sources and for
 * legacy rows whose back-link was never written — stamping is best-effort.
 *
 * #1823: falls back to `sourceMetadata.transcriptRecordId` when the
 * back-link finds nothing — per-action-item proposals never own that
 * back-link (it belongs to the meeting-level auto-analyze proposal).
 */
export async function resolveMeetingTranscriptForProposal(params: {
	projectId: string;
	proposalId: string;
	proposalSource: string;
	sourceMetadata?: unknown;
}): Promise<{ id: string } | null> {
	if (params.proposalSource !== "MONITORED_MEETING") {
		return null;
	}
	const viaBackLink = await db.projectMeetingTranscript.findFirst({
		where: {
			projectId: params.projectId,
			analyzedProposalId: params.proposalId,
		},
		select: { id: true },
	});
	if (viaBackLink) {
		return viaBackLink;
	}
	// #1823: per-action-item proposals never own the transcript's
	// analyzedProposalId back-link (that belongs to the meeting-level
	// auto-analyze proposal). They carry the transcript row id in their
	// sourceMetadata instead.
	const meta = (params.sourceMetadata ?? {}) as Record<string, unknown>;
	const transcriptRecordId =
		typeof meta.transcriptRecordId === "string"
			? meta.transcriptRecordId
			: null;
	if (!transcriptRecordId) {
		return null;
	}
	return db.projectMeetingTranscript.findFirst({
		where: { projectId: params.projectId, id: transcriptRecordId },
		select: { id: true },
	});
}
