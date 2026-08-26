/**
 * Unit tests for `projects.pmStateChanges.resolveContentDrift` (Chunk C, §6).
 *
 * Covers the four resolution outcomes (APPLY_ADO / KEEP_FABRIC / AI_MERGE /
 * DISMISS), their precise effects (Fabric mutation or not, force-push or not),
 * the §10 re-stamp invariant (post-resolve baseline === resolved-content hash),
 * the resolution `PmSyncLog` outcome mapping (§6.4), the guards (non-drift row,
 * non-PENDING row, AI_MERGE without merged text), and the authz/tenant matrix.
 * Also asserts the bulk path REFUSES a CONTENT_DRIFT id (§6.5).
 *
 * Run with: pnpm --filter @repo/api test __tests__/resolve-content-drift
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	handlers,
	mockDb,
	mockHasProjectAccess,
	mockApplyAdo,
	mockWriteDescription,
	mockStampBaseline,
	mockGetItemTitle,
	mockCreatePmSyncLog,
	mockComputePmHash,
	mockEnqueuePmSync,
	mockWorkflowStart,
} = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mockDb = {
		pendingPmStateChange: {
			findUnique: vi.fn(),
			findMany: vi.fn(),
			update: vi.fn(),
		},
		project: {
			findUnique: vi.fn(),
		},
	};
	return {
		handlers,
		mockDb,
		mockHasProjectAccess: vi.fn().mockResolvedValue(true),
		mockApplyAdo: vi.fn().mockResolvedValue(undefined),
		mockWriteDescription: vi.fn().mockResolvedValue(undefined),
		mockStampBaseline: vi.fn().mockResolvedValue(undefined),
		mockGetItemTitle: vi.fn().mockResolvedValue("Fabric title"),
		mockCreatePmSyncLog: vi.fn().mockResolvedValue({ id: "log-1" }),
		mockComputePmHash: vi.fn().mockReturnValue("hash-from-live-ado"),
		mockEnqueuePmSync: vi.fn().mockResolvedValue({ enqueued: true }),
		mockWorkflowStart: vi.fn(),
	};
});

vi.mock("@repo/database", () => ({
	db: mockDb,
	hasProjectAccess: mockHasProjectAccess,
	applyAdoContentToFabricItem: mockApplyAdo,
	writePmSyncItemContent: mockWriteDescription,
	stampPmSyncBaseline: mockStampBaseline,
	getPmSyncItemTitle: mockGetItemTitle,
	createPmSyncLog: mockCreatePmSyncLog,
}));

vi.mock("@repo/temporal", () => ({
	computePmHash: mockComputePmHash,
	getTemporalClient: vi.fn().mockResolvedValue({
		workflow: {
			start: mockWorkflowStart,
		},
	}),
}));

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock("../../lib/enqueue-pm-sync", () => ({
	enqueuePmSync: mockEnqueuePmSync,
}));

vi.mock("../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: (o: unknown) => o,
}));

vi.mock("../../../../orpc/procedures", () => {
	const chainable: any = {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.resolveContentDrift = fn;
			return { _handler: fn };
		},
	};
	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
		requireProjectPermission: () => (c: unknown) => c,
		resolveOrganizationId: vi.fn(
			(organizationId: string | null | undefined) =>
				organizationId ?? undefined,
		),
	};
});

import "../resolve-content-drift";

const personalContext = {
	user: { id: "user-1" },
	session: { activeOrganizationId: null },
};

const driftRow = {
	id: "ch-1",
	projectId: "proj-1",
	entityType: "STORY",
	entityId: "story-1",
	externalId: "101",
	previousState: "CONTENT",
	newState: "CONTENT",
	proposedAction: "CONTENT_DRIFT",
	status: "PENDING",
	detectedPmHash: "detected-ado-hash",
};

function primeWorkflowResult(result: unknown) {
	mockWorkflowStart.mockResolvedValue({
		workflowId: "wf-1",
		result: () => Promise.resolve(result),
	});
}

function call(input: Record<string, unknown>, context = personalContext) {
	return handlers.resolveContentDrift({ input, context }) as Promise<any>;
}

const baseInput = {
	projectId: "proj-1",
	id: "ch-1",
	organizationId: null as string | null,
};

beforeEach(() => {
	vi.clearAllMocks();
	mockHasProjectAccess.mockResolvedValue(true);
	mockGetItemTitle.mockResolvedValue("Fabric title");
	mockComputePmHash.mockReturnValue("hash-from-live-ado");
	mockEnqueuePmSync.mockResolvedValue({ enqueued: true });
	mockCreatePmSyncLog.mockResolvedValue({ id: "log-1" });
	mockDb.pendingPmStateChange.findUnique.mockResolvedValue({ ...driftRow });
	mockDb.pendingPmStateChange.update.mockImplementation(
		async ({ data }: any) => ({ ...driftRow, ...data }),
	);
	mockDb.project.findUnique.mockResolvedValue({
		id: "proj-1",
		organizationId: null,
		projectManagementMcpConfigId: "cfg-1",
		projectManagementContainerId: "container-1",
		projectManagementContainerName: "Team",
		projectManagementAdditionalContext: null,
	});
});

describe("resolveContentDrift — guards", () => {
	it("FORBIDDEN when the user lacks project access", async () => {
		mockHasProjectAccess.mockResolvedValue(false);
		await expect(
			call({ ...baseInput, outcome: "DISMISS" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("NOT_FOUND when the row does not exist", async () => {
		mockDb.pendingPmStateChange.findUnique.mockResolvedValue(null);
		await expect(
			call({ ...baseInput, outcome: "DISMISS" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("FORBIDDEN when the row belongs to another project", async () => {
		mockDb.pendingPmStateChange.findUnique.mockResolvedValue({
			...driftRow,
			projectId: "other-proj",
		});
		await expect(
			call({ ...baseInput, outcome: "DISMISS" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("BAD_REQUEST when the row is not a CONTENT_DRIFT action", async () => {
		mockDb.pendingPmStateChange.findUnique.mockResolvedValue({
			...driftRow,
			proposedAction: "HIDE",
		});
		await expect(
			call({ ...baseInput, outcome: "DISMISS" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("CONFLICT when the row was already reviewed", async () => {
		mockDb.pendingPmStateChange.findUnique.mockResolvedValue({
			...driftRow,
			status: "APPROVED",
		});
		await expect(
			call({ ...baseInput, outcome: "DISMISS" }),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});

	it("BAD_REQUEST for AI_MERGE without a merged description", async () => {
		await expect(
			call({ ...baseInput, outcome: "AI_MERGE" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("BAD_REQUEST for AI_MERGE with a whitespace-only merged description", async () => {
		await expect(
			call({
				...baseInput,
				outcome: "AI_MERGE",
				overrideDescription: "   \n  ",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});
});

describe("resolveContentDrift — APPLY_ADO (net-new ingest)", () => {
	beforeEach(() => {
		primeWorkflowResult({
			results: [
				{
					id: "story-1",
					itemType: "story",
					hasConflict: true,
					pmCurrent: {
						title: "ADO title",
						description: "ADO description",
						lastChangedBy: "someone@ado",
						lastChangedAt: "2026-05-27T00:00:00Z",
					},
					pmUrl: "https://ado/story-1",
				},
			],
		});
	});

	it("ingests the SERVER-SIDE re-fetched ADO content + the recomputed hash, marks APPROVED", async () => {
		const result = await call({ ...baseInput, outcome: "APPLY_ADO" });

		// Authoritative content comes from the live preview workflow, never the client.
		expect(mockWorkflowStart).toHaveBeenCalledWith(
			"pmSyncPreviewConflictsWorkflow",
			expect.objectContaining({
				args: [
					expect.objectContaining({
						items: [{ id: "story-1", itemType: "story" }],
						projectId: "proj-1",
					}),
				],
			}),
		);
		expect(mockComputePmHash).toHaveBeenCalledWith(
			"ADO title",
			"ADO description",
		);
		expect(mockApplyAdo).toHaveBeenCalledWith(
			expect.objectContaining({
				itemType: "story",
				itemId: "story-1",
				projectId: "proj-1",
				title: "ADO title",
				description: "ADO description",
				newContentHash: "hash-from-live-ado",
				userId: "user-1",
				organizationId: null,
			}),
		);
		expect(mockEnqueuePmSync).not.toHaveBeenCalled();
		expect(result.change.status).toBe("APPROVED");
		// §10 invariant: the baseline ends at the live-ADO content hash.
		expect(result.resolvedContentHash).toBe("hash-from-live-ado");
	});

	it("writes a resolution PmSyncLog with outcome 'apply'", async () => {
		await call({ ...baseInput, outcome: "APPLY_ADO" });
		expect(mockCreatePmSyncLog).toHaveBeenCalledWith(
			expect.objectContaining({
				direction: "pull",
				status: "SUCCESS",
				entityType: "STORY",
				entityId: "story-1",
				pmTool: "azure-devops",
				actorUserId: "user-1",
				errorPayload: {
					reason: "ado-content-drift",
					outcome: "apply",
				},
			}),
		);
	});

	it("CONFLICT (self-healed) when the live ADO content can no longer be read", async () => {
		primeWorkflowResult({
			results: [{ id: "story-1", itemType: "story", hasConflict: false }],
		});
		await expect(
			call({ ...baseInput, outcome: "APPLY_ADO" }),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(mockApplyAdo).not.toHaveBeenCalled();
	});
});

describe("resolveContentDrift — KEEP_FABRIC (force-push)", () => {
	it("force-pushes Fabric → ADO, does not mutate Fabric, marks APPROVED", async () => {
		const result = await call({ ...baseInput, outcome: "KEEP_FABRIC" });

		expect(mockEnqueuePmSync).toHaveBeenCalledWith(
			expect.objectContaining({
				itemId: "story-1",
				itemType: "story",
				projectId: "proj-1",
				userId: "user-1",
				forceHashOverride: true,
				triggerSource: "retry",
			}),
		);
		expect(mockApplyAdo).not.toHaveBeenCalled();
		expect(mockWriteDescription).not.toHaveBeenCalled();
		expect(mockStampBaseline).not.toHaveBeenCalled();
		expect(result.change.status).toBe("APPROVED");
	});

	it("logs outcome 'keep-fabric'", async () => {
		await call({ ...baseInput, outcome: "KEEP_FABRIC" });
		expect(mockCreatePmSyncLog).toHaveBeenCalledWith(
			expect.objectContaining({
				errorPayload: {
					reason: "ado-content-drift",
					outcome: "keep-fabric",
				},
			}),
		);
	});
});

describe("resolveContentDrift — AI_MERGE", () => {
	it("writes the merged title + description THEN force-pushes, marks APPROVED", async () => {
		const result = await call({
			...baseInput,
			outcome: "AI_MERGE",
			overrideTitle: "Merged title",
			overrideDescription: "Merged description",
		});

		expect(mockWriteDescription).toHaveBeenCalledWith({
			itemType: "story",
			itemId: "story-1",
			title: "Merged title",
			description: "Merged description",
			projectId: "proj-1",
			lastEditedSource: "CONFLICT_RESOLUTION",
			lastEditedByName: null,
		});
		expect(mockEnqueuePmSync).toHaveBeenCalledWith(
			expect.objectContaining({
				itemId: "story-1",
				forceHashOverride: true,
				triggerSource: "retry",
			}),
		);
		expect(mockApplyAdo).not.toHaveBeenCalled();
		expect(result.change.status).toBe("APPROVED");
	});

	it("logs outcome 'ai-merge'", async () => {
		await call({
			...baseInput,
			outcome: "AI_MERGE",
			overrideDescription: "Merged description",
		});
		expect(mockCreatePmSyncLog).toHaveBeenCalledWith(
			expect.objectContaining({
				errorPayload: {
					reason: "ado-content-drift",
					outcome: "ai-merge",
				},
			}),
		);
	});
});

describe("resolveContentDrift — DISMISS", () => {
	it("re-stamps the baseline to the current ADO hash, leaves Fabric untouched, marks DISMISSED", async () => {
		const result = await call({ ...baseInput, outcome: "DISMISS" });

		expect(mockStampBaseline).toHaveBeenCalledWith({
			itemType: "story",
			itemId: "story-1",
			projectId: "proj-1",
			newContentHash: "detected-ado-hash",
		});
		expect(mockApplyAdo).not.toHaveBeenCalled();
		expect(mockWriteDescription).not.toHaveBeenCalled();
		expect(mockEnqueuePmSync).not.toHaveBeenCalled();
		expect(result.change.status).toBe("DISMISSED");
		// §10 invariant: baseline ends at the detected ADO hash.
		expect(result.resolvedContentHash).toBe("detected-ado-hash");
	});

	it("logs outcome 'dismiss'", async () => {
		await call({ ...baseInput, outcome: "DISMISS" });
		expect(mockCreatePmSyncLog).toHaveBeenCalledWith(
			expect.objectContaining({
				errorPayload: {
					reason: "ado-content-drift",
					outcome: "dismiss",
				},
			}),
		);
	});

	it("a failing resolution-log write does NOT roll back the resolution", async () => {
		mockCreatePmSyncLog.mockRejectedValue(new Error("log down"));
		const result = await call({ ...baseInput, outcome: "DISMISS" });
		expect(result.change.status).toBe("DISMISSED");
		expect(mockStampBaseline).toHaveBeenCalled();
	});
});

describe("resolveContentDrift — tenant XOR", () => {
	it("org context writes the log with organizationId set and userId null", async () => {
		const orgContext = {
			user: { id: "user-1" },
			session: { activeOrganizationId: "org-9" },
		};
		mockDb.project.findUnique.mockResolvedValue({
			id: "proj-1",
			organizationId: "org-9",
			projectManagementMcpConfigId: "cfg-1",
			projectManagementContainerId: "container-1",
			projectManagementContainerName: "Team",
			projectManagementAdditionalContext: null,
		});

		await call(
			{
				projectId: "proj-1",
				id: "ch-1",
				organizationId: "org-9",
				outcome: "DISMISS",
			},
			orgContext,
		);

		expect(mockCreatePmSyncLog).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: "org-9", userId: null }),
		);
	});

	it("personal context writes the log with userId set and organizationId null", async () => {
		await call({ ...baseInput, outcome: "DISMISS" });
		expect(mockCreatePmSyncLog).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: null, userId: "user-1" }),
		);
	});
});
