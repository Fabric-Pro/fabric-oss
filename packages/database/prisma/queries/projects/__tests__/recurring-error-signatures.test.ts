import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	proposalFindUnique: vi.fn(),
	proposalFindFirst: vi.fn(),
	proposalUpdateMany: vi.fn(),
	storyFindFirst: vi.fn(),
	signatureUpdate: vi.fn(),
}));

vi.mock("../../../client", () => ({
	db: {
		recurringErrorSignature: {
			update: (...a: unknown[]) => mocks.signatureUpdate(...a),
		},
		pendingBacklogProposal: {
			findUnique: (...a: unknown[]) => mocks.proposalFindUnique(...a),
			findFirst: (...a: unknown[]) => mocks.proposalFindFirst(...a),
			updateMany: (...a: unknown[]) => mocks.proposalUpdateMany(...a),
		},
		userStory: {
			findFirst: (...a: unknown[]) => mocks.storyFindFirst(...a),
		},
	},
}));

import {
	linkRecurringErrorSignature,
	recordRecurringErrorProposalAbsence,
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
	mocks.storyFindFirst.mockReset().mockResolvedValue(null);
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

	it.each([
		[undefined, [{ identifier: "B-1" }]],
		[[], []],
		[[{ identifier: "B-2" }], [{ identifier: "B-2" }]],
		[null, null],
	])(
		"preserves the original check unless the refresh supplies %j",
		async (incoming, expected) => {
			mocks.proposalFindUnique.mockResolvedValue({
				...filed,
				sourceMetadata: {
					...filed.sourceMetadata,
					recurringError: {
						fingerprint: "fp_own",
						openBugCheck: [{ identifier: "B-1" }],
					},
				},
			});
			await refreshRecurringErrorProposalEvidence("prop_1", {
				fingerprint: "fp_own",
				title: "Own error",
				transcript: "updated",
				recurringError: {
					fingerprint: "fp_own",
					...(incoming !== undefined
						? { openBugCheck: incoming }
						: {}),
				},
			});
			expect(written().recurringError.openBugCheck).toEqual(expected);
		},
	);

	it.each([undefined, null, "invalid", {}])(
		"does not carry a non-array stored check %j",
		async (stored) => {
			mocks.proposalFindUnique.mockResolvedValue({
				...filed,
				sourceMetadata: {
					recurringError: {
						fingerprint: "fp_own",
						openBugCheck: stored,
					},
				},
			});
			await refreshRecurringErrorProposalEvidence("prop_1", {
				fingerprint: "fp_own",
				title: "Own error",
				transcript: "updated",
				recurringError: { fingerprint: "fp_own" },
			});
			expect(written().recurringError).toEqual({ fingerprint: "fp_own" });
		},
	);

	it("leaves the original check on the own evidence when refreshing a related fingerprint", async () => {
		const own = {
			fingerprint: "fp_own",
			openBugCheck: [{ identifier: "B-1" }],
		};
		mocks.proposalFindUnique.mockResolvedValue({
			...filed,
			sourceMetadata: { ...filed.sourceMetadata, recurringError: own },
		});
		await refreshRecurringErrorProposalEvidence("prop_1", {
			fingerprint: "fp_related",
			title: "Related",
			transcript: "related",
			recurringError: { fingerprint: "fp_related" },
		});
		expect(written().recurringError).toEqual(own);
		expect(written().relatedErrors[0].recurringError).toEqual({
			fingerprint: "fp_related",
		});
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

	it("observes a closed story reached through the applied proposal", async () => {
		mocks.proposalFindUnique.mockResolvedValue({
			id: "prop_1",
			status: "APPLIED",
			applications: [],
		});
		mocks.storyFindFirst
			.mockResolvedValueOnce({ id: "story_1" })
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce({ draftingStage: "CLOSED" });

		expect(await resolveSignatureTracking(SIGNATURE)).toEqual({
			state: "closed-story",
		});
	});

	it.each([
		["CLOSED", false, false, "closed-story"],
		["SPEC", true, false, "closed-story"],
		["SPEC", false, true, "closed-story"],
		["DECLINED", false, false, "declined-story"],
	] as const)(
		"classifies stage %s, final %s, hidden %s as %s",
		async (stage, final, hidden, state) => {
			mocks.storyFindFirst.mockImplementation(async ({ where }) => {
				expect(where).toMatchObject({
					id: "story_1",
					projectId: "proj_1",
				});
				if (where.status) {
					expect(where).toMatchObject({
						draftingStage: { notIn: ["DECLINED", "CLOSED"] },
						pmAutoHidden: false,
						status: { isFinal: false },
					});
					return null;
				}
				return {
					draftingStage: stage,
					status: { isFinal: final },
					pmAutoHidden: hidden,
				};
			});
			expect(
				await resolveSignatureTracking({
					...SIGNATURE,
					storyId: "story_1",
				}),
			).toMatchObject({ state });
			expect(mocks.storyFindFirst).toHaveBeenCalledTimes(2);
			expect(mocks.proposalFindUnique).not.toHaveBeenCalled();
		},
	);

	it("treats a dangling story link as closed, scoped to its project", async () => {
		expect(
			await resolveSignatureTracking({
				...SIGNATURE,
				storyId: "deleted_story",
			}),
		).toEqual({ state: "closed-story" });
		expect(mocks.storyFindFirst).toHaveBeenCalledTimes(2);
		for (const [query] of mocks.storyFindFirst.mock.calls) {
			expect(query.where).toMatchObject({
				id: "deleted_story",
				projectId: "proj_1",
			});
		}
	});

	it("follows the surviving open story after relinking, without consulting the old proposal", async () => {
		mocks.storyFindFirst.mockResolvedValue({
			...OPEN_STORY,
			id: "story_survivor",
		});
		expect(
			await resolveSignatureTracking({
				...SIGNATURE,
				storyId: "story_survivor",
			}),
		).toEqual({
			state: "open-story",
			storyId: "story_survivor",
			organizationId: "org_example",
		});
		expect(mocks.storyFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					id: "story_survivor",
					projectId: "proj_1",
				}),
			}),
		);
		expect(mocks.proposalFindUnique).not.toHaveBeenCalled();
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

describe("linkRecurringErrorSignature", () => {
	it.each([null, new Date("2026-11-13T12:00:00Z")])(
		"writes the close stamp %s together with the supplied link",
		async (stamp) => {
			await linkRecurringErrorSignature("sig_1", {
				storyId: "story_1",
				storyClosedSeenAt: stamp,
			});
			expect(mocks.signatureUpdate).toHaveBeenCalledWith({
				where: { id: "sig_1" },
				data: { storyId: "story_1", storyClosedSeenAt: stamp },
			});
		},
	);

	it("leaves the stamp alone when an older caller omits it", async () => {
		await linkRecurringErrorSignature("sig_1", {
			pendingProposalId: "prop_1",
		});
		expect(mocks.signatureUpdate).toHaveBeenCalledWith({
			where: { id: "sig_1" },
			data: { pendingProposalId: "prop_1" },
		});
		expect(mocks.signatureUpdate.mock.calls[0][0].data).not.toHaveProperty(
			"storyClosedSeenAt",
		);
	});
});

describe("absence records", () => {
	const at = new Date("2026-11-13T10:00:00Z");
	const base = {
		recurringError: { fingerprint: "own" },
		transcript: "keep",
		relatedErrors: [],
	};
	it("records a first absence with a project and PENDING compare-and-set", async () => {
		mocks.proposalFindFirst.mockResolvedValue({ sourceMetadata: base });
		await recordRecurringErrorProposalAbsence("proj_1", "prop_1", at);
		expect(mocks.proposalFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "prop_1",
					projectId: "proj_1",
					source: "LOG_MONITOR",
					status: "PENDING",
				},
			}),
		);
		expect(mocks.proposalUpdateMany).toHaveBeenCalledWith({
			where: {
				id: "prop_1",
				projectId: "proj_1",
				source: "LOG_MONITOR",
				status: "PENDING",
				sourceMetadata: { equals: base },
			},
			data: {
				sourceMetadata: {
					...base,
					recurringErrorAbsence: {
						firstAbsentScanAt: at.toISOString(),
						lastAbsentScanAt: at.toISOString(),
						scans: 1,
					},
				},
			},
		});
	});
	it("increments a later scan, keeps first absence, and skips retries", async () => {
		const first = "2026-11-12T10:00:00.000Z";
		mocks.proposalFindFirst.mockResolvedValue({
			sourceMetadata: {
				...base,
				recurringErrorAbsence: {
					firstAbsentScanAt: first,
					lastAbsentScanAt: first,
					scans: 1,
				},
			},
		});
		await recordRecurringErrorProposalAbsence("proj_1", "prop_1", at);
		const metadata =
			mocks.proposalUpdateMany.mock.calls.at(-1)?.[0].data.sourceMetadata;
		expect(metadata.recurringErrorAbsence).toEqual({
			firstAbsentScanAt: first,
			lastAbsentScanAt: at.toISOString(),
			scans: 2,
		});
		mocks.proposalFindFirst.mockResolvedValue({ sourceMetadata: metadata });
		mocks.proposalUpdateMany.mockClear();
		await recordRecurringErrorProposalAbsence("proj_1", "prop_1", at);
		expect(mocks.proposalUpdateMany).not.toHaveBeenCalled();
	});
	it("does not write a non-PENDING or other-project proposal", async () => {
		mocks.proposalFindFirst.mockResolvedValue(null);
		await recordRecurringErrorProposalAbsence("proj_1", "prop_1", at);
		expect(mocks.proposalUpdateMany).not.toHaveBeenCalled();
	});
	it.each(["own", "related"])(
		"clears absence on %s refresh",
		async (fingerprint) => {
			mocks.proposalFindUnique.mockResolvedValue({
				status: "PENDING",
				sourceMetadata: {
					...base,
					recurringErrorAbsence: {
						firstAbsentScanAt: at.toISOString(),
						lastAbsentScanAt: at.toISOString(),
						scans: 1,
					},
				},
			});
			await refreshRecurringErrorProposalEvidence("prop_1", {
				fingerprint,
				title: "Error",
				recurringError: { fingerprint },
				transcript: "new",
			});
			expect(
				mocks.proposalUpdateMany.mock.calls.at(-1)?.[0].data
					.sourceMetadata,
			).not.toHaveProperty("recurringErrorAbsence");
		},
	);
});

