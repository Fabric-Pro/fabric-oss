/**
 * Procedure-level tests for `scan.grouping.apply` + `scan.grouping.readd`.
 * Exercise each handler's ORCHESTRATION (tenant gate, the AWAITING_REVIEW->
 * APPLYING CAS, per-ticket create/decline/update routing, durable decline,
 * re-add) with `@repo/database` and the shared `createGroupingTicket` helper
 * mocked — no Prisma, no temporal worker. Mirrors `grouping-procedures.test.ts`.
 */
import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockHasProjectAccess,
	mockGetScanFindingGrouping,
	mockUpdateScanFindingGrouping,
	mockAddDeclinedGroupingThemes,
	mockRemoveDeclinedGroupingTheme,
	mockEnsureFabricSystemUser,
	mockRecordScanActivity,
	mockGroupingUpdateMany,
	mockProjectFindUnique,
	mockTransaction,
	mockCreateGroupingTicket,
} = vi.hoisted(() => ({
	mockHasProjectAccess: vi.fn(),
	mockGetScanFindingGrouping: vi.fn(),
	mockUpdateScanFindingGrouping: vi.fn(),
	mockAddDeclinedGroupingThemes: vi.fn(),
	mockRemoveDeclinedGroupingTheme: vi.fn(),
	mockEnsureFabricSystemUser: vi.fn(),
	mockRecordScanActivity: vi.fn(),
	mockGroupingUpdateMany: vi.fn(),
	mockProjectFindUnique: vi.fn(),
	mockTransaction: vi.fn(),
	mockCreateGroupingTicket: vi.fn(),
}));

vi.mock("@repo/database", async () => {
	const actual =
		await vi.importActual<typeof import("@repo/database")>(
			"@repo/database",
		);
	return {
		...actual,
		db: {
			scanFindingGrouping: {
				updateMany: (...a: unknown[]) => mockGroupingUpdateMany(...a),
			},
			project: {
				findUnique: (...a: unknown[]) => mockProjectFindUnique(...a),
			},
			userStoryComment: { create: vi.fn() },
			scanActivity: { create: vi.fn() },
			$transaction: (...a: unknown[]) => mockTransaction(...a),
		},
		hasProjectAccess: (...a: unknown[]) => mockHasProjectAccess(...a),
		getScanFindingGrouping: (...a: unknown[]) =>
			mockGetScanFindingGrouping(...a),
		updateScanFindingGrouping: (...a: unknown[]) =>
			mockUpdateScanFindingGrouping(...a),
		addDeclinedGroupingThemes: (...a: unknown[]) =>
			mockAddDeclinedGroupingThemes(...a),
		removeDeclinedGroupingTheme: (...a: unknown[]) =>
			mockRemoveDeclinedGroupingTheme(...a),
		ensureFabricSystemUser: (...a: unknown[]) =>
			mockEnsureFabricSystemUser(...a),
		recordScanActivity: (...a: unknown[]) => mockRecordScanActivity(...a),
	};
});

vi.mock("../../../lib/create-grouping-ticket", () => ({
	createGroupingTicket: (...a: unknown[]) => mockCreateGroupingTicket(...a),
}));

async function proceduresMockFactory() {
	const actual =
		await vi.importActual<typeof import("@repo/permissions")>(
			"@repo/permissions",
		);
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: unknown) => ({ _handler: fn }),
	});
	return {
		tenantProtectedProcedure: chainable,
		Permissions: actual.Permissions,
		requireProjectPermission: () => (c: unknown) => c,
	};
}
vi.mock("../../../../../orpc/procedures", proceduresMockFactory);
vi.mock("../../../../orpc/procedures", proceduresMockFactory);

type Handler = (args: {
	input: Record<string, unknown>;
	context: { user: { id: string } };
}) => Promise<{
	createdCount?: number;
	updatedCount?: number;
	declinedCount?: number;
	failedCount?: number;
	storyId?: string;
	storyIdentifier?: string;
}>;

const ctx = { user: { id: "user-1" } };

async function loadHandler(module: string, name: string): Promise<Handler> {
	const mod = (await import(module)) as Record<string, { _handler: Handler }>;
	return mod[name]._handler;
}

const CREATE_PROPOSAL = {
	category: "SECURITY" as const,
	ruleSource: "gitleaks:generic-api-key",
	themeKey: "theme-security-generic-api-key-abcd1234",
	findingCount: 3,
	severity: null,
	title: "[Security] Exposed API keys",
	body: "## Summary\n...",
	priority: "P1_HIGH" as const,
	fingerprints: ["fp1", "fp2"],
};
const UPDATE_PROPOSAL = {
	category: "SECURITY" as const,
	ruleSource: "Semgrep:sql-injection",
	themeKey: "theme-security-sql-injection-ef567890",
	findingCount: 5,
	storyId: "story-existing",
	storyIdentifier: "F-42",
	newFindingCount: 2,
	commentBody: "Found 2 new findings",
	newFingerprints: ["fp9"],
	cumulativeFingerprints: ["fp7", "fp8", "fp9"],
};

