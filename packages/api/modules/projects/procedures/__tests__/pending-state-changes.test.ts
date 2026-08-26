/**
 * Unit Tests for Pending PM State Change procedures
 *
 * Tests list, count, review, and bulk-review procedures for ADO state change proposals.
 *
 * Run with: pnpm --filter @repo/api test
 */

import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Capture handlers from procedure chains
const {
	handlers,
	mockDb,
	mockCreateFeatureVersion,
	mockApplyTerminalUnhide,
	mockApplyPmUnlink,
	mockApplyPmUnlinkTx,
	mockApplyTerminalCloseSpy,
	mockRecordAudit,
	mockRecordAuditTx,
} = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mockDb = {
		pendingPmStateChange: {
			findMany: vi.fn(),
			findUnique: vi.fn(),
			count: vi.fn(),
			update: vi.fn(),
			updateMany: vi.fn(),
		},
		userStory: {
			findUnique: vi.fn(),
			update: vi.fn(),
		},
		epic: {
			update: vi.fn(),
		},
		feature: {
			update: vi.fn(),
		},
		featureVersion: {
			upsert: vi.fn(),
		},
		$transaction: vi.fn(),
	};
	const mockCreateFeatureVersion = vi.fn().mockResolvedValue({});
	const mockApplyTerminalUnhide = vi
		.fn()
		.mockResolvedValue({ applied: true });
	const mockApplyPmUnlink = vi.fn().mockResolvedValue({ applied: true });
	const mockApplyPmUnlinkTx = vi.fn().mockResolvedValue({ applied: true });
	// Spy used to assert the `markAutoHidden` flag the single-row HIDE path
	// passes to applyTerminalClose (#1360 Task 7). The factory below delegates
	// to it before replicating applyTerminalClose's db writes.
	const mockApplyTerminalCloseSpy = vi.fn();
	const mockRecordAudit = vi.fn();
	const mockRecordAuditTx = vi.fn().mockResolvedValue(undefined);
	return {
		handlers,
		mockDb,
		mockCreateFeatureVersion,
		mockApplyTerminalUnhide,
		mockApplyPmUnlink,
		mockApplyPmUnlinkTx,
		mockApplyTerminalCloseSpy,
		mockRecordAudit,
		mockRecordAuditTx,
	};
});

vi.mock("@repo/database", () => ({
	db: mockDb,
	hasProjectAccess: vi.fn().mockResolvedValue(true),
	createFeatureVersion: mockCreateFeatureVersion,
	FeatureDraftingStage: {},
	applyTerminalUnhide: mockApplyTerminalUnhide,
	applyPmUnlink: mockApplyPmUnlink,
	applyPmUnlinkTx: mockApplyPmUnlinkTx,
	recordAudit: mockRecordAudit,
	recordAuditTx: mockRecordAuditTx,
	// applyTerminalClose is extracted from this package; replicate its behaviour
	// using the same mock db so existing assertions on db.epic/userStory/feature
	// still pass. Delegates to mockApplyTerminalCloseSpy first so tests can assert
	// the `markAutoHidden` flag the caller passed (#1360 Task 7) AND override the
	// returned `{ applied }` contract (#1360 Task 3): the real applyTerminalClose
	// returns { applied:false } as a no-op (missing / already-CLOSED / race-lost)
	// without writing anything, so a test that returns { applied:false } from the
	// spy short-circuits the replicated db writes too.
	applyTerminalClose: vi.fn(
		async (params: {
			entityType: string;
			entityId: string;
			projectId: string;
			userId: string | null;
			organizationId: string | null;
			changeDescription: string;
			markAutoHidden?: boolean;
		}) => {
			const override = mockApplyTerminalCloseSpy(params) as
				| { applied: boolean }
				| undefined;
			// No-op path: the real close wrote nothing, so neither does the mock.
			if (override && override.applied === false) {
				return { applied: false };
			}
			const {
				entityType,
				entityId,
				projectId,
				userId,
				organizationId,
				changeDescription,
				markAutoHidden,
			} = params;
			const now = new Date();
			if (entityType === "STORY") {
				const story = await mockDb.userStory.findUnique({
					where: { id: entityId, projectId },
					select: {
						id: true,
						version: true,
						description: true,
						acceptanceCriteria: true,
						draftingStage: true,
					},
				});
				if (!story) {
					return { applied: false };
				}
				const newVersion = (story.version ?? 1) + 1;
				await mockCreateFeatureVersion({
					storyId: story.id,
					version: newVersion,
					description: story.description ?? null,
					acceptanceCriteria: story.acceptanceCriteria ?? null,
					draftingStage: "CLOSED",
					changeDescription,
					changedBy: userId ?? undefined,
					userId: userId ?? undefined,
					organizationId: organizationId ?? undefined,
				});
				await mockDb.userStory.update({
					where: { id: entityId, projectId },
					data: {
						draftingStage: "CLOSED",
						draftingStageUpdatedAt: now,
						version: newVersion,
						pmAutoHidden: markAutoHidden === true,
					},
				});
			} else if (entityType === "EPIC") {
				await mockDb.epic.update({
					where: { id: entityId, projectId },
					data: {
						draftingStage: "CLOSED",
						draftingStageUpdatedAt: now,
						pmAutoHidden: markAutoHidden === true,
					},
				});
			} else if (entityType === "FEATURE") {
				await mockDb.feature.update({
					where: { id: entityId, projectId },
					data: {
						draftingStage: "CLOSED",
						draftingStageUpdatedAt: now,
						pmAutoHidden: markAutoHidden === true,
					},
				});
			}
			return { applied: true };
		},
	),
}));

vi.mock("../../../../orpc/procedures", () => {
	let idx = 0;
	const names = ["list", "count", "review", "bulk"];
	const chainable: any = {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			const name = names[idx] ?? `handler_${idx}`;
			handlers[name] = fn;
			idx++;
			return { _handler: fn };
		},
	};

	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
		requireProjectPermission: () => (c: unknown) => c,
		resolveOrganizationId: vi.fn(
			(organizationId: string | null) => organizationId,
		),
	};
});

// Import procedures to register handlers
import "../list-pending-state-changes";
import "../count-pending-state-changes";
import "../review-pending-state-change";
import "../bulk-review-pending-state-changes";

const mockContext = {
	user: { id: "user-1" },
	session: { activeOrganizationId: null },
};

describe("listPendingStateChangesProcedure", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns paginated results", async () => {
		const mockChanges = [
			{
				id: "ch-1",
				projectId: "proj-1",
				entityType: "STORY",
				entityId: "s-1",
				externalId: "101",
				previousState: "DRAFTING",
				newState: "Closed",
				proposedAction: "HIDE",
				status: "PENDING",
				createdAt: new Date(),
			},
			{
				id: "ch-2",
				projectId: "proj-1",
				entityType: "FEATURE",
				entityId: "f-1",
				externalId: "102",
				previousState: "READY",
				newState: "Done",
				proposedAction: "HIDE",
				status: "PENDING",
				createdAt: new Date(),
			},
		];

		mockDb.pendingPmStateChange.findMany.mockResolvedValue(mockChanges);
		mockDb.pendingPmStateChange.count.mockResolvedValue(2);

		const result = (await handlers.list({
			input: {
				projectId: "proj-1",
				organizationId: null,
				status: "PENDING",
				limit: 50,
				offset: 0,
			},
			context: mockContext,
		})) as any;

		expect(result.changes).toHaveLength(2);
		expect(result.total).toBe(2);
		expect(mockDb.pendingPmStateChange.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { projectId: "proj-1", status: "PENDING" },
				take: 50,
				skip: 0,
			}),
		);
	});
});

describe("countPendingStateChangesProcedure", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns correct count", async () => {
		mockDb.pendingPmStateChange.count.mockResolvedValue(5);

		const result = (await handlers.count({
			input: { projectId: "proj-1", organizationId: null },
			context: mockContext,
		})) as any;

		expect(result.count).toBe(5);
		expect(mockDb.pendingPmStateChange.count).toHaveBeenCalledWith({
			where: { projectId: "proj-1", status: "PENDING" },
		});
	});
});

