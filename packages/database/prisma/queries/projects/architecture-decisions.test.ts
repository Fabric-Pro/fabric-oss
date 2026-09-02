import { beforeEach, describe, expect, it, vi } from "vitest";

// Unit-test the pure-ish query helpers without a database.
const adFindFirst = vi.fn();
const adFindMany = vi.fn();
const adGroupBy = vi.fn();
const adUpdate = vi.fn();
const adFindUnique = vi.fn();
const transcriptFindMany = vi.fn();

vi.mock("../../client", () => ({
	db: {
		architectureDecision: {
			findFirst: (...a: unknown[]) => adFindFirst(...a),
			findMany: (...a: unknown[]) => adFindMany(...a),
			groupBy: (...a: unknown[]) => adGroupBy(...a),
			update: (...a: unknown[]) => adUpdate(...a),
			findUnique: (...a: unknown[]) => adFindUnique(...a),
		},
		projectMeetingTranscript: {
			findMany: (...a: unknown[]) => transcriptFindMany(...a),
		},
	},
}));

import {
	acknowledgeArchitectureDecision,
	countArchitectureDecisionsByStatus,
	generateArchitectureDecisionIdentifier,
	getAcceptedDecisionsForGuidance,
	listMeetingDecisionCandidates,
} from "./architecture-decisions";

describe("countArchitectureDecisionsByStatus", () => {
	beforeEach(() => adGroupBy.mockReset());

	it("returns total and proposed counts from grouped statuses", async () => {
		adGroupBy.mockResolvedValue([
			{ status: "PROPOSED", _count: { _all: 2 } },
			{ status: "ACCEPTED", _count: { _all: 3 } },
			{ status: "REJECTED", _count: { _all: 1 } },
		]);

		await expect(countArchitectureDecisionsByStatus("p1")).resolves.toEqual(
			{
				total: 6,
				proposed: 2,
			},
		);
		expect(adGroupBy).toHaveBeenCalledWith({
			by: ["status"],
			where: { projectId: "p1", deletedAt: null },
			_count: { _all: true },
		});
	});

	it("returns zero counts when the project has no decisions", async () => {
		adGroupBy.mockResolvedValue([]);

		await expect(countArchitectureDecisionsByStatus("p1")).resolves.toEqual(
			{
				total: 0,
				proposed: 0,
			},
		);
	});
});

describe("generateArchitectureDecisionIdentifier", () => {
	beforeEach(() => adFindFirst.mockReset());

	it("returns ADR-001 for the first decision in a project", async () => {
		adFindFirst.mockResolvedValue(null);
		expect(await generateArchitectureDecisionIdentifier("p1")).toBe(
			"ADR-001",
		);
	});

	it("increments and zero-pads from the latest identifier", async () => {
		adFindFirst.mockResolvedValue({ identifier: "ADR-009" });
		expect(await generateArchitectureDecisionIdentifier("p1")).toBe(
			"ADR-010",
		);
	});

	it("does not break past the 3-digit padding boundary", async () => {
		adFindFirst.mockResolvedValue({ identifier: "ADR-128" });
		expect(await generateArchitectureDecisionIdentifier("p1")).toBe(
			"ADR-129",
		);
	});
});

describe("listMeetingDecisionCandidates", () => {
	beforeEach(() => {
		transcriptFindMany.mockReset();
		adFindMany.mockReset();
	});

	it("flattens extracted decisions, skips blanks, flags converted ones", async () => {
		transcriptFindMany.mockResolvedValue([
			{
				id: "t1",
				meetingId: "m1",
				meetingSubject: "Arch sync",
				meetingDate: new Date("2026-05-01"),
				extractedDecisions: [
					{ text: "Use Temporal" },
					{ text: "  " }, // skipped — blank
					{ text: "Adopt Qdrant", relatedStoryIdentifier: "F-3" },
				],
			},
			{
				id: "t2",
				meetingId: "m2",
				meetingSubject: null,
				meetingDate: null,
				extractedDecisions: null, // no decisions
			},
		]);
		adFindMany.mockResolvedValue([
			{
				sourceKind: "meeting_decision",
				sourceMetadata: { transcriptId: "t1", decisionIndex: 0 },
			},
		]);

		const result = await listMeetingDecisionCandidates({
			projectId: "p1",
			organizationId: null,
		});

		expect(result).toHaveLength(2);
		const temporal = result.find((c) => c.text === "Use Temporal");
		const qdrant = result.find((c) => c.text === "Adopt Qdrant");
		expect(temporal?.alreadyConverted).toBe(true);
		expect(temporal?.decisionIndex).toBe(0);
		expect(qdrant?.alreadyConverted).toBe(false);
		expect(qdrant?.decisionIndex).toBe(2); // index preserved across the skipped blank
		expect(qdrant?.relatedStoryIdentifier).toBe("F-3");
	});

	it("returns an empty list when there are no transcripts", async () => {
		transcriptFindMany.mockResolvedValue([]);
		adFindMany.mockResolvedValue([]);
		const result = await listMeetingDecisionCandidates({ projectId: "p1" });
		expect(result).toEqual([]);
	});
});

describe("getAcceptedDecisionsForGuidance", () => {
	beforeEach(() => adFindMany.mockReset());

	it("sorts Priority-flagged decisions first, then by date", async () => {
		adFindMany.mockResolvedValue([]);
		await getAcceptedDecisionsForGuidance({ projectId: "p1" });
		expect(adFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					projectId: "p1",
					status: "ACCEPTED",
				}),
				orderBy: [
					{ priorityFlagged: "desc" },
					{ decisionDate: "desc" },
				],
			}),
		);
	});
});

describe("acknowledgeArchitectureDecision", () => {
	beforeEach(() => {
		adFindFirst.mockReset();
		adUpdate.mockReset();
		adFindUnique.mockReset();
	});

	// The guard is the query itself: the row is matched on ownerUserId, so a
	// non-owner cannot acknowledge even if the procedure above it let them in.
	it("refuses when the caller is not the decision's owner", async () => {
		adFindFirst.mockResolvedValue(null);
		const out = await acknowledgeArchitectureDecision({
			id: "d1",
			projectId: "p1",
			ownerUserId: "not-the-owner",
		});
		expect(out).toBeNull();
		expect(adUpdate).not.toHaveBeenCalled();
		expect(adFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					id: "d1",
					projectId: "p1",
					ownerUserId: "not-the-owner",
				}),
			}),
		);
	});

	it("stamps ownerAcknowledgedAt for the owner", async () => {
		adFindFirst.mockResolvedValue({ id: "d1", ownerAcknowledgedAt: null });
		adFindUnique.mockResolvedValue({ id: "d1" });
		await acknowledgeArchitectureDecision({
			id: "d1",
			projectId: "p1",
			ownerUserId: "owner-1",
		});
		expect(adUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "d1" },
				data: { ownerAcknowledgedAt: expect.any(Date) },
			}),
		);
	});

	// Re-stamping would rewrite when the owner first accepted, which is the
	// only fact the column exists to record.
	it("keeps the original timestamp when already acknowledged", async () => {
		adFindFirst.mockResolvedValue({
			id: "d1",
			ownerAcknowledgedAt: new Date("2026-08-01T00:00:00.000Z"),
		});
		adFindUnique.mockResolvedValue({ id: "d1" });
		await acknowledgeArchitectureDecision({
			id: "d1",
			projectId: "p1",
			ownerUserId: "owner-1",
		});
		expect(adUpdate).not.toHaveBeenCalled();
	});
});