function awaitingRun(results: Record<string, unknown>) {
	return {
		id: "g1",
		projectId: "proj-1",
		status: "AWAITING_REVIEW",
		results,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.resetModules();
	mockHasProjectAccess.mockResolvedValue(true);
	mockGroupingUpdateMany.mockResolvedValue({ count: 1 });
	mockProjectFindUnique.mockResolvedValue({
		projectManagementMcpConfigId: null,
		projectManagementContainerId: null,
	});
	mockTransaction.mockResolvedValue([]);
	mockUpdateScanFindingGrouping.mockResolvedValue(undefined);
	mockRecordScanActivity.mockResolvedValue(undefined);
	mockAddDeclinedGroupingThemes.mockResolvedValue(undefined);
	mockRemoveDeclinedGroupingTheme.mockResolvedValue(undefined);
	mockEnsureFabricSystemUser.mockResolvedValue(undefined);
	mockCreateGroupingTicket.mockResolvedValue({
		storyId: "story-new",
		storyIdentifier: "F-100",
	});
});

describe("applyGroupingProcedure", () => {
	it("declares PROJECT_UPDATE and creates an accepted proposal, completing the run", async () => {
		mockGetScanFindingGrouping.mockResolvedValue(
			awaitingRun({
				proposedCreate: [CREATE_PROPOSAL],
				proposedUpdate: [],
			}),
		);
		const handler = await loadHandler(
			"../apply-grouping",
			"applyGroupingProcedure",
		);

		const result = await handler({
			input: {
				projectId: "proj-1",
				groupingId: "g1",
				accepted: [
					{ themeKey: CREATE_PROPOSAL.themeKey, syncToPM: false },
				],
				declinedThemeKeys: [],
			},
			context: ctx,
		});

		expect(mockCreateGroupingTicket).toHaveBeenCalledTimes(1);
		const [proposalArg, ticketCtx] = mockCreateGroupingTicket.mock
			.calls[0] as [{ themeKey: string }, { doSync: boolean }];
		expect(proposalArg.themeKey).toBe(CREATE_PROPOSAL.themeKey);
		expect(ticketCtx.doSync).toBe(false);
		expect(result).toMatchObject({ createdCount: 1, declinedCount: 0 });
		const [, patch] = mockUpdateScanFindingGrouping.mock.calls[0] as [
			string,
			{ status: string; createdCount: number },
		];
		expect(patch.status).toBe("COMPLETED");
		expect(patch.createdCount).toBe(1);
	});

	it("passes per-ticket doSync=true only when the ticket is accepted-to-sync AND a PM tool is configured", async () => {
		mockProjectFindUnique.mockResolvedValue({
			projectManagementMcpConfigId: "cfg-1",
			projectManagementContainerId: "cont-1",
		});
		mockGetScanFindingGrouping.mockResolvedValue(
			awaitingRun({
				proposedCreate: [CREATE_PROPOSAL],
				proposedUpdate: [],
			}),
		);
		const handler = await loadHandler(
			"../apply-grouping",
			"applyGroupingProcedure",
		);
		await handler({
			input: {
				projectId: "proj-1",
				groupingId: "g1",
				accepted: [
					{ themeKey: CREATE_PROPOSAL.themeKey, syncToPM: true },
				],
				declinedThemeKeys: [],
			},
			context: ctx,
		});
		const [, ticketCtx] = mockCreateGroupingTicket.mock.calls[0] as [
			unknown,
			{ doSync: boolean },
		];
		expect(ticketCtx.doSync).toBe(true);
	});

	it("records a declined theme durably (stays declined on future runs)", async () => {
		mockGetScanFindingGrouping.mockResolvedValue(
			awaitingRun({
				proposedCreate: [CREATE_PROPOSAL],
				proposedUpdate: [],
			}),
		);
		const handler = await loadHandler(
			"../apply-grouping",
			"applyGroupingProcedure",
		);
		const result = await handler({
			input: {
				projectId: "proj-1",
				groupingId: "g1",
				accepted: [],
				declinedThemeKeys: [CREATE_PROPOSAL.themeKey],
			},
			context: ctx,
		});
		expect(mockCreateGroupingTicket).not.toHaveBeenCalled();
		expect(mockAddDeclinedGroupingThemes).toHaveBeenCalledTimes(1);
		const [, , themes] = mockAddDeclinedGroupingThemes.mock.calls[0] as [
			string,
			unknown,
			Array<{ themeKey: string }>,
		];
		expect(themes[0]?.themeKey).toBe(CREATE_PROPOSAL.themeKey);
		expect(result).toMatchObject({ declinedCount: 1, createdCount: 0 });
	});

	it("applies an accepted update proposal by posting a comment (a transaction), not creating a ticket", async () => {
		mockGetScanFindingGrouping.mockResolvedValue(
			awaitingRun({
				proposedCreate: [],
				proposedUpdate: [UPDATE_PROPOSAL],
			}),
		);
		const handler = await loadHandler(
			"../apply-grouping",
			"applyGroupingProcedure",
		);
		const result = await handler({
			input: {
				projectId: "proj-1",
				groupingId: "g1",
				accepted: [{ themeKey: UPDATE_PROPOSAL.themeKey }],
				declinedThemeKeys: [],
			},
			context: ctx,
		});
		expect(mockCreateGroupingTicket).not.toHaveBeenCalled();
		expect(mockTransaction).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({ updatedCount: 1, createdCount: 0 });
	});

	it("CONFLICTs when the run is not AWAITING_REVIEW (CAS claim returns 0)", async () => {
		mockGetScanFindingGrouping.mockResolvedValue(
			awaitingRun({ proposedCreate: [CREATE_PROPOSAL] }),
		);
		mockGroupingUpdateMany.mockResolvedValue({ count: 0 });
		const handler = await loadHandler(
			"../apply-grouping",
			"applyGroupingProcedure",
		);
		await expect(
			handler({
				input: {
					projectId: "proj-1",
					groupingId: "g1",
					accepted: [],
					declinedThemeKeys: [],
				},
				context: ctx,
			}),
		).rejects.toBeInstanceOf(ORPCError);
		expect(mockCreateGroupingTicket).not.toHaveBeenCalled();
	});

	it("rejects FORBIDDEN without project access", async () => {
		mockHasProjectAccess.mockResolvedValue(false);
		const handler = await loadHandler(
			"../apply-grouping",
			"applyGroupingProcedure",
		);
		await expect(
			handler({
				input: {
					projectId: "proj-1",
					groupingId: "g1",
					accepted: [],
					declinedThemeKeys: [],
				},
				context: ctx,
			}),
		).rejects.toBeInstanceOf(ORPCError);
		expect(mockGroupingUpdateMany).not.toHaveBeenCalled();
	});
});