it.each([
	null,
	{},
	{ firstAbsentScanAt: "bad", scans: 2 },
	{ firstAbsentScanAt: 1, scans: 2 },
	{ firstAbsentScanAt: "2026-11-01", scans: 0 },
	{ firstAbsentScanAt: "2026-11-01", scans: 1.5 },
	{ firstAbsentScanAt: "2026-11-01", scans: "2" },
])(
	"starts a valid record when prior absence is malformed %j",
	async (recurringErrorAbsence) => {
		mocks.proposalFindFirst.mockResolvedValue({
			sourceMetadata: { recurringErrorAbsence, transcript: "keep" },
		});
		await recordRecurringErrorProposalAbsence(
			"proj_1",
			"prop_1",
			new Date("2026-11-13T10:00:00Z"),
		);
		expect(
			mocks.proposalUpdateMany.mock.calls.at(-1)?.[0].data.sourceMetadata
				.recurringErrorAbsence,
		).toEqual({
			firstAbsentScanAt: "2026-11-13T10:00:00.000Z",
			lastAbsentScanAt: "2026-11-13T10:00:00.000Z",
			scans: 1,
		});
	},
);

it("does not write absence when source metadata is null", async () => {
	mocks.proposalFindFirst.mockResolvedValue({ sourceMetadata: null });
	await recordRecurringErrorProposalAbsence(
		"proj_1",
		"prop_1",
		new Date("2026-11-13T10:00:00Z"),
	);
	expect(mocks.proposalUpdateMany).not.toHaveBeenCalled();
});