describe("reviewPendingStateChangeProcedure", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("approves and applies hide on APPROVED decision", async () => {
		mockDb.pendingPmStateChange.findUnique.mockResolvedValue({
			id: "ch-1",
			projectId: "proj-1",
			entityType: "EPIC",
			entityId: "epic-1",
			status: "PENDING",
			proposedAction: "HIDE",
		});
		mockDb.pendingPmStateChange.update.mockResolvedValue({
			id: "ch-1",
			status: "APPROVED",
		});
		mockDb.epic.update.mockResolvedValue({});

		const result = (await handlers.review({
			input: {
				projectId: "proj-1",
				id: "ch-1",
				organizationId: null,
				decision: "APPROVED",
			},
			context: mockContext,
		})) as any;

		expect(result.change.status).toBe("APPROVED");
		expect(mockDb.epic.update).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "epic-1", projectId: "proj-1" },
				data: expect.objectContaining({ draftingStage: "CLOSED" }),
			}),
		);
	});

	it("dismisses without applying hide", async () => {
		mockDb.pendingPmStateChange.findUnique.mockResolvedValue({
			id: "ch-1",
			projectId: "proj-1",
			entityType: "STORY",
			entityId: "story-1",
			status: "PENDING",
			proposedAction: "HIDE",
		});
		mockDb.pendingPmStateChange.update.mockResolvedValue({
			id: "ch-1",
			status: "DISMISSED",
		});

		const result = (await handlers.review({
			input: {
				projectId: "proj-1",
				id: "ch-1",
				organizationId: null,
				decision: "DISMISSED",
			},
			context: mockContext,
		})) as any;

		expect(result.change.status).toBe("DISMISSED");
		expect(mockDb.userStory.update).not.toHaveBeenCalled();
	});

	it("returns CONFLICT for already-reviewed change", async () => {
		mockDb.pendingPmStateChange.findUnique.mockResolvedValue({
			id: "ch-1",
			projectId: "proj-1",
			entityType: "STORY",
			entityId: "story-1",
			status: "APPROVED", // already reviewed
			proposedAction: "HIDE",
		});

		await expect(
			handlers.review({
				input: {
					projectId: "proj-1",
					id: "ch-1",
					organizationId: null,
					decision: "APPROVED",
				},
				context: mockContext,
			}),
		).rejects.toThrow(ORPCError);

		try {
			await handlers.review({
				input: {
					projectId: "proj-1",
					id: "ch-1",
					organizationId: null,
					decision: "APPROVED",
				},
				context: mockContext,
			});
		} catch (e: any) {
			expect(e.code).toBe("CONFLICT");
		}
	});

	it("applies hide to UserStory with version increment and FeatureVersion", async () => {
		mockDb.pendingPmStateChange.findUnique.mockResolvedValue({
			id: "ch-1",
			projectId: "proj-1",
			entityType: "STORY",
			entityId: "story-1",
			status: "PENDING",
			proposedAction: "HIDE",
		});
		mockDb.userStory.findUnique.mockResolvedValue({
			id: "story-1",
			version: 3,
			description: "My story desc",
			acceptanceCriteria: "AC here",
			draftingStage: "DRAFTING",
		});
		mockDb.userStory.update.mockResolvedValue({});
		mockDb.pendingPmStateChange.update.mockResolvedValue({
			id: "ch-1",
			status: "APPROVED",
		});

		await handlers.review({
			input: {
				projectId: "proj-1",
				id: "ch-1",
				organizationId: null,
				decision: "APPROVED",
			},
			context: mockContext,
		});

		expect(mockCreateFeatureVersion).toHaveBeenCalledWith(
			expect.objectContaining({
				storyId: "story-1",
				version: 4,
				draftingStage: "CLOSED",
			}),
		);
		expect(mockDb.userStory.update).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "story-1", projectId: "proj-1" },
				data: expect.objectContaining({
					draftingStage: "CLOSED",
					version: 4,
				}),
			}),
		);
	});

	it("applies hide to Feature with draftingStage: CLOSED", async () => {
		mockDb.pendingPmStateChange.findUnique.mockResolvedValue({
			id: "ch-1",
			projectId: "proj-1",
			entityType: "FEATURE",
			entityId: "feat-1",
			status: "PENDING",
			proposedAction: "HIDE",
		});
		mockDb.pendingPmStateChange.update.mockResolvedValue({
			id: "ch-1",
			status: "APPROVED",
		});
		mockDb.feature.update.mockResolvedValue({});

		await handlers.review({
			input: {
				projectId: "proj-1",
				id: "ch-1",
				organizationId: null,
				decision: "APPROVED",
			},
			context: mockContext,
		});

		expect(mockDb.feature.update).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "feat-1", projectId: "proj-1" },
				data: expect.objectContaining({ draftingStage: "CLOSED" }),
			}),
		);
	});

	it("Task 7 (#1360): single-row APPROVED EPIC HIDE calls applyTerminalClose with markAutoHidden:true (sets UNHIDE marker)", async () => {
		// Epic/feature have no auto-hide poll path, so a single-row Accept-HIDE is
		// the only PM-driven close — it MUST set the pmAutoHidden provenance marker
		// or the entity can never produce a later UNHIDE proposal.
		mockDb.pendingPmStateChange.findUnique.mockResolvedValue({
			id: "ch-epic-hide",
			projectId: "proj-1",
			entityType: "EPIC",
			entityId: "epic-1",
			status: "PENDING",
			proposedAction: "HIDE",
		});
		mockDb.pendingPmStateChange.update.mockResolvedValue({
			id: "ch-epic-hide",
			status: "APPROVED",
		});
		mockDb.epic.update.mockResolvedValue({});

		await handlers.review({
			input: {
				projectId: "proj-1",
				id: "ch-epic-hide",
				organizationId: null,
				decision: "APPROVED",
			},
			context: mockContext,
		});

		expect(mockApplyTerminalCloseSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				entityType: "EPIC",
				entityId: "epic-1",
				markAutoHidden: true,
			}),
		);
		expect(mockDb.epic.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					draftingStage: "CLOSED",
					pmAutoHidden: true,
				}),
			}),
		);
	});

	it("Task 7 (#1360): single-row APPROVED FEATURE HIDE calls applyTerminalClose with markAutoHidden:true", async () => {
		mockDb.pendingPmStateChange.findUnique.mockResolvedValue({
			id: "ch-feat-hide",
			projectId: "proj-1",
			entityType: "FEATURE",
			entityId: "feat-1",
			status: "PENDING",
			proposedAction: "HIDE",
		});
		mockDb.pendingPmStateChange.update.mockResolvedValue({
			id: "ch-feat-hide",
			status: "APPROVED",
		});
		mockDb.feature.update.mockResolvedValue({});

		await handlers.review({
			input: {
				projectId: "proj-1",
				id: "ch-feat-hide",
				organizationId: null,
				decision: "APPROVED",
			},
			context: mockContext,
		});

		expect(mockApplyTerminalCloseSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				entityType: "FEATURE",
				entityId: "feat-1",
				markAutoHidden: true,
			}),
		);
		expect(mockDb.feature.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					draftingStage: "CLOSED",
					pmAutoHidden: true,
				}),
			}),
		);
	});

	it("Task 7 regression (#1360): single-row APPROVED STORY HIDE calls applyTerminalClose with markAutoHidden falsy (STORY marker stays cleared)", async () => {
		// A human Accept of a STORY HIDE is intentional, not auto-hidden — the
		// STORY auto-hide poll path owns pmAutoHidden, so single-row Accept must
		// NOT set it (otherwise a manual close would later masquerade as a PM hide).
		mockDb.pendingPmStateChange.findUnique.mockResolvedValue({
			id: "ch-story-hide",
			projectId: "proj-1",
			entityType: "STORY",
			entityId: "story-1",
			status: "PENDING",
			proposedAction: "HIDE",
		});
		mockDb.userStory.findUnique.mockResolvedValue({
			id: "story-1",
			version: 3,
			description: "desc",
			acceptanceCriteria: "AC",
			draftingStage: "DRAFTING",
		});
		mockDb.userStory.update.mockResolvedValue({});
		mockDb.pendingPmStateChange.update.mockResolvedValue({
			id: "ch-story-hide",
			status: "APPROVED",
		});

		await handlers.review({
			input: {
				projectId: "proj-1",
				id: "ch-story-hide",
				organizationId: null,
				decision: "APPROVED",
			},
			context: mockContext,
		});

		const passed = mockApplyTerminalCloseSpy.mock.calls[0][0];
		expect(passed.entityType).toBe("STORY");
		expect(passed.markAutoHidden).toBeFalsy();
		// The replicated close writes pmAutoHidden:false for STORY single-row Accept.
		expect(mockDb.userStory.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ pmAutoHidden: false }),
			}),
		);
	});

	it("Task 3 (#1360): HIDE approval on an already-closed/race-lost entity (applyTerminalClose → {applied:false}) DISMISSES, does NOT record APPROVED", async () => {
		// With Task 2's { applied } contract, applyTerminalClose returns
		// { applied:false } on a no-op (entity missing / already CLOSED / guard lost
		// a concurrent race). The HIDE-approval branch must mirror UNHIDE: dismiss
		// the pending row instead of falling through to a phantom APPROVED.
		mockApplyTerminalCloseSpy.mockReturnValue({ applied: false });
		mockDb.pendingPmStateChange.findUnique.mockResolvedValue({
			id: "ch-hide-noop",
			projectId: "proj-1",
			entityType: "STORY",
			entityId: "story-already-closed",
			status: "PENDING",
			proposedAction: "HIDE",
		});
		mockDb.pendingPmStateChange.update.mockResolvedValue({
			id: "ch-hide-noop",
			status: "DISMISSED",
		});

		const result = (await handlers.review({
			input: {
				projectId: "proj-1",
				id: "ch-hide-noop",
				organizationId: null,
				decision: "APPROVED",
			},
			context: mockContext,
		})) as any;

		expect(mockApplyTerminalCloseSpy).toHaveBeenCalled();
		expect(mockDb.pendingPmStateChange.update).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "ch-hide-noop" },
				data: expect.objectContaining({
					status: "DISMISSED",
					reviewedBy: "user-1",
				}),
			}),
		);
		// The phantom-APPROVED fall-through must NOT fire.
		expect(mockDb.pendingPmStateChange.update).not.toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: "APPROVED" }),
			}),
		);
		expect(result.change.status).toBe("DISMISSED");
	});

	it("Task 8: APPROVED + UNHIDE calls applyTerminalUnhide and marks row APPROVED when applied:true", async () => {
		mockApplyTerminalUnhide.mockResolvedValue({ applied: true });
		mockDb.pendingPmStateChange.findUnique.mockResolvedValue({
			id: "ch-unhide",
			projectId: "proj-1",
			entityType: "STORY",
			entityId: "story-hidden",
			status: "PENDING",
			proposedAction: "UNHIDE",
		});
		mockDb.pendingPmStateChange.update.mockResolvedValue({
			id: "ch-unhide",
			status: "APPROVED",
		});

		const result = (await handlers.review({
			input: {
				projectId: "proj-1",
				id: "ch-unhide",
				organizationId: null,
				decision: "APPROVED",
			},
			context: mockContext,
		})) as any;

		expect(mockApplyTerminalUnhide).toHaveBeenCalledWith(
			expect.objectContaining({
				entityId: "story-hidden",
				projectId: "proj-1",
				userId: "user-1",
				organizationId: null,
			}),
		);
		expect(result.change.status).toBe("APPROVED");
	});

	it("Task 8: DISMISSED + UNHIDE does NOT call applyTerminalUnhide", async () => {
		mockDb.pendingPmStateChange.findUnique.mockResolvedValue({
			id: "ch-unhide-2",
			projectId: "proj-1",
			entityType: "STORY",
			entityId: "story-hidden-2",
			status: "PENDING",
			proposedAction: "UNHIDE",
		});
		mockDb.pendingPmStateChange.update.mockResolvedValue({
			id: "ch-unhide-2",
			status: "DISMISSED",
		});

		const result = (await handlers.review({
			input: {
				projectId: "proj-1",
				id: "ch-unhide-2",
				organizationId: null,
				decision: "DISMISSED",
			},
			context: mockContext,
		})) as any;

		expect(mockApplyTerminalUnhide).not.toHaveBeenCalled();
		expect(result.change.status).toBe("DISMISSED");
	});

	it("Bug fix: APPROVED + UNHIDE where story is missing (applied:false) → row marked DISMISSED, not APPROVED", async () => {
		mockApplyTerminalUnhide.mockResolvedValue({ applied: false });
		mockDb.pendingPmStateChange.findUnique.mockResolvedValue({
			id: "ch-unhide-missing",
			projectId: "proj-1",
			entityType: "STORY",
			entityId: "story-gone",
			status: "PENDING",
			proposedAction: "UNHIDE",
		});
		mockDb.pendingPmStateChange.update.mockResolvedValue({
			id: "ch-unhide-missing",
			status: "DISMISSED",
		});

		const result = (await handlers.review({
			input: {
				projectId: "proj-1",
				id: "ch-unhide-missing",
				organizationId: null,
				decision: "APPROVED",
			},
			context: mockContext,
		})) as any;

		expect(mockApplyTerminalUnhide).toHaveBeenCalled();
		expect(mockDb.pendingPmStateChange.update).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "ch-unhide-missing" },
				data: expect.objectContaining({ status: "DISMISSED" }),
			}),
		);
		expect(result.change.status).toBe("DISMISSED");
	});

	it("Bug fix: APPROVED + UNHIDE where story already unhidden (applied:false) → row marked DISMISSED, not APPROVED", async () => {
		mockApplyTerminalUnhide.mockResolvedValue({ applied: false });
		mockDb.pendingPmStateChange.findUnique.mockResolvedValue({
			id: "ch-unhide-noop",
			projectId: "proj-1",
			entityType: "STORY",
			entityId: "story-already-open",
			status: "PENDING",
			proposedAction: "UNHIDE",
		});
		mockDb.pendingPmStateChange.update.mockResolvedValue({
			id: "ch-unhide-noop",
			status: "DISMISSED",
		});

		const result = (await handlers.review({
			input: {
				projectId: "proj-1",
				id: "ch-unhide-noop",
				organizationId: null,
				decision: "APPROVED",
			},
			context: mockContext,
		})) as any;

		expect(mockApplyTerminalUnhide).toHaveBeenCalled();
		expect(mockDb.pendingPmStateChange.update).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "ch-unhide-noop" },
				data: expect.objectContaining({ status: "DISMISSED" }),
			}),
		);
		expect(result.change.status).toBe("DISMISSED");
	});

	it("Task 7 (#1360): single-row APPROVED + UNHIDE EPIC calls applyTerminalUnhide with entityType:EPIC and marks row APPROVED", async () => {
		// UNHIDE now generalizes to epic/feature — the single-row dismiss guard is
		// gone, so an EPIC UNHIDE flows through applyTerminalUnhide (not DISMISSED).
		mockApplyTerminalUnhide.mockResolvedValue({ applied: true });
		mockDb.pendingPmStateChange.findUnique.mockResolvedValue({
			id: "ch-unhide-epic",
			projectId: "proj-1",
			entityType: "EPIC",
			entityId: "epic-1",
			status: "PENDING",
			proposedAction: "UNHIDE",
		});
		mockDb.pendingPmStateChange.update.mockResolvedValue({
			id: "ch-unhide-epic",
			status: "APPROVED",
		});

		const result = (await handlers.review({
			input: {
				projectId: "proj-1",
				id: "ch-unhide-epic",
				organizationId: null,
				decision: "APPROVED",
			},
			context: mockContext,
		})) as any;

		expect(mockApplyTerminalUnhide).toHaveBeenCalledWith(
			expect.objectContaining({
				entityType: "EPIC",
				entityId: "epic-1",
				projectId: "proj-1",
			}),
		);
		expect(result.change.status).toBe("APPROVED");
	});

	describe("review FLAG_MISSING (#1360)", () => {
		// The single-row FLAG_MISSING Accept now atomically consumes the PENDING
		// row inside a tx (updateMany count 1 → APPROVED) then unlinks via
		// applyPmUnlinkTx; the row state is finalized in-tx and the handler returns
		// the post-tx findUnique snapshot.
		it("Accept unlinks a story and records audit when applied", async () => {
			mockDb.$transaction.mockImplementation(async (fn: any) =>
				fn(mockDb),
			);
			mockApplyPmUnlinkTx.mockResolvedValue({ applied: true });
			mockDb.pendingPmStateChange.findUnique
				.mockResolvedValueOnce({
					id: "pc1",
					projectId: "proj-1",
					entityType: "STORY",
					entityId: "s1",
					externalId: "123",
					expectedExternalMcpServerId: "srv-1",
					status: "PENDING",
					proposedAction: "FLAG_MISSING",
				})
				.mockResolvedValueOnce({ id: "pc1", status: "APPROVED" });
			mockDb.pendingPmStateChange.updateMany.mockResolvedValue({
				count: 1,
			});

			const result = (await handlers.review({
				input: {
					projectId: "proj-1",
					id: "pc1",
					organizationId: null,
					decision: "APPROVED",
				},
				context: mockContext,
			})) as any;

			expect(mockApplyPmUnlinkTx).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					entityType: "STORY",
					entityId: "s1",
					expectedExternalId: "123",
					// Fix B: the detected server flows into the unlink guard.
					expectedExternalMcpServerId: "srv-1",
					projectId: "proj-1",
				}),
			);
			expect(mockRecordAudit).toHaveBeenCalledWith(
				expect.objectContaining({ action: "story.pm_ticket_unlinked" }),
			);
			expect(result.change.status).toBe("APPROVED");
		});

		it("Accept dismisses (no audit) when the story was retooled to a different server (Fix B)", async () => {
			// The pending row carries the OLD server; the consume succeeds (the row
			// is still pending on the OLD snapshot) but applyPmUnlinkTx's server-
			// scoped where won't match the retooled story → {applied:false} → DISMISSED.
			mockDb.$transaction.mockImplementation(async (fn: any) =>
				fn(mockDb),
			);
			mockApplyPmUnlinkTx.mockResolvedValue({ applied: false });
			mockDb.pendingPmStateChange.findUnique
				.mockResolvedValueOnce({
					id: "pc1",
					projectId: "proj-1",
					entityType: "STORY",
					entityId: "s1",
					externalId: "123",
					expectedExternalMcpServerId: "srv-OLD",
					status: "PENDING",
					proposedAction: "FLAG_MISSING",
				})
				.mockResolvedValueOnce({ id: "pc1", status: "DISMISSED" });
			mockDb.pendingPmStateChange.updateMany.mockResolvedValue({
				count: 1,
			});
			mockDb.pendingPmStateChange.update.mockResolvedValue({
				id: "pc1",
				status: "DISMISSED",
			});

			const result = (await handlers.review({
				input: {
					projectId: "proj-1",
					id: "pc1",
					organizationId: null,
					decision: "APPROVED",
				},
				context: mockContext,
			})) as any;

			expect(mockApplyPmUnlinkTx).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					expectedExternalMcpServerId: "srv-OLD",
				}),
			);
			expect(mockRecordAudit).not.toHaveBeenCalled();
			expect(result.change.status).toBe("DISMISSED");
		});

		it("Accept dismisses (no audit) when applyPmUnlinkTx returns {applied:false}", async () => {
			mockDb.$transaction.mockImplementation(async (fn: any) =>
				fn(mockDb),
			);
			mockApplyPmUnlinkTx.mockResolvedValue({ applied: false });
			mockDb.pendingPmStateChange.findUnique
				.mockResolvedValueOnce({
					id: "pc1",
					projectId: "proj-1",
					entityType: "STORY",
					entityId: "s1",
					externalId: "123",
					status: "PENDING",
					proposedAction: "FLAG_MISSING",
				})
				.mockResolvedValueOnce({ id: "pc1", status: "DISMISSED" });
			mockDb.pendingPmStateChange.updateMany.mockResolvedValue({
				count: 1,
			});
			mockDb.pendingPmStateChange.update.mockResolvedValue({
				id: "pc1",
				status: "DISMISSED",
			});

			const result = (await handlers.review({
				input: {
					projectId: "proj-1",
					id: "pc1",
					organizationId: null,
					decision: "APPROVED",
				},
				context: mockContext,
			})) as any;

			expect(mockApplyPmUnlinkTx).toHaveBeenCalled();
			expect(result.change.status).toBe("DISMISSED");
			expect(mockRecordAudit).not.toHaveBeenCalled();
		});

		it("Task 7 (#1360): single-row Accept FLAG_MISSING EPIC calls applyPmUnlinkTx with entityType:EPIC + audits with resource.type epic", async () => {
			// FLAG_MISSING now generalizes to epic/feature — the single-row dismiss
			// guard is gone, so an EPIC FLAG_MISSING flows through applyPmUnlinkTx with
			// the true entityType, and the audit attribution carries the lowercased
			// resource.type (not the hardcoded "story").
			mockDb.$transaction.mockImplementation(async (fn: any) =>
				fn(mockDb),
			);
			mockApplyPmUnlinkTx.mockResolvedValue({ applied: true });
			mockDb.pendingPmStateChange.findUnique
				.mockResolvedValueOnce({
					id: "pc1",
					projectId: "proj-1",
					entityType: "EPIC",
					entityId: "e1",
					externalId: "123",
					expectedExternalMcpServerId: "srv-1",
					status: "PENDING",
					proposedAction: "FLAG_MISSING",
				})
				.mockResolvedValueOnce({ id: "pc1", status: "APPROVED" });
			mockDb.pendingPmStateChange.updateMany.mockResolvedValue({
				count: 1,
			});

			const result = (await handlers.review({
				input: {
					projectId: "proj-1",
					id: "pc1",
					organizationId: null,
					decision: "APPROVED",
				},
				context: mockContext,
			})) as any;

			expect(mockApplyPmUnlinkTx).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					entityType: "EPIC",
					entityId: "e1",
					expectedExternalId: "123",
					expectedExternalMcpServerId: "srv-1",
					projectId: "proj-1",
				}),
			);
			expect(mockRecordAudit).toHaveBeenCalledWith(
				expect.objectContaining({
					action: "story.pm_ticket_unlinked",
					resource: { type: "epic", id: "e1" },
					metadata: { externalId: "123", entityType: "EPIC" },
				}),
			);
			expect(result.change.status).toBe("APPROVED");
		});
	});
});

