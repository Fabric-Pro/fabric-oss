/**
 * Unit tests for the resolveConflict handler.
 *
 * Tests the pure handler function (not the full oRPC procedure) so we can
 * inject mocks for the `@repo/database` dispatch helpers and the enqueue
 * helper. The handler is the source of truth for the REMOTE/LOCAL dispatch
 * logic, generalized over `epic | feature | story | bug`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ────────────────────────────────────────────────────────────────────────────
// Module-level mocks — hoisted before any import.
// Use importOriginal so we preserve all other @repo/database exports that
// transitive dependencies (e.g. @repo/ai) need at module load time, while
// stubbing the conflict-resolution dispatch helpers at their boundary.
// ────────────────────────────────────────────────────────────────────────────

const clearPmSyncConflictFlagMock = vi.fn().mockResolvedValue(undefined);
const writePmSyncItemContentMock = vi.fn().mockResolvedValue(undefined);
const getPmSyncItemStateMock = vi.fn();

vi.mock("@repo/database", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@repo/database")>();
	return {
		...actual,
		getPmSyncItemState: getPmSyncItemStateMock,
		clearPmSyncConflictFlag: clearPmSyncConflictFlagMock,
		writePmSyncItemContent: writePmSyncItemContentMock,
	};
});

const enqueueMock = vi.fn().mockResolvedValue({ enqueued: true });

vi.mock(
	"../../../../packages/api/modules/projects/lib/enqueue-pm-sync",
	() => ({
		enqueuePmSync: enqueueMock,
	}),
);

// Capture the procedure's `.handler(fn)` so the guard logic (NOT_FOUND /
// BAD_REQUEST / per-itemType read) can be exercised without a full oRPC
// context. Mirrors the binding stub in `pm-sync-procedures.test.ts`.
const procedureHandlers: { resolveConflict?: (a: unknown) => unknown } = {};

vi.mock("../../../../packages/api/orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (a: unknown) => unknown) => {
			procedureHandlers.resolveConflict = fn;
			return { _handler: fn };
		},
	});
	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: () => (c: unknown) => c,
		resolveOrganizationId: (organizationId: string | null) =>
			organizationId,
	};
});

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

type ItemType = "epic" | "feature" | "story" | "bug";

describe("resolveConflict", () => {
	const importFromPmMock = vi.fn().mockResolvedValue({ itemId: "item_1" });

	beforeEach(() => {
		enqueueMock.mockClear();
		importFromPmMock.mockClear();
		clearPmSyncConflictFlagMock.mockClear();
		writePmSyncItemContentMock.mockClear();
		getPmSyncItemStateMock.mockReset();
	});

	afterEach(() => {
		vi.resetModules();
	});

	it("REMOTE resolution imports from PM and clears CONFLICT (no push)", async () => {
		const { resolveConflictHandler } = await import(
			"../../../../packages/api/modules/projects/procedures/stories/sync/resolve-conflict"
		);
		const result = await resolveConflictHandler({
			itemId: "story_1",
			itemType: "story",
			projectId: "proj_1",
			userId: "user_1",
			resolution: "REMOTE",
			importFromPm: importFromPmMock,
		});
		expect(importFromPmMock).toHaveBeenCalledTimes(1);
		expect(enqueueMock).not.toHaveBeenCalled();
		expect(clearPmSyncConflictFlagMock).toHaveBeenCalledWith({
			itemType: "story",
			itemId: "story_1",
		});
		expect(writePmSyncItemContentMock).not.toHaveBeenCalled();
		expect(result.cleared).toBe(true);
		// Success path must carry no pmError (locks the contract).
		expect(result.pmError).toBeUndefined();
	}, 30000);

	it("LOCAL resolution enqueues push with forceHashOverride and clears flag", async () => {
		const { resolveConflictHandler } = await import(
			"../../../../packages/api/modules/projects/procedures/stories/sync/resolve-conflict"
		);
		const result = await resolveConflictHandler({
			itemId: "story_1",
			itemType: "story",
			projectId: "proj_1",
			userId: "user_1",
			resolution: "LOCAL",
			importFromPm: importFromPmMock,
		});
		expect(enqueueMock).toHaveBeenCalledWith(
			expect.objectContaining({
				itemId: "story_1",
				itemType: "story",
				projectId: "proj_1",
				userId: "user_1",
				forceHashOverride: true,
				triggerSource: "retry",
			}),
		);
		expect(importFromPmMock).not.toHaveBeenCalled();
		// Plain "Use Fabric" — no merged description written.
		expect(writePmSyncItemContentMock).not.toHaveBeenCalled();
		expect(clearPmSyncConflictFlagMock).toHaveBeenCalledWith({
			itemType: "story",
			itemId: "story_1",
		});
		expect(result.cleared).toBe(true);
		expect(result.pmError).toBeUndefined();
	});

	it("LOCAL that can't enqueue (no PM config) surfaces pmError and does NOT clear the flag", async () => {
		const { resolveConflictHandler } = await import(
			"../../../../packages/api/modules/projects/procedures/stories/sync/resolve-conflict"
		);
		// The caller has no usable PM connection — enqueue declines the push.
		enqueueMock.mockResolvedValueOnce({
			enqueued: false,
			reason: "no-pm-config",
		});

		const result = await resolveConflictHandler({
			itemId: "story_1",
			itemType: "story",
			projectId: "proj_1",
			userId: "user_1",
			resolution: "LOCAL",
		});

		expect(enqueueMock).toHaveBeenCalledTimes(1);
		// The conflict flag MUST stay set — nothing synced, so the conflict is
		// still unresolved. Clearing it would be a silent false success.
		expect(clearPmSyncConflictFlagMock).not.toHaveBeenCalled();
		expect(result.cleared).toBe(false);
		expect(result.pmError).toEqual({ kind: "MISSING" });
	});

	it.each<ItemType>(["epic", "feature", "story", "bug"])(
		"LOCAL dispatches the correct itemType=%s to the force-push",
		async (itemType) => {
			const { resolveConflictHandler } = await import(
				"../../../../packages/api/modules/projects/procedures/stories/sync/resolve-conflict"
			);
			await resolveConflictHandler({
				itemId: `${itemType}_1`,
				itemType,
				projectId: "proj_1",
				userId: "user_1",
				resolution: "LOCAL",
			});
			expect(enqueueMock).toHaveBeenCalledWith(
				expect.objectContaining({
					itemId: `${itemType}_1`,
					itemType,
					forceHashOverride: true,
				}),
			);
			expect(clearPmSyncConflictFlagMock).toHaveBeenCalledWith({
				itemType,
				itemId: `${itemType}_1`,
			});
		},
	);

	it.each<ItemType>(["epic", "feature", "story", "bug"])(
		"REMOTE dispatches the correct itemType=%s to clear the flag (no push)",
		async (itemType) => {
			const { resolveConflictHandler } = await import(
				"../../../../packages/api/modules/projects/procedures/stories/sync/resolve-conflict"
			);
			await resolveConflictHandler({
				itemId: `${itemType}_1`,
				itemType,
				projectId: "proj_1",
				userId: "user_1",
				resolution: "REMOTE",
			});
			expect(enqueueMock).not.toHaveBeenCalled();
			expect(clearPmSyncConflictFlagMock).toHaveBeenCalledWith({
				itemType,
				itemId: `${itemType}_1`,
			});
		},
	);

	it("LOCAL + override writes the merged title + description before enqueue", async () => {
		const { resolveConflictHandler } = await import(
			"../../../../packages/api/modules/projects/procedures/stories/sync/resolve-conflict"
		);
		const order: string[] = [];
		writePmSyncItemContentMock.mockImplementation(async () => {
			order.push("write");
		});
		enqueueMock.mockImplementation(async () => {
			order.push("enqueue");
			return { enqueued: true };
		});

		const result = await resolveConflictHandler({
			itemId: "feature_1",
			itemType: "feature",
			projectId: "proj_1",
			userId: "user_1",
			resolution: "LOCAL",
			overrideTitle: "Merged title",
			overrideDescription: "Merged description body",
		});

		expect(writePmSyncItemContentMock).toHaveBeenCalledWith({
			itemType: "feature",
			itemId: "feature_1",
			projectId: "proj_1",
			title: "Merged title",
			description: "Merged description body",
			// Conflict-resolve attribution is threaded to the write helper (which
			// applies it only to story/bug — feature ignores it).
			lastEditedSource: "CONFLICT_RESOLUTION",
			lastEditedByName: null,
		});
		// Write happens BEFORE the force-push so the merged content is what
		// gets pushed.
		expect(order).toEqual(["write", "enqueue"]);
		expect(enqueueMock).toHaveBeenCalledWith(
			expect.objectContaining({
				itemId: "feature_1",
				itemType: "feature",
				forceHashOverride: true,
			}),
		);
		expect(result.cleared).toBe(true);
	});

	// The requirement named this path: resolving a conflict is an edit, and it
	// belongs to the person who resolved it. Staging could not prove this —
	// no feature there is in a conflicted state — so it is pinned here.
	it("credits the resolving user by name, and two resolvers are told apart", async () => {
		const { resolveConflictHandler } = await import(
			"../../../../packages/api/modules/projects/procedures/stories/sync/resolve-conflict"
		);

		await resolveConflictHandler({
			itemId: "feature_1",
			itemType: "feature",
			projectId: "proj_1",
			userId: "user_1",
			userName: "Grace Hopper",
			resolution: "LOCAL",
			overrideTitle: "Merged by Grace",
			overrideDescription: "body",
		});
		expect(writePmSyncItemContentMock).toHaveBeenLastCalledWith(
			expect.objectContaining({
				lastEditedSource: "CONFLICT_RESOLUTION",
				lastEditedByName: "Grace Hopper",
			}),
		);

		// A different human resolving must not inherit the previous name.
		await resolveConflictHandler({
			itemId: "feature_1",
			itemType: "feature",
			projectId: "proj_1",
			userId: "user_2",
			userName: "Ada Lovelace",
			resolution: "LOCAL",
			overrideTitle: "Merged by Ada",
			overrideDescription: "body",
		});
		expect(writePmSyncItemContentMock).toHaveBeenLastCalledWith(
			expect.objectContaining({
				lastEditedSource: "CONFLICT_RESOLUTION",
				lastEditedByName: "Ada Lovelace",
			}),
		);
	});

	it("LOCAL + empty-string overrideDescription still writes (clears the description)", async () => {
		const { resolveConflictHandler } = await import(
			"../../../../packages/api/modules/projects/procedures/stories/sync/resolve-conflict"
		);
		await resolveConflictHandler({
			itemId: "epic_1",
			itemType: "epic",
			projectId: "proj_1",
			userId: "user_1",
			resolution: "LOCAL",
			overrideDescription: "",
		});
		expect(writePmSyncItemContentMock).toHaveBeenCalledWith({
			itemType: "epic",
			itemId: "epic_1",
			projectId: "proj_1",
			title: undefined,
			description: "",
			lastEditedSource: "CONFLICT_RESOLUTION",
			lastEditedByName: null,
		});
	});
});

describe("resolveConflict procedure guards", () => {
	const ctx = { user: { id: "user_1" }, session: {} };

	beforeEach(() => {
		enqueueMock.mockClear();
		clearPmSyncConflictFlagMock.mockClear();
		writePmSyncItemContentMock.mockClear();
		getPmSyncItemStateMock.mockReset();
	});

	afterEach(() => {
		vi.resetModules();
	});

	async function loadProcedure() {
		await import(
			"../../../../packages/api/modules/projects/procedures/stories/sync/resolve-conflict"
		);
		const handler = procedureHandlers.resolveConflict;
		if (!handler) {
			throw new Error("resolveConflict handler was not captured");
		}
		return handler;
	}

	it("reads the right model per itemType and resolves an Epic (closes D2a)", async () => {
		const handler = await loadProcedure();
		getPmSyncItemStateMock.mockResolvedValue({
			id: "epic_1",
			lastPmSyncStatus: "CONFLICT",
		});

		const result = await handler({
			input: {
				projectId: "proj_1",
				itemId: "epic_1",
				itemType: "epic",
				resolution: "LOCAL",
			},
			context: ctx,
		});

		expect(getPmSyncItemStateMock).toHaveBeenCalledWith({
			itemType: "epic",
			itemId: "epic_1",
			projectId: "proj_1",
		});
		expect(enqueueMock).toHaveBeenCalledWith(
			expect.objectContaining({ itemType: "epic", itemId: "epic_1" }),
		);
		expect(result).toEqual({ cleared: true });
	});

	it("resolves a Feature where the old story-only handler returned NOT_FOUND", async () => {
		const handler = await loadProcedure();
		getPmSyncItemStateMock.mockResolvedValue({
			id: "feature_1",
			lastPmSyncStatus: "CONFLICT",
		});

		const result = await handler({
			input: {
				projectId: "proj_1",
				itemId: "feature_1",
				itemType: "feature",
				resolution: "REMOTE",
			},
			context: ctx,
		});

		expect(getPmSyncItemStateMock).toHaveBeenCalledWith({
			itemType: "feature",
			itemId: "feature_1",
			projectId: "proj_1",
		});
		expect(clearPmSyncConflictFlagMock).toHaveBeenCalledWith({
			itemType: "feature",
			itemId: "feature_1",
		});
		expect(result).toEqual({ cleared: true });
	});

	it("throws NOT_FOUND when the item is not in the project", async () => {
		const handler = await loadProcedure();
		getPmSyncItemStateMock.mockResolvedValue(null);

		await expect(
			handler({
				input: {
					projectId: "proj_1",
					itemId: "epic_404",
					itemType: "epic",
					resolution: "LOCAL",
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(enqueueMock).not.toHaveBeenCalled();
	});

	it("throws BAD_REQUEST when the item is not in CONFLICT state", async () => {
		const handler = await loadProcedure();
		getPmSyncItemStateMock.mockResolvedValue({
			id: "story_1",
			lastPmSyncStatus: "SUCCESS",
		});

		await expect(
			handler({
				input: {
					projectId: "proj_1",
					itemId: "story_1",
					itemType: "story",
					resolution: "LOCAL",
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(enqueueMock).not.toHaveBeenCalled();
	});
});
