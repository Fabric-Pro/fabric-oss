import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	proposalFindUnique: vi.fn(),
	proposalUpdateMany: vi.fn(),
	storyFindFirst: vi.fn(),
}));

vi.mock("../../../client", () => ({
	db: {
		pendingBacklogProposal: {
			findUnique: (...a: unknown[]) => mocks.proposalFindUnique(...a),
			updateMany: (...a: unknown[]) => mocks.proposalUpdateMany(...a),
		},
		userStory: {
			findFirst: (...a: unknown[]) => mocks.storyFindFirst(...a),
		},
	},
}));

import {
	refreshRecurringErrorProposalEvidence,
	resolveSignatureTracking,
} from "../recurring-error-signatures";

const SIGNATURE = {
	projectId: "proj_1",
	pendingProposalId: "prop_1",
	storyId: null,
};

const OPEN_STORY = {
	id: "story_1",
	project: { organizationId: "org_example" },
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.storyFindFirst.mockResolvedValue(null);
	mocks.proposalUpdateMany.mockResolvedValue({ count: 1 });
});

describe("refreshRecurringErrorProposalEvidence", () => {
	const filed = {
		status: "PENDING",
		sourceMetadata: {
			recurringError: { fingerprint: "fp_own", occurrences: 8 },
			transcript: "own evidence v1",
			reporterName: "Fabric recurring-error scan",
		},
	};

	function written() {
		return mocks.proposalUpdateMany.mock.calls.at(-1)?.[0].data
			.sourceMetadata;
	}

	it("replaces the proposal's own evidence when its own group recurs", async () => {
		mocks.proposalFindUnique.mockResolvedValue(filed);

		await refreshRecurringErrorProposalEvidence("prop_1", {
			fingerprint: "fp_own",
			title: "Own error",
			recurringError: { fingerprint: "fp_own", occurrences: 12 },
			transcript: "own evidence v2",
		});

		expect(written()).toMatchObject({
			recurringError: { occurrences: 12 },
			transcript: "own evidence v2",
			relatedErrors: [],
			reporterName: "Fabric recurring-error scan",
		});
	});

	it("keeps another group of the same problem beside the proposal's own evidence", async () => {
		mocks.proposalFindUnique.mockResolvedValue(filed);

		await refreshRecurringErrorProposalEvidence("prop_1", {
			fingerprint: "fp_related",
			title: "Related error",
			recurringError: { fingerprint: "fp_related", occurrences: 5 },
			transcript: "related evidence",
		});

		const metadata = written();
		expect(metadata.recurringError).toEqual({
			fingerprint: "fp_own",
			occurrences: 8,
		});
		expect(metadata.recurringErrorEvidence).toBe("own evidence v1");
		expect(metadata.relatedErrors).toEqual([
			expect.objectContaining({
				fingerprint: "fp_related",
				evidence: "related evidence",
			}),
		]);
		expect(metadata.transcript).toBe(
			[
				"own evidence v1",
				"",
				"Other recurring errors the scan judged to be the same problem:",
				"",
				"#### Related error",
				"",
				"related evidence",
			].join("\n"),
		);
	});

	it("refreshes each group's evidence without overwriting the other's", async () => {
		mocks.proposalFindUnique.mockResolvedValue({
			status: "PENDING",
			sourceMetadata: {
				recurringError: { fingerprint: "fp_own" },
				recurringErrorEvidence: "own evidence v1",
				relatedErrors: [
					{
						fingerprint: "fp_related",
						title: "Related error",
						evidence: "related evidence v1",
						recurringError: {},
					},
				],
				transcript: "composed",
			},
		});

		await refreshRecurringErrorProposalEvidence("prop_1", {
			fingerprint: "fp_own",
			title: "Own error",
			recurringError: { fingerprint: "fp_own" },
			transcript: "own evidence v2",
		});

		const metadata = written();
		expect(metadata.transcript).toContain("own evidence v2");
		expect(metadata.transcript).toContain("related evidence v1");
		expect(metadata.relatedErrors).toHaveLength(1);
	});

	it("leaves a proposal that is no longer pending alone", async () => {
		mocks.proposalFindUnique.mockResolvedValue({
			...filed,
			status: "APPLIED",
		});

		expect(
			await refreshRecurringErrorProposalEvidence("prop_1", {
				fingerprint: "fp_related",
				title: "Related error",
				recurringError: {},
				transcript: "related evidence",
			}),
		).toBe(false);
		expect(mocks.proposalUpdateMany).not.toHaveBeenCalled();
	});
});

describe("resolveSignatureTracking", () => {
	it("follows an applied proposal to the story its application row created", async () => {
		mocks.proposalFindUnique.mockResolvedValue({
			id: "prop_1",
			status: "APPLIED",
			applications: [{ createdEntityId: "story_1" }],
		});
		mocks.storyFindFirst.mockResolvedValue(OPEN_STORY);

		expect(await resolveSignatureTracking(SIGNATURE)).toEqual({
			state: "open-story",
			storyId: "story_1",
			organizationId: "org_example",
		});
		expect(mocks.storyFindFirst).toHaveBeenCalledTimes(1);
	});

	it("finds the story an approve path linked by createdFromProposalId when no application row exists", async () => {
		mocks.proposalFindUnique.mockResolvedValue({
			id: "prop_1",
			status: "APPLIED",
			applications: [],
		});
		mocks.storyFindFirst
			.mockResolvedValueOnce({ id: "story_1" })
			.mockResolvedValueOnce(OPEN_STORY);

		expect(await resolveSignatureTracking(SIGNATURE)).toEqual({
			state: "open-story",
			storyId: "story_1",
			organizationId: "org_example",
		});
		expect(mocks.storyFindFirst.mock.calls[0]?.[0]).toMatchObject({
			where: { createdFromProposalId: "prop_1", projectId: "proj_1" },
		});
		expect(mocks.storyFindFirst.mock.calls[1]?.[0]).toMatchObject({
			where: { id: "story_1", projectId: "proj_1" },
		});
	});

	it("files again when the applied proposal's story is closed", async () => {
		mocks.proposalFindUnique.mockResolvedValue({
			id: "prop_1",
			status: "APPLIED",
			applications: [],
		});
		mocks.storyFindFirst
			.mockResolvedValueOnce({ id: "story_1" })
			.mockResolvedValueOnce(null);

		expect(await resolveSignatureTracking(SIGNATURE)).toEqual({
			state: "none",
		});
	});

	it("files again when an applied proposal created no story at all", async () => {
		mocks.proposalFindUnique.mockResolvedValue({
			id: "prop_1",
			status: "APPLIED",
			applications: [],
		});

		expect(await resolveSignatureTracking(SIGNATURE)).toEqual({
			state: "none",
		});
		expect(mocks.storyFindFirst).toHaveBeenCalledTimes(1);
	});
});
