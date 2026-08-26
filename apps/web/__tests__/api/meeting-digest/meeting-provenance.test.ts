import { beforeEach, describe, expect, it, vi } from "vitest";

const { findFirst } = vi.hoisted(() => ({
	findFirst: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		db: { ...actual.db, projectMeetingTranscript: { findFirst } },
	};
});

import { resolveMeetingTranscriptForProposal } from "@repo/api/modules/projects/lib/meeting-provenance";

describe("resolveMeetingTranscriptForProposal", () => {
	beforeEach(() => vi.clearAllMocks());

	it("returns null for non-meeting proposal sources without querying", async () => {
		const res = await resolveMeetingTranscriptForProposal({
			projectId: "p1",
			proposalId: "prop1",
			proposalSource: "TEAMS_CHANNEL",
		});
		expect(res).toBeNull();
		expect(findFirst).not.toHaveBeenCalled();
	});

	it("resolves the transcript by analyzedProposalId for MONITORED_MEETING", async () => {
		findFirst.mockResolvedValue({ id: "cuid1" });
		const res = await resolveMeetingTranscriptForProposal({
			projectId: "p1",
			proposalId: "prop1",
			proposalSource: "MONITORED_MEETING",
		});
		expect(res).toEqual({ id: "cuid1" });
		expect(findFirst).toHaveBeenCalledWith({
			where: { projectId: "p1", analyzedProposalId: "prop1" },
			select: { id: true },
		});
	});

	it("returns null when no transcript carries the back-link", async () => {
		findFirst.mockResolvedValue(null);
		const res = await resolveMeetingTranscriptForProposal({
			projectId: "p1",
			proposalId: "prop1",
			proposalSource: "MONITORED_MEETING",
		});
		expect(res).toBeNull();
	});

	it("falls back to sourceMetadata.transcriptRecordId when the back-link finds nothing", async () => {
		findFirst.mockResolvedValueOnce(null); // back-link miss
		findFirst.mockResolvedValueOnce({ id: "cuid9" }); // metadata hit
		const res = await resolveMeetingTranscriptForProposal({
			projectId: "p1",
			proposalId: "prop9",
			proposalSource: "MONITORED_MEETING",
			sourceMetadata: { transcriptRecordId: "cuid9", actionItemId: "a1" },
		});
		expect(res).toEqual({ id: "cuid9" });
		expect(findFirst).toHaveBeenNthCalledWith(2, {
			where: { projectId: "p1", id: "cuid9" },
			select: { id: true },
		});
	});

	it("returns null when neither back-link nor metadata resolve", async () => {
		findFirst.mockResolvedValueOnce(null);
		const res = await resolveMeetingTranscriptForProposal({
			projectId: "p1",
			proposalId: "prop9",
			proposalSource: "MONITORED_MEETING",
			sourceMetadata: { note: "no transcript ref" },
		});
		expect(res).toBeNull();
		expect(findFirst).toHaveBeenCalledTimes(1); // no metadata query without a usable id
	});
});