describe("review (single-row) FLAG_MISSING atomic consume", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("consumes the PENDING row then unlinks (count 1 → applied)", async () => {
		mockDb.$transaction.mockImplementation(async (fn: any) => fn(mockDb));
		mockDb.pendingPmStateChange.findUnique.mockResolvedValue({
			id: "row-1",
			projectId: "p1",
			status: "PENDING",
			proposedAction: "FLAG_MISSING",
			entityType: "STORY",
			entityId: "s1",
			externalId: "123",
			expectedExternalMcpServerId: "srv-1",
		});
		mockDb.pendingPmStateChange.updateMany.mockResolvedValue({ count: 1 });
		mockApplyPmUnlinkTx.mockResolvedValue({ applied: true });

		await handlers.review({
			input: { projectId: "p1", id: "row-1", decision: "APPROVED" },
			context: { user: { id: "u1" }, session: {} },
		});

		expect(mockDb.pendingPmStateChange.updateMany).toHaveBeenCalledWith({
			where: {
				id: "row-1",
				status: "PENDING",
				proposedAction: "FLAG_MISSING",
				externalId: "123",
				expectedExternalMcpServerId: "srv-1",
			},
			data: expect.objectContaining({ status: "APPROVED" }),
		});
		expect(mockApplyPmUnlinkTx).toHaveBeenCalled();
		expect(mockRecordAudit).toHaveBeenCalledWith(
			expect.objectContaining({ action: "story.pm_ticket_unlinked" }),
		);
	});

	it("REFRESH RACE: row refreshed to a different ticket (snapshot mismatch → count 0) → CONFLICT, NOT DISMISSED", async () => {
		mockDb.$transaction.mockImplementation(async (fn: any) => fn(mockDb));
		mockDb.pendingPmStateChange.findUnique.mockResolvedValue({
			id: "row-1",
			projectId: "p1",
			status: "PENDING",
			proposedAction: "FLAG_MISSING",
			entityType: "STORY",
			entityId: "s1",
			externalId: "123",
			expectedExternalMcpServerId: "srv-1",
		});
		// The poll refreshed row-1 to a new ticket, so the snapshot-scoped consume matches 0.
		mockDb.pendingPmStateChange.updateMany.mockResolvedValue({ count: 0 });

		await expect(
			handlers.review({
				input: { projectId: "p1", id: "row-1", decision: "APPROVED" },
				context: { user: { id: "u1" }, session: {} },
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });

		expect(mockApplyPmUnlinkTx).not.toHaveBeenCalled();
		// The refreshed row must NOT be dismissed (would poison re-detection of the new ticket).
		expect(mockDb.pendingPmStateChange.update).not.toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: "DISMISSED" }),
			}),
		);
	});

	it("RACE: row auto-dismissed before consume (count 0) → CONFLICT, NO unlink", async () => {
		mockDb.$transaction.mockImplementation(async (fn: any) => fn(mockDb));
		mockDb.pendingPmStateChange.findUnique.mockResolvedValue({
			id: "row-1",
			projectId: "p1",
			status: "PENDING",
			proposedAction: "FLAG_MISSING",
			entityType: "STORY",
			entityId: "s1",
			externalId: "123",
			expectedExternalMcpServerId: "srv-1",
		});
		mockDb.pendingPmStateChange.updateMany.mockResolvedValue({ count: 0 });

		await expect(
			handlers.review({
				input: { projectId: "p1", id: "row-1", decision: "APPROVED" },
				context: { user: { id: "u1" }, session: {} },
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });

		expect(mockApplyPmUnlinkTx).not.toHaveBeenCalled();
	});

	it("consume 1 but unlink not applied (re-link/retool) → DISMISSED, no audit", async () => {
		mockDb.$transaction.mockImplementation(async (fn: any) => fn(mockDb));
		mockDb.pendingPmStateChange.findUnique.mockResolvedValue({
			id: "row-1",
			projectId: "p1",
			status: "PENDING",
			proposedAction: "FLAG_MISSING",
			entityType: "STORY",
			entityId: "s1",
			externalId: "123",
			expectedExternalMcpServerId: "srv-1",
		});
		mockDb.pendingPmStateChange.updateMany.mockResolvedValue({ count: 1 });
		mockApplyPmUnlinkTx.mockResolvedValue({ applied: false });

		await handlers.review({
			input: { projectId: "p1", id: "row-1", decision: "APPROVED" },
			context: { user: { id: "u1" }, session: {} },
		});

		expect(mockDb.pendingPmStateChange.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: "DISMISSED" }),
			}),
		);
		expect(mockRecordAudit).not.toHaveBeenCalled();
	});
});

