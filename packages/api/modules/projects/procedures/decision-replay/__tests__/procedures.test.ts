import { call, os } from "@orpc/server";
import { Permissions } from "@repo/permissions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	project: vi.fn(),
	flag: vi.fn(),
	summary: vi.fn(),
	review: vi.fn(),
	timeline: vi.fn(),
	embed: vi.fn(),
	access: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: { project: { findUnique: mocks.project } },
	isFeatureEnabled: mocks.flag,
	getDecisionReplaySummary: mocks.summary,
	listDecisionReplayNeedsReview: mocks.review,
	getDecisionReplayProposalTimeline: mocks.timeline,
	getOrganizationMembership: vi.fn(),
	getTenantContext: vi.fn(),
	grantProjectAccess: vi.fn(),
}));
vi.mock("../../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: mocks.access,
}));
vi.mock("../../../../../orpc/procedures", async () => {
	const { requireProjectPermission } = await import(
		"../../../../../orpc/middleware/require-permission"
	);
	return {
		tenantProtectedProcedure: os.$context<{
			user: { id: string };
			activeOrganizationRole: string | null;
			allowedProjectIds: string[];
		}>(),
		requireProjectPermission,
		Permissions,
	};
});
vi.mock("../embed-token", () => ({ getDecisionReplayEmbedToken: mocks.embed }));

import {
	getEmbedTokenProcedure,
	getProposalTimelineProcedure,
	getSummaryProcedure,
	listNeedsReviewProcedure,
} from "../index";