describe("readdGroupingThemeProcedure", () => {
	it("creates the declined ticket immediately, clears its declined state, and moves it into createdThemes", async () => {
		mockGetScanFindingGrouping.mockResolvedValue({
			id: "g1",
			projectId: "proj-1",
			status: "COMPLETED",
			results: { declinedThemes: [CREATE_PROPOSAL], createdThemes: [] },
		});
		const handler = await loadHandler(
			"../readd-grouping-theme",
			"readdGroupingThemeProcedure",
		);
		const result = await handler({
			input: {
				projectId: "proj-1",
				groupingId: "g1",
				themeKey: CREATE_PROPOSAL.themeKey,
			},
			context: ctx,
		});
		expect(mockCreateGroupingTicket).toHaveBeenCalledTimes(1);
		expect(mockRemoveDeclinedGroupingTheme).toHaveBeenCalledWith(
			"proj-1",
			CREATE_PROPOSAL.themeKey,
		);
		const [, patch] = mockUpdateScanFindingGrouping.mock.calls[0] as [
			string,
			{
				results: {
					declinedThemes: unknown[];
					createdThemes: unknown[];
				};
			},
		];
		expect(patch.results.declinedThemes).toHaveLength(0);
		expect(patch.results.createdThemes).toHaveLength(1);
		expect(result).toMatchObject({
			storyId: "story-new",
			storyIdentifier: "F-100",
		});
	});

	it("NOT_FOUND when the theme isn't among the run's declined proposals", async () => {
		mockGetScanFindingGrouping.mockResolvedValue({
			id: "g1",
			projectId: "proj-1",
			status: "COMPLETED",
			results: { declinedThemes: [] },
		});
		const handler = await loadHandler(
			"../readd-grouping-theme",
			"readdGroupingThemeProcedure",
		);
		await expect(
			handler({
				input: {
					projectId: "proj-1",
					groupingId: "g1",
					themeKey: "nope",
				},
				context: ctx,
			}),
		).rejects.toBeInstanceOf(ORPCError);
		expect(mockCreateGroupingTicket).not.toHaveBeenCalled();
	});
});