describe("bulkReviewPendingStateChangesProcedure", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("applies to all matching PENDING changes", async () => {
		const changes = [
			{
				id: "ch-1",
				projectId: "proj-1",
				entityType: "EPIC",
				entityId: "epic-1",
				status: "PENDING",
				proposedAction: "HIDE",
			},
			{
				id: "ch-2",
				projectId: "proj-1",
				entityType: "FEATURE",
				entityId: "feat-1",
				status: "PENDING",
				proposedAction: "HIDE",
			},
		];

		// Mock $transaction to execute the callback with a tx mock
		mockDb.$transaction.mockImplementation(async (fn: any) => {
			const tx = {
				pendingPmStateChange: {
					findMany: vi.fn().mockResolvedValue(changes),
					update: vi.fn().mockResolvedValue({}),
				},
				epic: {
					update: vi.fn().mockResolvedValue({}),
				},
				feature: {
					update: vi.fn().mockResolvedValue({}),
				},
				userStory: {
					findUnique: vi.fn(),
					update: vi.fn(),
				},
				featureVersion: {
					upsert: vi.fn().mockResolvedValue({}),
				},
			};
			return fn(tx);
		});

		const result = (await handlers.bulk({
			input: {
				projectId: "proj-1",
				organizationId: null,
				ids: ["ch-1", "ch-2"],
				decision: "APPROVED",
			},
			context: mockContext,
		})) as any;

		expect(result.reviewed).toBe(2);
	});

	it("dismisses without applying hide in bulk", async () => {
		const changes = [
			{
				id: "ch-1",
				projectId: "proj-1",
				entityType: "STORY",
				entityId: "s-1",
				status: "PENDING",
				proposedAction: "HIDE",
			},
		];

		let epicUpdateCalled = false;
		let storyUpdateCalled = false;

		mockDb.$transaction.mockImplementation(async (fn: any) => {
			const tx = {
				pendingPmStateChange: {
					findMany: vi.fn().mockResolvedValue(changes),
					update: vi.fn().mockResolvedValue({}),
				},
				epic: {
					update: vi.fn().mockImplementation(() => {
						epicUpdateCalled = true;
					}),
				},
				feature: {
					update: vi.fn(),
				},
				userStory: {
					findUnique: vi.fn(),
					update: vi.fn().mockImplementation(() => {
						storyUpdateCalled = true;
					}),
				},
				featureVersion: {
					upsert: vi.fn(),
				},
			};
			return fn(tx);
		});

		const result = (await handlers.bulk({
			input: {
				projectId: "proj-1",
				organizationId: null,
				ids: ["ch-1"],
				decision: "DISMISSED",
			},
			context: mockContext,
		})) as any;

		expect(result.reviewed).toBe(1);
		expect(epicUpdateCalled).toBe(false);
		expect(storyUpdateCalled).toBe(false);
	});

	it("Task 6: applyHideInTransaction clears pmAutoHidden on STORY approve (manual hide is intentional, not auto)", async () => {
		const changes = [
			{
				id: "ch-1",
				projectId: "proj-1",
				entityType: "STORY",
				entityId: "s-1",
				status: "PENDING",
				proposedAction: "HIDE",
			},
		];

		let storyUpdateData: any = null;

		mockDb.$transaction.mockImplementation(async (fn: any) => {
			const tx = {
				pendingPmStateChange: {
					findMany: vi.fn().mockResolvedValue(changes),
					update: vi.fn().mockResolvedValue({}),
				},
				epic: { update: vi.fn() },
				feature: { update: vi.fn() },
				userStory: {
					findUnique: vi.fn().mockResolvedValue({
						id: "s-1",
						version: 2,
						description: "desc",
						acceptanceCriteria: null,
						draftingStage: "DRAFTING",
					}),
					update: vi.fn().mockImplementation((args: any) => {
						storyUpdateData = args.data;
						return Promise.resolve({});
					}),
				},
				featureVersion: {
					upsert: vi.fn().mockResolvedValue({}),
				},
			};
			return fn(tx);
		});

		await handlers.bulk({
			input: {
				projectId: "proj-1",
				organizationId: null,
				ids: ["ch-1"],
				decision: "APPROVED",
			},
			context: mockContext,
		});

		expect(storyUpdateData).toMatchObject({
			draftingStage: "CLOSED",
			pmAutoHidden: false,
		});
	});

	it("REFUSES a CONTENT_DRIFT row (spec §6.5 — bulk never runs ADO ingests)", async () => {
		const changes = [
			{
				id: "ch-1",
				projectId: "proj-1",
				entityType: "STORY",
				entityId: "s-1",
				status: "PENDING",
				proposedAction: "HIDE",
			},
			{
				id: "ch-2",
				projectId: "proj-1",
				entityType: "FEATURE",
				entityId: "f-1",
				status: "PENDING",
				proposedAction: "CONTENT_DRIFT",
			},
		];

		let storyUpdated = false;
		mockDb.$transaction.mockImplementation(async (fn: any) => {
			const tx = {
				pendingPmStateChange: {
					findMany: vi.fn().mockResolvedValue(changes),
					update: vi.fn().mockImplementation(() => {
						storyUpdated = true;
					}),
				},
				epic: { update: vi.fn() },
				feature: { update: vi.fn() },
				userStory: { findUnique: vi.fn(), update: vi.fn() },
				featureVersion: { upsert: vi.fn() },
			};
			return fn(tx);
		});

		await expect(
			handlers.bulk({
				input: {
					projectId: "proj-1",
					organizationId: null,
					ids: ["ch-1", "ch-2"],
					decision: "APPROVED",
				},
				context: mockContext,
			}),
		).rejects.toThrow(ORPCError);

		// The refusal short-circuits BEFORE any per-item status flip — the whole
		// batch is rejected, so the sibling HIDE row is not touched either.
		expect(storyUpdated).toBe(false);
	});

	it("Task 8: bulk APPROVED + UNHIDE story (eligible: CLOSED+pmAutoHidden) → DRAFT + cleared markers, row APPROVED", async () => {
		const changes = [
			{
				id: "ch-unhide-bulk",
				projectId: "proj-1",
				entityType: "STORY",
				entityId: "s-hidden",
				status: "PENDING",
				proposedAction: "UNHIDE",
			},
		];

		let storyUpdateData: any = null;
		let featureVersionUpserted = false;
		let rowStatus: string | null = null;

		mockDb.$transaction.mockImplementation(async (fn: any) => {
			const tx = {
				pendingPmStateChange: {
					findMany: vi.fn().mockResolvedValue(changes),
					update: vi.fn().mockImplementation((args: any) => {
						rowStatus = args.data.status;
						return Promise.resolve({
							id: args.where.id,
							status: args.data.status,
						});
					}),
				},
				epic: { update: vi.fn() },
				feature: { update: vi.fn() },
				userStory: {
					findUnique: vi.fn().mockResolvedValue({
						id: "s-hidden",
						version: 3,
						description: "hidden story",
						acceptanceCriteria: null,
						draftingStage: "CLOSED",
						pmAutoHidden: true,
					}),
					update: vi.fn().mockImplementation((args: any) => {
						storyUpdateData = args.data;
						return Promise.resolve({});
					}),
				},
				featureVersion: {
					upsert: vi.fn().mockImplementation(() => {
						featureVersionUpserted = true;
						return Promise.resolve({});
					}),
				},
			};
			return fn(tx);
		});

		const result = (await handlers.bulk({
			input: {
				projectId: "proj-1",
				organizationId: null,
				ids: ["ch-unhide-bulk"],
				decision: "APPROVED",
			},
			context: mockContext,
		})) as any;

		expect(result.reviewed).toBe(1);
		expect(featureVersionUpserted).toBe(true);
		expect(storyUpdateData).toMatchObject({
			draftingStage: "DRAFT",
			pmAutoHidden: false,
			pmTicketTerminal: false,
			pmTicketTerminalStatus: null,
		});
		expect(rowStatus).toBe("APPROVED");
	});

	it("Task 8: bulk DISMISSED + UNHIDE does NOT update story", async () => {
		const changes = [
			{
				id: "ch-unhide-dismiss",
				projectId: "proj-1",
				entityType: "STORY",
				entityId: "s-hidden-2",
				status: "PENDING",
				proposedAction: "UNHIDE",
			},
		];

		let storyUpdateCalled = false;

		mockDb.$transaction.mockImplementation(async (fn: any) => {
			const tx = {
				pendingPmStateChange: {
					findMany: vi.fn().mockResolvedValue(changes),
					update: vi.fn().mockResolvedValue({}),
				},
				epic: { update: vi.fn() },
				feature: { update: vi.fn() },
				userStory: {
					findUnique: vi.fn(),
					update: vi.fn().mockImplementation(() => {
						storyUpdateCalled = true;
						return Promise.resolve({});
					}),
				},
				featureVersion: { upsert: vi.fn() },
			};
			return fn(tx);
		});

		const result = (await handlers.bulk({
			input: {
				projectId: "proj-1",
				organizationId: null,
				ids: ["ch-unhide-dismiss"],
				decision: "DISMISSED",
			},
			context: mockContext,
		})) as any;

		expect(result.reviewed).toBe(1);
		expect(storyUpdateCalled).toBe(false);
	});

	it("Bug fix: bulk APPROVED + UNHIDE where story is missing (applied:false) → row DISMISSED, not APPROVED", async () => {
		const changes = [
			{
				id: "ch-unhide-missing-bulk",
				projectId: "proj-1",
				entityType: "STORY",
				entityId: "story-gone",
				status: "PENDING",
				proposedAction: "UNHIDE",
			},
		];

		let rowStatus: string | null = null;
		let storyUpdateCalled = false;

		mockDb.$transaction.mockImplementation(async (fn: any) => {
			const tx = {
				pendingPmStateChange: {
					findMany: vi.fn().mockResolvedValue(changes),
					update: vi.fn().mockImplementation((args: any) => {
						rowStatus = args.data.status;
						return Promise.resolve({
							id: args.where.id,
							status: args.data.status,
						});
					}),
				},
				epic: { update: vi.fn() },
				feature: { update: vi.fn() },
				userStory: {
					findUnique: vi.fn().mockResolvedValue(null), // story not found
					update: vi.fn().mockImplementation(() => {
						storyUpdateCalled = true;
						return Promise.resolve({});
					}),
				},
				featureVersion: { upsert: vi.fn() },
			};
			return fn(tx);
		});

		const result = (await handlers.bulk({
			input: {
				projectId: "proj-1",
				organizationId: null,
				ids: ["ch-unhide-missing-bulk"],
				decision: "APPROVED",
			},
			context: mockContext,
		})) as any;

		expect(result.reviewed).toBe(1);
		expect(storyUpdateCalled).toBe(false);
		expect(rowStatus).toBe("DISMISSED");
	});

	it("Bug fix: bulk APPROVED + UNHIDE where story already unhidden (pmAutoHidden:false) → row DISMISSED", async () => {
		const changes = [
			{
				id: "ch-unhide-noop-bulk",
				projectId: "proj-1",
				entityType: "STORY",
				entityId: "s-already-open",
				status: "PENDING",
				proposedAction: "UNHIDE",
			},
		];

		let rowStatus: string | null = null;
		let storyUpdateCalled = false;

		mockDb.$transaction.mockImplementation(async (fn: any) => {
			const tx = {
				pendingPmStateChange: {
					findMany: vi.fn().mockResolvedValue(changes),
					update: vi.fn().mockImplementation((args: any) => {
						rowStatus = args.data.status;
						return Promise.resolve({
							id: args.where.id,
							status: args.data.status,
						});
					}),
				},
				epic: { update: vi.fn() },
				feature: { update: vi.fn() },
				userStory: {
					findUnique: vi.fn().mockResolvedValue({
						id: "s-already-open",
						version: 4,
						description: "desc",
						acceptanceCriteria: null,
						draftingStage: "DRAFT", // already open — not CLOSED
						pmAutoHidden: true,
					}),
					update: vi.fn().mockImplementation(() => {
						storyUpdateCalled = true;
						return Promise.resolve({});
					}),
				},
				featureVersion: { upsert: vi.fn() },
			};
			return fn(tx);
		});

		const result = (await handlers.bulk({
			input: {
				projectId: "proj-1",
				organizationId: null,
				ids: ["ch-unhide-noop-bulk"],
				decision: "APPROVED",
			},
			context: mockContext,
		})) as any;

		expect(result.reviewed).toBe(1);
		expect(storyUpdateCalled).toBe(false);
		expect(rowStatus).toBe("DISMISSED");
	});

	it("Bug fix: bulk APPROVED + UNHIDE EPIC missing (applied:false) → row DISMISSED, no epic write", async () => {
		// Task 6 (#1360): UNHIDE now generalizes to epic/feature. A row for an epic
		// that no longer exists is not eligible → applyUnhide returns {applied:false}
		// → DISMISSED with no epic.update.
		const changes = [
			{
				id: "ch-unhide-epic-bulk",
				projectId: "proj-1",
				entityType: "EPIC",
				entityId: "epic-gone",
				status: "PENDING",
				proposedAction: "UNHIDE",
			},
		];

		let rowStatus: string | null = null;
		let epicUpdateCalled = false;

		mockDb.$transaction.mockImplementation(async (fn: any) => {
			const tx = {
				pendingPmStateChange: {
					findMany: vi.fn().mockResolvedValue(changes),
					update: vi.fn().mockImplementation((args: any) => {
						rowStatus = args.data.status;
						return Promise.resolve({
							id: args.where.id,
							status: args.data.status,
						});
					}),
				},
				epic: {
					findUnique: vi.fn().mockResolvedValue(null), // epic gone
					update: vi.fn().mockImplementation(() => {
						epicUpdateCalled = true;
						return Promise.resolve({});
					}),
				},
				feature: { findUnique: vi.fn(), update: vi.fn() },
				userStory: {
					findUnique: vi.fn(),
					update: vi.fn(),
				},
				featureVersion: { upsert: vi.fn() },
			};
			return fn(tx);
		});

		const result = (await handlers.bulk({
			input: {
				projectId: "proj-1",
				organizationId: null,
				ids: ["ch-unhide-epic-bulk"],
				decision: "APPROVED",
			},
			context: mockContext,
		})) as any;

		expect(result.reviewed).toBe(1);
		expect(epicUpdateCalled).toBe(false);
		expect(rowStatus).toBe("DISMISSED");
	});

	describe("bulk review FLAG_MISSING (#1360)", () => {
		// The bulk FLAG_MISSING Accept now atomically consumes each PENDING row
		// (tx.pendingPmStateChange.updateMany → APPROVED, count 1) before unlinking
		// via the shared applyPmUnlinkTx. A consume that matches 0 (auto-dismissed /
		// refreshed / already done) is skipped via `continue` — no unlink, no audit,
		// no status overwrite. consume 1 + unlink not applied → DISMISSED, no audit.
		it("consumes + unlinks each matched STORY row; a consume-miss row is skipped", async () => {
			const changes = [
				{
					id: "fm-1",
					projectId: "proj-1",
					entityType: "STORY",
					entityId: "s1",
					externalId: "123",
					expectedExternalMcpServerId: "srv-1",
					status: "PENDING",
					proposedAction: "FLAG_MISSING",
				},
				{
					id: "fm-2",
					projectId: "proj-1",
					entityType: "STORY",
					entityId: "s2",
					externalId: "456",
					expectedExternalMcpServerId: "srv-1",
					status: "PENDING",
					proposedAction: "FLAG_MISSING",
				},
			];

			const rowStatuses: Record<string, string> = {};
			let txConsume: any;
			let txUpdate: any;

			mockDb.$transaction.mockImplementation(async (fn: any) => {
				// fm-1 consume matches (count 1), fm-2 consume misses (count 0).
				txConsume = vi
					.fn()
					.mockResolvedValueOnce({ count: 1 })
					.mockResolvedValueOnce({ count: 0 });
				txUpdate = vi.fn().mockImplementation((args: any) => {
					rowStatuses[args.where.id] = args.data.status;
					return Promise.resolve({
						id: args.where.id,
						status: args.data.status,
					});
				});
				const tx = {
					pendingPmStateChange: {
						findMany: vi.fn().mockResolvedValue(changes),
						updateMany: txConsume,
						update: txUpdate,
					},
					epic: { update: vi.fn() },
					feature: { update: vi.fn() },
					userStory: { findUnique: vi.fn(), update: vi.fn() },
					pmTicketMissingStreak: { deleteMany: vi.fn() },
					featureVersion: { upsert: vi.fn() },
				};
				return fn(tx);
			});
			mockApplyPmUnlinkTx.mockResolvedValue({ applied: true });

			const result = (await handlers.bulk({
				input: {
					projectId: "proj-1",
					organizationId: null,
					ids: ["fm-1", "fm-2"],
					decision: "APPROVED",
				},
				context: mockContext,
			})) as any;

			expect(result.reviewed).toBe(2);
			// fm-1: consume matched (snapshot CAS) → APPROVED, then unlink via the
			// shared applyPmUnlinkTx → audit.
			expect(txConsume).toHaveBeenCalledWith({
				where: {
					id: "fm-1",
					status: "PENDING",
					proposedAction: "FLAG_MISSING",
					externalId: "123",
					expectedExternalMcpServerId: "srv-1",
				},
				data: expect.objectContaining({ status: "APPROVED" }),
			});
			expect(mockApplyPmUnlinkTx).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					entityType: "STORY",
					entityId: "s1",
					expectedExternalId: "123",
					expectedExternalMcpServerId: "srv-1",
					projectId: "proj-1",
				}),
			);
			// fm-2: consume missed (count 0) → skipped (no overwrite to DISMISSED).
			expect(rowStatuses["fm-2"]).toBeUndefined();
			// audit recorded only for the applied row
			expect(mockRecordAuditTx).toHaveBeenCalledTimes(1);
			expect(mockRecordAuditTx).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					action: "story.pm_ticket_unlinked",
					// resource.type carries the true entity type (lowercased); for a
					// STORY row this stays "story", unchanged from the original shape.
					resource: { type: "story", id: "s1" },
					metadata: { externalId: "123", entityType: "STORY" },
				}),
			);
		});

		it("dismisses (no audit) a consumed row whose story was retooled to a different server (Fix B)", async () => {
			const changes = [
				{
					id: "fm-retool",
					projectId: "proj-1",
					entityType: "STORY",
					entityId: "s1",
					externalId: "123",
					expectedExternalMcpServerId: "srv-OLD",
					status: "PENDING",
					proposedAction: "FLAG_MISSING",
				},
			];

			const rowStatuses: Record<string, string> = {};

			mockDb.$transaction.mockImplementation(async (fn: any) => {
				const tx = {
					pendingPmStateChange: {
						findMany: vi.fn().mockResolvedValue(changes),
						// Consume matches the OLD snapshot (row still pending on srv-OLD).
						updateMany: vi.fn().mockResolvedValue({ count: 1 }),
						update: vi.fn().mockImplementation((args: any) => {
							rowStatuses[args.where.id] = args.data.status;
							return Promise.resolve({
								id: args.where.id,
								status: args.data.status,
							});
						}),
					},
					epic: { update: vi.fn() },
					feature: { update: vi.fn() },
					userStory: { findUnique: vi.fn(), update: vi.fn() },
					pmTicketMissingStreak: { deleteMany: vi.fn() },
					featureVersion: { upsert: vi.fn() },
				};
				return fn(tx);
			});
			// The story now lives on srv-NEW, so applyPmUnlinkTx's server-scoped
			// where misses → {applied:false} → DISMISSED.
			mockApplyPmUnlinkTx.mockResolvedValue({ applied: false });

			const result = (await handlers.bulk({
				input: {
					projectId: "proj-1",
					organizationId: null,
					ids: ["fm-retool"],
					decision: "APPROVED",
				},
				context: mockContext,
			})) as any;

			expect(result.reviewed).toBe(1);
			// The OLD server is carried into the unlink guard.
			expect(mockApplyPmUnlinkTx).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					expectedExternalMcpServerId: "srv-OLD",
				}),
			);
			// applied:false → no audit, DISMISSED (new link intact).
			expect(mockRecordAuditTx).not.toHaveBeenCalled();
			expect(rowStatuses["fm-retool"]).toBe("DISMISSED");
		});

		it("skips (no audit) a stale EPIC FLAG_MISSING row whose consume misses (count 0)", async () => {
			// Task 6 (#1360): a stale row whose snapshot CAS no longer matches yields
			// consume count 0 → skipped via `continue`, no unlink, no audit, no
			// status overwrite.
			const changes = [
				{
					id: "fm-epic",
					projectId: "proj-1",
					entityType: "EPIC",
					entityId: "e1",
					externalId: "123",
					expectedExternalMcpServerId: "srv-1",
					status: "PENDING",
					proposedAction: "FLAG_MISSING",
				},
			];

			let rowStatus: string | null = null;

			mockDb.$transaction.mockImplementation(async (fn: any) => {
				const tx = {
					pendingPmStateChange: {
						findMany: vi.fn().mockResolvedValue(changes),
						updateMany: vi.fn().mockResolvedValue({ count: 0 }),
						update: vi.fn().mockImplementation((args: any) => {
							rowStatus = args.data.status;
							return Promise.resolve({
								id: args.where.id,
								status: args.data.status,
							});
						}),
					},
					epic: { update: vi.fn() },
					feature: { update: vi.fn() },
					userStory: { findUnique: vi.fn(), update: vi.fn() },
					pmTicketMissingStreak: { deleteMany: vi.fn() },
					featureVersion: { upsert: vi.fn() },
				};
				return fn(tx);
			});

			const result = (await handlers.bulk({
				input: {
					projectId: "proj-1",
					organizationId: null,
					ids: ["fm-epic"],
					decision: "APPROVED",
				},
				context: mockContext,
			})) as any;

			expect(result.reviewed).toBe(1);
			// consume missed → unlink never runs, no audit, row not overwritten.
			expect(mockApplyPmUnlinkTx).not.toHaveBeenCalled();
			expect(mockRecordAuditTx).not.toHaveBeenCalled();
			expect(rowStatus).toBeNull();
		});

		it("DISMISSED decision does not consume or unlink a FLAG_MISSING row", async () => {
			const changes = [
				{
					id: "fm-dismiss",
					projectId: "proj-1",
					entityType: "STORY",
					entityId: "s1",
					externalId: "123",
					status: "PENDING",
					proposedAction: "FLAG_MISSING",
				},
			];

			let rowStatus: string | null = null;
			let txConsume: any;

			mockDb.$transaction.mockImplementation(async (fn: any) => {
				txConsume = vi.fn();
				const tx = {
					pendingPmStateChange: {
						findMany: vi.fn().mockResolvedValue(changes),
						updateMany: txConsume,
						update: vi.fn().mockImplementation((args: any) => {
							rowStatus = args.data.status;
							return Promise.resolve({
								id: args.where.id,
								status: args.data.status,
							});
						}),
					},
					epic: { update: vi.fn() },
					feature: { update: vi.fn() },
					userStory: { findUnique: vi.fn(), update: vi.fn() },
					pmTicketMissingStreak: { deleteMany: vi.fn() },
					featureVersion: { upsert: vi.fn() },
				};
				return fn(tx);
			});

			const result = (await handlers.bulk({
				input: {
					projectId: "proj-1",
					organizationId: null,
					ids: ["fm-dismiss"],
					decision: "DISMISSED",
				},
				context: mockContext,
			})) as any;

			expect(result.reviewed).toBe(1);
			expect(txConsume).not.toHaveBeenCalled();
			expect(mockApplyPmUnlinkTx).not.toHaveBeenCalled();
			expect(mockRecordAuditTx).not.toHaveBeenCalled();
			expect(rowStatus).toBe("DISMISSED");
		});
	});

	describe("bulk epic/feature terminal status (#1360 Task 6)", () => {
		it("APPROVED legacy EPIC HIDE row no-ops the apply but records the decision (folder tables removed)", async () => {
			const changes = [
				{
					id: "ch-epic-hide",
					projectId: "proj-1",
					entityType: "EPIC",
					entityId: "epic-1",
					status: "PENDING",
					proposedAction: "HIDE",
				},
			];

			let epicUpdateCalled = false;
			let rowStatus: string | null = null;

			mockDb.$transaction.mockImplementation(async (fn: any) => {
				const tx = {
					pendingPmStateChange: {
						findMany: vi.fn().mockResolvedValue(changes),
						update: vi.fn().mockImplementation((args: any) => {
							rowStatus = args.data.status;
							return Promise.resolve({
								id: args.where.id,
								status: args.data.status,
							});
						}),
					},
					epic: {
						findUnique: vi.fn(),
						update: vi.fn().mockImplementation(() => {
							epicUpdateCalled = true;
							return Promise.resolve({});
						}),
					},
					feature: { findUnique: vi.fn(), update: vi.fn() },
					userStory: { findUnique: vi.fn(), update: vi.fn() },
					featureVersion: { upsert: vi.fn() },
				};
				return fn(tx);
			});

			await handlers.bulk({
				input: {
					projectId: "proj-1",
					organizationId: null,
					ids: ["ch-epic-hide"],
					decision: "APPROVED",
				},
				context: mockContext,
			});

			// Stories are the only work-item rows — a legacy EPIC HIDE row must
			// not mutate any entity. The apply is a silent no-op (same as the
			// pre-existing story-not-found path) and the row still records the
			// reviewer's decision so it drains out of the PENDING queue.
			expect(epicUpdateCalled).toBe(false);
			expect(rowStatus).toBe("APPROVED");
		});

		it("APPROVED FEATURE FLAG_MISSING (consume 1 + unlink applied) → row APPROVED + audit attributed to FEATURE", async () => {
			const changes = [
				{
					id: "ch-feat-fm",
					projectId: "proj-1",
					entityType: "FEATURE",
					entityId: "feat-1",
					externalId: "789",
					expectedExternalMcpServerId: "srv-1",
					status: "PENDING",
					proposedAction: "FLAG_MISSING",
				},
			];

			let rowStatus: string | null = null;
			let txConsume: any;

			mockDb.$transaction.mockImplementation(async (fn: any) => {
				txConsume = vi.fn().mockResolvedValue({ count: 1 });
				const tx = {
					pendingPmStateChange: {
						findMany: vi.fn().mockResolvedValue(changes),
						updateMany: txConsume,
						update: vi.fn().mockImplementation((args: any) => {
							rowStatus = args.data.status;
							return Promise.resolve({
								id: args.where.id,
								status: args.data.status,
							});
						}),
					},
					epic: { updateMany: vi.fn() },
					feature: {
						findUnique: vi.fn(),
						update: vi.fn(),
						updateMany: vi.fn(),
					},
					userStory: {
						findUnique: vi.fn(),
						update: vi.fn(),
						updateMany: vi.fn(),
					},
					pmTicketMissingStreak: { deleteMany: vi.fn() },
					featureVersion: { upsert: vi.fn() },
				};
				return fn(tx);
			});
			mockApplyPmUnlinkTx.mockResolvedValue({ applied: true });

			const result = (await handlers.bulk({
				input: {
					projectId: "proj-1",
					organizationId: null,
					ids: ["ch-feat-fm"],
					decision: "APPROVED",
				},
				context: mockContext,
			})) as any;

			expect(result.reviewed).toBe(1);
			// consume the PENDING row on the snapshot, then unlink via the shared tx
			// form with the true entityType.
			expect(txConsume).toHaveBeenCalledWith({
				where: {
					id: "ch-feat-fm",
					status: "PENDING",
					proposedAction: "FLAG_MISSING",
					externalId: "789",
					expectedExternalMcpServerId: "srv-1",
				},
				data: expect.objectContaining({ status: "APPROVED" }),
			});
			expect(mockApplyPmUnlinkTx).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					entityType: "FEATURE",
					entityId: "feat-1",
					expectedExternalId: "789",
					expectedExternalMcpServerId: "srv-1",
					projectId: "proj-1",
				}),
			);
			// consume already set APPROVED; the generic trailing update is skipped.
			expect(rowStatus).toBeNull();
			// Audit attribution (#1360): the unlink is logged against the TRUE
			// entity type — resource.type "feature" (not the hardcoded "story") and
			// metadata.entityType "FEATURE".
			expect(mockRecordAuditTx).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					action: "story.pm_ticket_unlinked",
					resource: { type: "feature", id: "feat-1" },
					metadata: { externalId: "789", entityType: "FEATURE" },
				}),
			);
		});

		it("Regression: APPROVED EPIC UNHIDE when epic not CLOSED → {applied:false} → row DISMISSED", async () => {
			const changes = [
				{
					id: "ch-epic-unhide-noop",
					projectId: "proj-1",
					entityType: "EPIC",
					entityId: "epic-open",
					status: "PENDING",
					proposedAction: "UNHIDE",
				},
			];

			let rowStatus: string | null = null;
			let epicUpdateCalled = false;

			mockDb.$transaction.mockImplementation(async (fn: any) => {
				const tx = {
					pendingPmStateChange: {
						findMany: vi.fn().mockResolvedValue(changes),
						update: vi.fn().mockImplementation((args: any) => {
							rowStatus = args.data.status;
							return Promise.resolve({
								id: args.where.id,
								status: args.data.status,
							});
						}),
					},
					epic: {
						findUnique: vi.fn().mockResolvedValue({
							id: "epic-open",
							draftingStage: "PUBLISHED", // not CLOSED → not eligible
							pmAutoHidden: true,
						}),
						update: vi.fn().mockImplementation(() => {
							epicUpdateCalled = true;
							return Promise.resolve({});
						}),
					},
					feature: { findUnique: vi.fn(), update: vi.fn() },
					userStory: { findUnique: vi.fn(), update: vi.fn() },
					featureVersion: { upsert: vi.fn() },
				};
				return fn(tx);
			});

			const result = (await handlers.bulk({
				input: {
					projectId: "proj-1",
					organizationId: null,
					ids: ["ch-epic-unhide-noop"],
					decision: "APPROVED",
				},
				context: mockContext,
			})) as any;

			expect(result.reviewed).toBe(1);
			expect(epicUpdateCalled).toBe(false);
			expect(rowStatus).toBe("DISMISSED");
		});
	});
});