const procedures = [
	getSummaryProcedure,
	listNeedsReviewProcedure,
	getProposalTimelineProcedure,
	getEmbedTokenProcedure,
] as const;
const context = {
	user: { id: "example_user" },
	activeOrganizationRole: null,
	allowedProjectIds: [],
};
const input = { projectId: "example_project", proposalId: "example_proposal" };
beforeEach(() => {
	vi.clearAllMocks();
	mocks.project.mockResolvedValue({ organizationId: "example_project_org" });
	mocks.flag.mockImplementation(
		async (_key, org) => org === "example_project_org",
	);
	mocks.access.mockResolvedValue({
		source: "org",
		organizationId: "example_project_org",
		permissions: [Permissions.PROJECT_READ],
	});
	mocks.summary.mockResolvedValue({
		waiting: 0,
		oldestWaitingAt: null,
		changeCoverageStartedAt: null,
		previous: null,
		current: {
			acceptance: { accepted: 0, decided: 0, rate: null },
			changeAcceptance: { accepted: 0, decided: 0, rate: null },
			changeOutcomes: {
				applied: 0,
				alreadyOnRoadmap: 0,
				notSelected: 0,
				failed: 0,
				inProgress: 0,
				rejected: 0,
				superseded: 0,
				pending: 0,
			},
			partlyApplied: 0,
			medianReviewSeconds: null,
			keptAsApplied: { kept: 0, mature: 0, rate: null },
			outcomes: { applied: 0, rejected: 0, pending: 0, other: 0 },
		},
	});
	mocks.review.mockResolvedValue({ items: [], total: 0 });
	mocks.timeline.mockResolvedValue({ events: [], truncated: false });
	mocks.embed.mockResolvedValue({
		available: false,
		reason: "not_configured",
	});
});
describe("Decision Replay procedures", () => {
	it.each(procedures)(
		"denies tied callers without PROJECT_READ before querying or minting: %#",
		async (procedure) => {
			mocks.access.mockResolvedValue({
				source: "project-member",
				organizationId: "example_project_org",
				permissions: [],
			});
			await expect(
				call(
					procedure,
					procedure === getProposalTimelineProcedure
						? input
						: { projectId: input.projectId },
					{ context },
				),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(mocks.project).not.toHaveBeenCalled();
			expect(mocks.embed).not.toHaveBeenCalled();
			expect(mocks.summary).not.toHaveBeenCalled();
		},
	);
	it.each(procedures)(
		"hides projects with no access: %#",
		async (procedure) => {
			mocks.access.mockResolvedValue({ source: "none" });
			await expect(
				call(
					procedure,
					procedure === getProposalTimelineProcedure
						? input
						: { projectId: input.projectId },
					{ context },
				),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
		},
	);
	it.each(procedures)(
		"checks the project org flag even when another org is enabled: %#",
		async (procedure) => {
			mocks.flag.mockImplementation(
				async (_key, org) => org === "example_session_org",
			);
			await expect(
				call(
					procedure,
					procedure === getProposalTimelineProcedure
						? input
						: { projectId: input.projectId },
					{ context },
				),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			expect(mocks.flag).toHaveBeenCalledWith(
				"DECISION_REPLAY",
				"example_project_org",
			);
			expect(mocks.embed).not.toHaveBeenCalled();
		},
	);
	it("passes only the project row's scope to the data queries", async () => {
		await call(
			getSummaryProcedure,
			{ projectId: input.projectId },
			{ context },
		);
		expect(mocks.summary).toHaveBeenCalledWith({
			projectId: input.projectId,
			organizationId: "example_project_org",
			range: "30d",
		});
		await call(
			listNeedsReviewProcedure,
			{ projectId: input.projectId },
			{ context },
		);
		expect(mocks.review).toHaveBeenCalledWith({
			projectId: input.projectId,
			organizationId: "example_project_org",
			limit: 5,
		});
		await call(getProposalTimelineProcedure, input, { context });
		expect(mocks.timeline).toHaveBeenCalledWith({
			...input,
			organizationId: "example_project_org",
		});
		await call(
			getEmbedTokenProcedure,
			{ projectId: input.projectId },
			{ context },
		);
		expect(mocks.embed).toHaveBeenCalledWith({
			projectId: input.projectId,
			userId: "example_user",
		});
	});
	it("rejects a spoofed organization, invalid ranges and unbounded limits", async () => {
		for (const bad of [
			{ organizationId: "example_spoof" },
			{ range: "1d" },
		]) {
			await expect(
				call(
					getSummaryProcedure,
					{ projectId: input.projectId, ...bad },
					{ context },
				),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
		}
		for (const limit of [0, 101, 1.5]) {
			await expect(
				call(
					listNeedsReviewProcedure,
					{ projectId: input.projectId, limit },
					{ context },
				),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
		}
	});
	it("refuses missing and organizationless project rows", async () => {
		mocks.project.mockResolvedValue(null);
		await expect(
			call(
				getEmbedTokenProcedure,
				{ projectId: input.projectId },
				{ context },
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		mocks.project.mockResolvedValue({ organizationId: null });
		await expect(
			call(
				getEmbedTokenProcedure,
				{ projectId: input.projectId },
				{ context },
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});

it("returns typed review summaries and refuses an oversized title list", async () => {
	const row = {
		occurredAt: new Date(),
		eventType: "proposal_reviewed",
		fromState: null,
		toState: null,
		actorKind: "human",
		actorName: "Example",
		subjectType: "backlog_proposal_review",
		changeIndex: null,
		action: null,
		createdEntityType: null,
		offeredCount: 8,
		selectedCount: 5,
		offeredListComplete: true,
		notSelectedTitles: ["Example omitted"],
	};
	mocks.timeline.mockResolvedValue({ events: [row], truncated: false });
	expect(
		await call(getProposalTimelineProcedure, input, { context }),
	).toEqual({ events: [row], truncated: false });
	mocks.timeline.mockResolvedValue({
		events: [
			{
				...row,
				notSelectedTitles: Array.from({ length: 21 }, () => "Example"),
			},
		],
		truncated: false,
	});
	await expect(
		call(getProposalTimelineProcedure, input, { context }),
	).rejects.toThrow();
});

it("rejects a summary missing the change outcome contract", async () => {
	mocks.summary.mockResolvedValue({ example: true });
	await expect(
		call(getSummaryProcedure, { projectId: input.projectId }, { context }),
	).rejects.toThrow("Output validation failed");
});
