/**
 * Stage-transition choke point (plan §F1 / Slice 5) — fail-closed tests
 * against a mocked Prisma client.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const client = {
		project: { findUnique: vi.fn() },
		userStory: { findFirst: vi.fn(), updateMany: vi.fn() },
		stageTransitionRequest: {
			updateMany: vi.fn(),
			create: vi.fn(),
			findFirst: vi.fn(),
		},
		projectStageApprover: { findUnique: vi.fn() },
		featureVersion: { createMany: vi.fn() },
		$executeRawUnsafe: vi.fn(),
	};
	return { client };
});

vi.mock("../prisma/client", () => ({
	db: {
		...mocks.client,
		$transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
			fn(mocks.client),
	},
}));

// Tenant context is real (AsyncLocalStorage); RLS transaction helper is
// observed through a spy so we can assert which path the approval took.
const rls = vi.hoisted(() => ({ withRLSContext: vi.fn() }));
vi.mock("../src/tenant-db", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/tenant-db")>();
	rls.withRLSContext.mockImplementation(
		async (_client: unknown, fn: (tx: unknown) => Promise<unknown>) =>
			fn(mocks.client),
	);
	return { ...original, withRLSContext: rls.withRLSContext };
});
import {
	createOrganizationContext,
	createPersonalContext,
	runWithTenantContext,
} from "../src/tenant-context";

import {
	_resetReadinessEvidenceProviders,
	approveStageTransitionRequest,
	enforceStageTransition,
	GovernedActorRequiredError,
	registerReadinessEvidenceProvider,
	rejectStageTransitionRequest,
	StageApprovalError,
	StageTransitionBlockedError,
	StageTransitionConflictError,
	writeStage,
} from "../src/delivery/transition-story";

const client = mocks.client as unknown as Parameters<
	typeof enforceStageTransition
>[0];

function project(
	overrides: Partial<{
		engagementProfile: string;
		enforceSpecifyGate: boolean;
		enforceSpikeGate: boolean;
		enforceDiscoveryGate: boolean;
		approvers: number;
	}> = {},
) {
	return {
		engagementProfile: overrides.engagementProfile ?? "PROPOSAL",
		enforceSpecifyGate: overrides.enforceSpecifyGate ?? false,
		enforceSpikeGate: overrides.enforceSpikeGate ?? false,
		enforceDiscoveryGate: overrides.enforceDiscoveryGate ?? false,
		// Org project by default: tenant rows carry the acting user's id.
		organizationId: "org-1",
		userId: "owner",
		_count: { stageApprovers: overrides.approvers ?? 0 },
	};
}

function story(
	overrides: Partial<{
		draftingStage: string;
		deliveryTrack: string;
		description: string | null;
		acceptanceCriteria: string | null;
		version: number;
	}> = {},
) {
	// `in` checks (not `??`) so an explicit `null` survives — several cases
	// deliberately clear description / acceptance criteria.
	return {
		draftingStage: overrides.draftingStage ?? "DRAFT",
		deliveryTrack: overrides.deliveryTrack ?? "SPECIFY",
		description:
			"description" in overrides ? overrides.description : "desc",
		acceptanceCriteria:
			"acceptanceCriteria" in overrides
				? overrides.acceptanceCriteria
				: "ac",
		version: overrides.version ?? 3,
	};
}

const ACTOR = { userId: "user-requester", organizationId: "org-1" };
const BASE = { storyId: "story-1", projectId: "proj-1" } as const;

beforeEach(() => {
	for (const model of Object.values(mocks.client)) {
		if (typeof model === "function") {
			// Top-level client methods (e.g. $executeRawUnsafe) are mocks too.
			(model as ReturnType<typeof vi.fn>).mockReset();
			continue;
		}
		for (const fn of Object.values(model)) {
			(fn as ReturnType<typeof vi.fn>).mockReset();
		}
	}
	_resetReadinessEvidenceProviders();
	mocks.client.stageTransitionRequest.updateMany.mockResolvedValue({
		count: 0,
	});
	mocks.client.stageTransitionRequest.create.mockResolvedValue({
		id: "req-1",
	});
	mocks.client.featureVersion.createMany.mockResolvedValue({ count: 1 });
	mocks.client.userStory.updateMany.mockResolvedValue({ count: 1 });
});

describe("enforceStageTransition — DEFER rule", () => {
	it("throws StageTransitionBlockedError for DEFER → PUBLISHED regardless of flags", async () => {
		mocks.client.project.findUnique.mockResolvedValue(project());
		mocks.client.userStory.findFirst.mockResolvedValue(
			story({ deliveryTrack: "DEFER" }),
		);

		await expect(
			enforceStageTransition(client, {
				...BASE,
				toStage: "PUBLISHED",
				reason: "manual",
				actor: ACTOR,
			}),
		).rejects.toBeInstanceOf(StageTransitionBlockedError);

		expect(
			mocks.client.stageTransitionRequest.create,
		).not.toHaveBeenCalled();
	});

	it("exposes DEFERRED in the error's missing list", async () => {
		mocks.client.project.findUnique.mockResolvedValue(project());
		mocks.client.userStory.findFirst.mockResolvedValue(
			story({ deliveryTrack: "DEFER" }),
		);
		// Target differs from the current stage (DRAFT) so this is not a no-op.
		const error = await enforceStageTransition(client, {
			...BASE,
			toStage: "SANITY_CHECK",
			reason: "manual",
		}).catch((e) => e);
		expect(error).toBeInstanceOf(StageTransitionBlockedError);
		expect((error as StageTransitionBlockedError).missing).toContain(
			"DEFERRED",
		);
	});

	it("lets DEFER move to the parking stages (DECLINED / CLOSED / PLACEHOLDER)", async () => {
		mocks.client.project.findUnique.mockResolvedValue(project());
		for (const toStage of ["DECLINED", "CLOSED", "PLACEHOLDER"] as const) {
			mocks.client.userStory.findFirst.mockResolvedValue(
				story({ deliveryTrack: "DEFER" }),
			);
			const result = await enforceStageTransition(client, {
				...BASE,
				toStage,
				reason: "manual",
			});
			expect(result.mode).toBe("apply");
		}
	});
});

describe("enforceStageTransition — readiness gate", () => {
	it("blocks PUBLISHED when the specify flag is on and acceptance criteria are missing", async () => {
		mocks.client.project.findUnique.mockResolvedValue(
			project({ enforceSpecifyGate: true }),
		);
		mocks.client.userStory.findFirst.mockResolvedValue(
			story({ acceptanceCriteria: null }),
		);
		const error = await enforceStageTransition(client, {
			...BASE,
			toStage: "PUBLISHED",
			reason: "manual",
			actor: ACTOR,
		}).catch((e) => e);
		expect(error).toBeInstanceOf(StageTransitionBlockedError);
		expect((error as StageTransitionBlockedError).missing).toEqual([
			"ACCEPTANCE_CRITERIA_MISSING",
		]);
	});

	it("evaluates the patch as if applied (patch supplies the missing criteria)", async () => {
		mocks.client.project.findUnique.mockResolvedValue(
			project({ enforceSpecifyGate: true }),
		);
		mocks.client.userStory.findFirst.mockResolvedValue(
			story({ acceptanceCriteria: null }),
		);
		const result = await enforceStageTransition(client, {
			...BASE,
			toStage: "PUBLISHED",
			reason: "enhance",
			patch: { acceptanceCriteria: "Given/When/Then" },
		});
		expect(result.mode).toBe("apply");
	});

	it("fails closed when an evidence provider throws", async () => {
		registerReadinessEvidenceProvider(async () => {
			throw new Error("evidence store down");
		});
		mocks.client.project.findUnique.mockResolvedValue(project());
		mocks.client.userStory.findFirst.mockResolvedValue(story());
		const error = await enforceStageTransition(client, {
			...BASE,
			toStage: "PUBLISHED",
			reason: "manual",
		}).catch((e) => e);
		expect(error).toBeInstanceOf(StageTransitionBlockedError);
		expect((error as StageTransitionBlockedError).missing).toContain(
			"EVIDENCE_UNAVAILABLE",
		);
	});

	it("does not gate non-PUBLISHED targets on readiness", async () => {
		mocks.client.project.findUnique.mockResolvedValue(
			project({ enforceSpecifyGate: true }),
		);
		mocks.client.userStory.findFirst.mockResolvedValue(
			story({ description: null, acceptanceCriteria: null }),
		);
		const result = await enforceStageTransition(client, {
			...BASE,
			toStage: "SANITY_CHECK",
			reason: "manual",
		});
		expect(result.mode).toBe("apply");
		expect(result.readiness).toBeNull();
	});
});

describe("enforceStageTransition — GOVERNED review", () => {
	it("returns mode request and records a StageTransitionRequest when approvers exist", async () => {
		mocks.client.project.findUnique.mockResolvedValue(
			project({ engagementProfile: "GOVERNED", approvers: 2 }),
		);
		mocks.client.userStory.findFirst.mockResolvedValue(story());

		const result = await enforceStageTransition(client, {
			...BASE,
			toStage: "PUBLISHED",
			reason: "manual",
			actor: ACTOR,
			patch: { description: "new" },
		});

		expect(result.mode).toBe("request");
		if (result.mode === "request") {
			expect(result.requestId).toBe("req-1");
		}
		// Older PENDING requests are superseded first (partial unique index).
		expect(
			mocks.client.stageTransitionRequest.updateMany,
		).toHaveBeenCalledWith({
			where: { storyId: "story-1", status: "PENDING" },
			data: { status: "SUPERSEDED" },
		});
		expect(mocks.client.stageTransitionRequest.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					projectId: "proj-1",
					storyId: "story-1",
					requestedById: ACTOR.userId,
					organizationId: ACTOR.organizationId,
					fromStage: "DRAFT",
					toStage: "PUBLISHED",
					reason: "manual",
					patch: { description: "new" },
				}),
			}),
		);
		// The story itself is never written by the enforcement step.
		expect(mocks.client.userStory.updateMany).not.toHaveBeenCalled();
	});

	it("throws GovernedActorRequiredError when review is required and no actor is given", async () => {
		mocks.client.project.findUnique.mockResolvedValue(
			project({ engagementProfile: "GOVERNED", approvers: 1 }),
		);
		mocks.client.userStory.findFirst.mockResolvedValue(story());

		await expect(
			enforceStageTransition(client, {
				...BASE,
				toStage: "PUBLISHED",
				reason: "system",
			}),
		).rejects.toBeInstanceOf(GovernedActorRequiredError);
		expect(
			mocks.client.stageTransitionRequest.create,
		).not.toHaveBeenCalled();
	});

	it("bypassGovernedReview skips request creation (approval path)", async () => {
		mocks.client.project.findUnique.mockResolvedValue(
			project({ engagementProfile: "GOVERNED", approvers: 1 }),
		);
		mocks.client.userStory.findFirst.mockResolvedValue(story());

		const result = await enforceStageTransition(client, {
			...BASE,
			toStage: "PUBLISHED",
			reason: "approval",
			actor: { userId: "approver" },
			bypassGovernedReview: true,
		});
		expect(result.mode).toBe("apply");
		expect(
			mocks.client.stageTransitionRequest.create,
		).not.toHaveBeenCalled();
	});

	it("GOVERNED without configured approvers applies directly (review not effective)", async () => {
		mocks.client.project.findUnique.mockResolvedValue(
			project({ engagementProfile: "GOVERNED", approvers: 0 }),
		);
		mocks.client.userStory.findFirst.mockResolvedValue(story());
		const result = await enforceStageTransition(client, {
			...BASE,
			toStage: "PUBLISHED",
			reason: "manual",
			actor: ACTOR,
		});
		expect(result.mode).toBe("apply");
		expect(result.policy.reviewRequired).toBe(false);
	});

	it("readiness is enforced before a request is recorded", async () => {
		mocks.client.project.findUnique.mockResolvedValue(
			project({
				engagementProfile: "GOVERNED",
				approvers: 1,
				enforceSpecifyGate: true,
			}),
		);
		mocks.client.userStory.findFirst.mockResolvedValue(
			story({ acceptanceCriteria: null }),
		);
		await expect(
			enforceStageTransition(client, {
				...BASE,
				toStage: "PUBLISHED",
				reason: "manual",
				actor: ACTOR,
			}),
		).rejects.toBeInstanceOf(StageTransitionBlockedError);
		expect(
			mocks.client.stageTransitionRequest.create,
		).not.toHaveBeenCalled();
	});

	it("returns noop when the story is already at the target stage", async () => {
		mocks.client.project.findUnique.mockResolvedValue(
			project({ engagementProfile: "GOVERNED", approvers: 1 }),
		);
		mocks.client.userStory.findFirst.mockResolvedValue(
			story({ draftingStage: "PUBLISHED" }),
		);
		const result = await enforceStageTransition(client, {
			...BASE,
			toStage: "PUBLISHED",
			reason: "manual",
			actor: ACTOR,
		});
		expect(result.mode).toBe("noop");
		expect(
			mocks.client.stageTransitionRequest.create,
		).not.toHaveBeenCalled();
	});
});

describe("writeStage — compare-and-swap", () => {
	it("throws StageTransitionConflictError when updateMany.count === 0", async () => {
		mocks.client.userStory.findFirst.mockResolvedValue(
			story({ draftingStage: "DRAFT" }),
		);
		mocks.client.userStory.updateMany.mockResolvedValue({ count: 0 });

		await expect(
			writeStage(client, {
				...BASE,
				fromStage: "DRAFT",
				toStage: "PUBLISHED",
			}),
		).rejects.toBeInstanceOf(StageTransitionConflictError);
	});

	it("throws StageTransitionConflictError when the current stage no longer matches fromStage", async () => {
		mocks.client.userStory.findFirst.mockResolvedValue(
			story({ draftingStage: "SANITY_CHECK" }),
		);
		await expect(
			writeStage(client, {
				...BASE,
				fromStage: "DRAFT",
				toStage: "PUBLISHED",
			}),
		).rejects.toBeInstanceOf(StageTransitionConflictError);
		expect(mocks.client.userStory.updateMany).not.toHaveBeenCalled();
	});

	it("guards the update with the expected fromStage and snapshots a FeatureVersion", async () => {
		mocks.client.userStory.findFirst.mockResolvedValue(
			story({ draftingStage: "DRAFT", version: 7 }),
		);
		await writeStage(client, {
			...BASE,
			fromStage: "DRAFT",
			toStage: "PUBLISHED",
			patch: { acceptanceCriteria: "ac2" },
			versionContext: { userId: "u1", changedBy: "u1" },
		});
		expect(mocks.client.featureVersion.createMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: [
					expect.objectContaining({ storyId: "story-1", version: 7 }),
				],
				skipDuplicates: true,
			}),
		);
		expect(mocks.client.userStory.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "story-1",
					projectId: "proj-1",
					draftingStage: "DRAFT",
				},
				data: expect.objectContaining({
					draftingStage: "PUBLISHED",
					acceptanceCriteria: "ac2",
				}),
			}),
		);
	});
});

describe("approveStageTransitionRequest / rejectStageTransitionRequest", () => {
	const pendingRequest = {
		id: "req-1",
		projectId: "proj-1",
		storyId: "story-1",
		requestedById: ACTOR.userId,
		fromStage: "DRAFT",
		toStage: "PUBLISHED",
		patch: null,
		status: "PENDING",
	};

	it("rejects self-approval with SELF_APPROVAL and writes nothing", async () => {
		mocks.client.stageTransitionRequest.findFirst.mockResolvedValue(
			pendingRequest,
		);
		const error = await approveStageTransitionRequest({
			requestId: "req-1",
			projectId: "proj-1",
			reviewer: { userId: ACTOR.userId },
		}).catch((e) => e);
		expect(error).toBeInstanceOf(StageApprovalError);
		expect((error as StageApprovalError).code).toBe("SELF_APPROVAL");
		expect(
			mocks.client.projectStageApprover.findUnique,
		).not.toHaveBeenCalled();
		expect(mocks.client.userStory.updateMany).not.toHaveBeenCalled();
		expect(
			mocks.client.stageTransitionRequest.updateMany,
		).not.toHaveBeenCalled();
	});

	it("rejects a reviewer who is not a configured approver with NOT_AN_APPROVER", async () => {
		mocks.client.stageTransitionRequest.findFirst.mockResolvedValue(
			pendingRequest,
		);
		mocks.client.projectStageApprover.findUnique.mockResolvedValue(null);
		const error = await approveStageTransitionRequest({
			requestId: "req-1",
			projectId: "proj-1",
			reviewer: { userId: "someone-else" },
		}).catch((e) => e);
		expect(error).toBeInstanceOf(StageApprovalError);
		expect((error as StageApprovalError).code).toBe("NOT_AN_APPROVER");
		expect(mocks.client.userStory.updateMany).not.toHaveBeenCalled();
	});

	it("rejects a non-pending request with REQUEST_NOT_PENDING", async () => {
		mocks.client.stageTransitionRequest.findFirst.mockResolvedValue({
			...pendingRequest,
			status: "APPROVED",
		});
		const error = await approveStageTransitionRequest({
			requestId: "req-1",
			projectId: "proj-1",
			reviewer: { userId: "approver" },
		}).catch((e) => e);
		expect((error as StageApprovalError).code).toBe("REQUEST_NOT_PENDING");
	});

	it("returns REQUEST_NOT_FOUND for a request outside the project", async () => {
		mocks.client.stageTransitionRequest.findFirst.mockResolvedValue(null);
		const error = await approveStageTransitionRequest({
			requestId: "req-other",
			projectId: "proj-1",
			reviewer: { userId: "approver" },
		}).catch((e) => e);
		expect((error as StageApprovalError).code).toBe("REQUEST_NOT_FOUND");
		expect(
			mocks.client.stageTransitionRequest.findFirst,
		).toHaveBeenCalledWith({
			where: { id: "req-other", projectId: "proj-1" },
		});
	});

	it("re-runs readiness at approval time and fails if evidence vanished", async () => {
		mocks.client.stageTransitionRequest.findFirst.mockResolvedValue(
			pendingRequest,
		);
		mocks.client.projectStageApprover.findUnique.mockResolvedValue({
			userId: "approver",
		});
		mocks.client.project.findUnique.mockResolvedValue(
			project({
				engagementProfile: "GOVERNED",
				approvers: 1,
				enforceSpecifyGate: true,
			}),
		);
		// Acceptance criteria were deleted after the request was raised.
		mocks.client.userStory.findFirst.mockResolvedValue(
			story({ acceptanceCriteria: null }),
		);
		await expect(
			approveStageTransitionRequest({
				requestId: "req-1",
				projectId: "proj-1",
				reviewer: { userId: "approver" },
			}),
		).rejects.toBeInstanceOf(StageTransitionBlockedError);
		expect(mocks.client.userStory.updateMany).not.toHaveBeenCalled();
	});

	it("applies the stage with CAS and flips the request to APPROVED on success", async () => {
		mocks.client.stageTransitionRequest.findFirst.mockResolvedValue(
			pendingRequest,
		);
		mocks.client.projectStageApprover.findUnique.mockResolvedValue({
			userId: "approver",
		});
		mocks.client.project.findUnique.mockResolvedValue(
			project({ engagementProfile: "GOVERNED", approvers: 1 }),
		);
		mocks.client.userStory.findFirst.mockResolvedValue(story());
		mocks.client.stageTransitionRequest.updateMany.mockResolvedValue({
			count: 1,
		});

		const result = await approveStageTransitionRequest({
			requestId: "req-1",
			projectId: "proj-1",
			reviewer: { userId: "approver", organizationId: "org-1" },
			note: "LGTM",
		});
		expect(result).toEqual({ storyId: "story-1", toStage: "PUBLISHED" });
		expect(mocks.client.userStory.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ draftingStage: "DRAFT" }),
				data: expect.objectContaining({ draftingStage: "PUBLISHED" }),
			}),
		);
		expect(
			mocks.client.stageTransitionRequest.updateMany,
		).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "req-1", status: "PENDING" },
				data: expect.objectContaining({
					status: "APPROVED",
					reviewedById: "approver",
					reviewNote: "LGTM",
				}),
			}),
		);
		// Approval must never create a second request.
		expect(
			mocks.client.stageTransitionRequest.create,
		).not.toHaveBeenCalled();
	});

	it("fails with REQUEST_NOT_PENDING when the request was reviewed concurrently", async () => {
		mocks.client.stageTransitionRequest.findFirst.mockResolvedValue(
			pendingRequest,
		);
		mocks.client.projectStageApprover.findUnique.mockResolvedValue({
			userId: "approver",
		});
		mocks.client.project.findUnique.mockResolvedValue(
			project({ engagementProfile: "GOVERNED", approvers: 1 }),
		);
		mocks.client.userStory.findFirst.mockResolvedValue(story());
		mocks.client.stageTransitionRequest.updateMany.mockResolvedValue({
			count: 0,
		});
		const error = await approveStageTransitionRequest({
			requestId: "req-1",
			projectId: "proj-1",
			reviewer: { userId: "approver" },
		}).catch((e) => e);
		expect((error as StageApprovalError).code).toBe("REQUEST_NOT_PENDING");
	});

	it("reject: self-review and non-approver are refused; no stage write ever happens", async () => {
		mocks.client.stageTransitionRequest.findFirst.mockResolvedValue(
			pendingRequest,
		);
		const self = await rejectStageTransitionRequest({
			requestId: "req-1",
			projectId: "proj-1",
			reviewer: { userId: ACTOR.userId },
		}).catch((e) => e);
		expect((self as StageApprovalError).code).toBe("SELF_APPROVAL");

		mocks.client.projectStageApprover.findUnique.mockResolvedValue(null);
		const outsider = await rejectStageTransitionRequest({
			requestId: "req-1",
			projectId: "proj-1",
			reviewer: { userId: "outsider" },
		}).catch((e) => e);
		expect((outsider as StageApprovalError).code).toBe("NOT_AN_APPROVER");

		mocks.client.projectStageApprover.findUnique.mockResolvedValue({
			userId: "approver",
		});
		mocks.client.stageTransitionRequest.updateMany.mockResolvedValue({
			count: 1,
		});
		const ok = await rejectStageTransitionRequest({
			requestId: "req-1",
			projectId: "proj-1",
			reviewer: { userId: "approver" },
			note: "Needs AC",
		});
		expect(ok).toEqual({ storyId: "story-1" });
		expect(
			mocks.client.stageTransitionRequest.updateMany,
		).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "req-1", status: "PENDING" },
				data: expect.objectContaining({ status: "REJECTED" }),
			}),
		);
		expect(mocks.client.userStory.updateMany).not.toHaveBeenCalled();
	});
});

describe("withStageTransaction — RLS context derived from the project (guest-safe)", () => {
	const setConfigCalls = () =>
		(mocks.client as any).$executeRawUnsafe.mock.calls.map(
			(c: unknown[]) => [c[0], c[1]],
		);

	beforeEach(() => {
		(mocks.client as any).$executeRawUnsafe.mockResolvedValue(1);
		rls.withRLSContext.mockClear();
		mocks.client.stageTransitionRequest.findFirst.mockResolvedValue({
			id: "req-1",
			projectId: "proj-1",
			storyId: "story-1",
			requestedById: "requester",
			userId: "requester",
			organizationId: "org-1",
			status: "PENDING",
			fromStage: "DRAFT",
			toStage: "PUBLISHED",
			patch: null,
		});
		mocks.client.projectStageApprover.findUnique.mockResolvedValue({
			userId: "approver",
		});
		mocks.client.stageTransitionRequest.updateMany.mockResolvedValue({
			count: 1,
		});
	});

	it("uses the session RLS context when the caller's org matches the project's org", async () => {
		mocks.client.project.findUnique.mockResolvedValue({
			organizationId: "org-1",
			userId: "owner",
		});
		await runWithTenantContext(
			createOrganizationContext("org-1", "approver"),
			() =>
				rejectStageTransitionRequest({
					requestId: "req-1",
					projectId: "proj-1",
					reviewer: { userId: "approver", organizationId: "org-1" },
				}),
		);
		// Scope read + main transaction both under the session context.
		expect(rls.withRLSContext).toHaveBeenCalledTimes(2);
		expect(setConfigCalls()).toEqual([]);
	});

	it("sets request-derived RLS variables for a project-scoped guest under a personal session", async () => {
		mocks.client.project.findUnique.mockResolvedValue({
			organizationId: "org-host",
			userId: "owner",
		});
		mocks.client.stageTransitionRequest.findFirst.mockResolvedValue({
			id: "req-1",
			projectId: "proj-1",
			storyId: "story-1",
			requestedById: "requester",
			userId: "requester",
			organizationId: "org-host",
			status: "PENDING",
			fromStage: "DRAFT",
			toStage: "PUBLISHED",
			patch: null,
		});
		const ctx = createPersonalContext("approver");
		ctx.allowedProjectIds.push("proj-1");
		await runWithTenantContext(ctx, () =>
			rejectStageTransitionRequest({
				requestId: "req-1",
				projectId: "proj-1",
				reviewer: { userId: "approver", organizationId: "org-host" },
			}),
		);
		// One session-scoped read of the request row to learn its tenant …
		expect(rls.withRLSContext).toHaveBeenCalledTimes(1);
		// … then the main transaction runs under the request's tenant.
		expect(setConfigCalls()).toEqual([
			["SELECT set_config('app.tenant_type', $1, true)", "organization"],
			["SELECT set_config('app.tenant_id', $1, true)", "org-host"],
			["SELECT set_config('app.user_id', $1, true)", "approver"],
		]);
	});

	it("falls back to a plain transaction when no tenant context is active", async () => {
		mocks.client.project.findUnique.mockResolvedValue({
			organizationId: "org-1",
			userId: "owner",
		});
		await rejectStageTransitionRequest({
			requestId: "req-1",
			projectId: "proj-1",
			reviewer: { userId: "approver", organizationId: "org-1" },
		});
		expect(rls.withRLSContext).not.toHaveBeenCalled();
		expect(setConfigCalls()).toEqual([]);
	});
});

describe("personal-project guest approval — tenant rows are owner-owned (RLS)", () => {
	beforeEach(() => {
		(mocks.client as any).$executeRawUnsafe.mockResolvedValue(1);
		rls.withRLSContext.mockClear();
	});

	it("records the request with the owner's tenant identity and the guest as requester", async () => {
		mocks.client.project.findUnique.mockResolvedValue({
			engagementProfile: "GOVERNED",
			enforceSpecifyGate: false,
			enforceSpikeGate: false,
			enforceDiscoveryGate: false,
			organizationId: null,
			userId: "owner",
			_count: { stageApprovers: 1 },
		});
		mocks.client.userStory.findFirst.mockResolvedValue({
			draftingStage: "DRAFT",
			deliveryTrack: "SPECIFY",
			description: "d",
			acceptanceCriteria: "ac",
		});
		mocks.client.stageTransitionRequest.updateMany.mockResolvedValue({
			count: 0,
		});
		mocks.client.stageTransitionRequest.create.mockResolvedValue({
			id: "req-p",
		});

		const decision = await enforceStageTransition(client, {
			storyId: "story-1",
			projectId: "proj-personal",
			toStage: "SANITY_CHECK",
			reason: "manual",
			actor: { userId: "guest-requester", organizationId: null },
		});
		expect(decision.mode).toBe("request");
		expect(mocks.client.stageTransitionRequest.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					requestedById: "guest-requester",
					userId: "owner",
					organizationId: null,
				}),
			}),
		);
	});

	it("approval writes the FeatureVersion under the owner's identity with the guest as changedBy, in one owner-scoped transaction", async () => {
		mocks.client.project.findUnique.mockResolvedValue({
			engagementProfile: "GOVERNED",
			enforceSpecifyGate: false,
			enforceSpikeGate: false,
			enforceDiscoveryGate: false,
			organizationId: null,
			userId: "owner",
			_count: { stageApprovers: 1 },
		});
		mocks.client.stageTransitionRequest.findFirst.mockResolvedValue({
			id: "req-p",
			projectId: "proj-personal",
			storyId: "story-1",
			requestedById: "guest-requester",
			userId: "owner",
			organizationId: null,
			status: "PENDING",
			fromStage: "DRAFT",
			toStage: "SANITY_CHECK",
			patch: null,
		});
		mocks.client.projectStageApprover.findUnique.mockResolvedValue({
			userId: "guest-approver",
		});
		mocks.client.userStory.findFirst.mockResolvedValue({
			draftingStage: "DRAFT",
			deliveryTrack: "SPECIFY",
			description: "d",
			acceptanceCriteria: "ac",
			version: 2,
		});
		mocks.client.userStory.updateMany.mockResolvedValue({ count: 1 });
		mocks.client.featureVersion.createMany.mockResolvedValue({ count: 1 });
		mocks.client.stageTransitionRequest.updateMany.mockResolvedValue({
			count: 1,
		});

		const ctx = createPersonalContext("guest-approver");
		ctx.allowedProjectIds.push("proj-personal");
		await runWithTenantContext(ctx, () =>
			approveStageTransitionRequest({
				requestId: "req-p",
				projectId: "proj-personal",
				reviewer: { userId: "guest-approver", organizationId: null },
			}),
		);

		// Transaction impersonates the owner's personal tenant …
		expect(
			(mocks.client as any).$executeRawUnsafe.mock.calls.map(
				(c: unknown[]) => c[1],
			),
		).toEqual(["personal", "", "owner"]);
		// … and every tenant-owned row it writes is owner-owned.
		expect(mocks.client.featureVersion.createMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: [
					expect.objectContaining({
						userId: "owner",
						organizationId: null,
						changedBy: "guest-approver",
					}),
				],
			}),
		);
		expect(
			mocks.client.stageTransitionRequest.updateMany,
		).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "APPROVED",
					reviewedById: "guest-approver",
				}),
			}),
		);
	});
});