describe("bulk FLAG_MISSING atomic consume", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	function setupBulkTx(changes: any[]) {
		const txCalls = {
			updateMany: vi.fn(),
			update: vi.fn(),
			findMany: vi.fn().mockResolvedValue(changes),
		};
		mockDb.$transaction.mockImplementation(async (fn: any) =>
			fn({ pendingPmStateChange: txCalls }),
		);
		return txCalls;
	}

	it("consumes each PENDING FLAG_MISSING then unlinks (count 1)", async () => {
		const tx = setupBulkTx([
			{
				id: "r1",
				projectId: "p1",
				status: "PENDING",
				proposedAction: "FLAG_MISSING",
				entityType: "STORY",
				entityId: "s1",
				externalId: "123",
				expectedExternalMcpServerId: "srv-1",
			},
		]);
		tx.updateMany.mockResolvedValue({ count: 1 });
		mockApplyPmUnlinkTx.mockResolvedValue({ applied: true });

		await handlers.bulk({
			input: { projectId: "p1", ids: ["r1"], decision: "APPROVED" },
			context: { user: { id: "u1" }, session: {} },
		});

		expect(tx.updateMany).toHaveBeenCalledWith({
			where: {
				id: "r1",
				status: "PENDING",
				proposedAction: "FLAG_MISSING",
				externalId: "123",
				expectedExternalMcpServerId: "srv-1",
			},
			data: expect.objectContaining({ status: "APPROVED" }),
		});
		expect(mockApplyPmUnlinkTx).toHaveBeenCalled();
		expect(mockRecordAuditTx).toHaveBeenCalled();
	});

	it("RACE: a row auto-dismissed before consume (count 0) is skipped — no unlink, no audit", async () => {
		const tx = setupBulkTx([
			{
				id: "r1",
				projectId: "p1",
				status: "PENDING",
				proposedAction: "FLAG_MISSING",
				entityType: "STORY",
				entityId: "s1",
				externalId: "123",
				expectedExternalMcpServerId: "srv-1",
			},
		]);
		tx.updateMany.mockResolvedValue({ count: 0 });

		await handlers.bulk({
			input: { projectId: "p1", ids: ["r1"], decision: "APPROVED" },
			context: { user: { id: "u1" }, session: {} },
		});

		expect(mockApplyPmUnlinkTx).not.toHaveBeenCalled();
		expect(mockRecordAuditTx).not.toHaveBeenCalled();
		expect(tx.update).not.toHaveBeenCalled(); // not overwritten
	});
});
