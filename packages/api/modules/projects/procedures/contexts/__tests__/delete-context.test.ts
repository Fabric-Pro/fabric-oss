/**
 * Unit tests for `deleteContextProcedure` — URL Context Sources spec §6.6
 * + §7.2 schedule cleanup.
 *
 * Focus: when deleting a LINK row with `urlScheduleId` set, the procedure
 * MUST drop the Temporal Schedule BEFORE starting the context-deletion
 * workflow, but a schedule-delete failure MUST NOT block the rest of the
 * delete path (the reconciliation workflow sweeps drift).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockGetContextById,
	mockHasProjectAccess,
	mockGetTemporalClient,
	mockTemporalStart,
	mockGetScheduleClient,
	mockDeleteUrlSourceSchedule,
	mockEmitContextChange,
	mockEmitActivity,
	mockDeleteSyncedContext,
	mockGetContextRepositorySync,
} = vi.hoisted(() => ({
	mockDeleteSyncedContext: vi.fn(),
	mockGetContextRepositorySync: vi.fn(),
	mockGetContextById: vi.fn(),
	mockHasProjectAccess: vi.fn(),
	mockGetTemporalClient: vi.fn(),
	mockTemporalStart: vi.fn(),
	mockGetScheduleClient: vi.fn(),
	mockDeleteUrlSourceSchedule: vi.fn(),
	mockEmitContextChange: vi.fn(),
	mockEmitActivity: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getContextById: mockGetContextById,
	getContextRepositorySync: mockGetContextRepositorySync,
	hasProjectAccess: mockHasProjectAccess,
}));

// The synced-row delete is its own unit (`delete-synced-file.test.ts`); here
// only the route's choice of it, and what it hands it, are pinned.
vi.mock("../../../lib/delete-synced-context", () => ({
	deleteSyncedContext: mockDeleteSyncedContext,
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: mockGetTemporalClient,
	getScheduleClient: mockGetScheduleClient,
	deleteUrlSourceSchedule: mockDeleteUrlSourceSchedule,
}));

vi.mock("../../../../../lib/realtime", () => ({
	emitContextChange: mockEmitContextChange,
	emitActivity: mockEmitActivity,
}));

vi.mock("../../../../../orpc/procedures", () => {
	const builder: Record<string, unknown> = {};
	builder.use = () => builder;
	builder.route = () => builder;
	builder.input = () => builder;
	builder.handler = (fn: unknown) => ({ handler: fn });
	return {
		tenantProtectedProcedure: builder,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
		requireProjectPermission: () => (c: unknown) => c,
	};
});

type Handler = (args: {
	input: {
		id: string;
		projectId: string;
		organizationId?: string | null;
		expectedDuplicateOfContextId?: string;
		expectedContentHash?: string;
	};
	context: {
		user: { id: string; name?: string; email?: string };
		session: { activeOrganizationId?: string };
	};
}) => Promise<unknown>;

async function loadHandler(): Promise<Handler> {
	const mod = await import("../delete-context");
	return (mod.deleteContextProcedure as unknown as { handler: Handler })
		.handler;
}

const personalCtx = {
	user: { id: "user-1", name: "Test User", email: "test@example.com" },
	session: { activeOrganizationId: undefined },
};

/** The `project` relation `getContextById` loads on every row. */
const personalProject = { organizationId: null };

beforeEach(() => {
	vi.clearAllMocks();
	mockHasProjectAccess.mockResolvedValue(true);
	mockGetTemporalClient.mockResolvedValue({
		workflow: { start: mockTemporalStart },
	});
	mockGetScheduleClient.mockResolvedValue({});
	mockTemporalStart.mockResolvedValue(undefined);
	mockDeleteUrlSourceSchedule.mockResolvedValue({ deleted: true });
	mockEmitContextChange.mockResolvedValue(undefined);
	mockEmitActivity.mockResolvedValue(undefined);
});

describe("deleteContext — URL Source schedule cleanup", () => {
	it("drops the schedule BEFORE starting the deletion workflow for LINK + urlScheduleId", async () => {
		mockGetContextById.mockResolvedValue({
			id: "ctx-link",
			projectId: "proj-1",
			project: personalProject,
			type: "LINK",
			sourceTitle: "Docs",
			urlScheduleId: "url-source-schedule-ctx-link",
		});

		// Track call order: pushing each fn name into a single log.
		const callOrder: string[] = [];
		mockDeleteUrlSourceSchedule.mockImplementation(async () => {
			callOrder.push("deleteSchedule");
			return { deleted: true };
		});
		mockTemporalStart.mockImplementation(async () => {
			callOrder.push("workflowStart");
		});

		const handler = await loadHandler();
		const result = await handler({
			input: { id: "ctx-link", projectId: "proj-1" },
			context: personalCtx,
		});

		expect(result).toEqual({ success: true });
		expect(mockDeleteUrlSourceSchedule).toHaveBeenCalledWith(
			{ scheduleId: "url-source-schedule-ctx-link" },
			expect.anything(),
		);
		expect(callOrder).toEqual(["deleteSchedule", "workflowStart"]);
	});

	it("does NOT call deleteUrlSourceSchedule for LINK rows without urlScheduleId", async () => {
		mockGetContextById.mockResolvedValue({
			id: "ctx-link",
			projectId: "proj-1",
			project: personalProject,
			type: "LINK",
			sourceTitle: "Article",
			urlScheduleId: null,
		});

		const handler = await loadHandler();
		await handler({
			input: { id: "ctx-link", projectId: "proj-1" },
			context: personalCtx,
		});

		expect(mockDeleteUrlSourceSchedule).not.toHaveBeenCalled();
	});

	it("does NOT call deleteUrlSourceSchedule for non-LINK contexts", async () => {
		mockGetContextById.mockResolvedValue({
			id: "ctx-file",
			projectId: "proj-1",
			project: personalProject,
			type: "FILE",
			urlScheduleId: null,
		});

		const handler = await loadHandler();
		await handler({
			input: { id: "ctx-file", projectId: "proj-1" },
			context: personalCtx,
		});

		expect(mockDeleteUrlSourceSchedule).not.toHaveBeenCalled();
	});

	it.each([["PENDING"], ["EXTRACTING"]])(
		"rejects with CONFLICT when a LINK row is mid-crawl (status=%s)",
		async (status) => {
			// Lock-while-crawling guard. Deleting mid-crawl would orphan
			// the in-flight Temporal workflow against a row about to be
			// cascade-deleted. Force the user to cancel first; the
			// dedicated `cancelUrlSourceCrawl` procedure handles
			// orderly teardown.
			mockGetContextById.mockResolvedValue({
				id: "ctx-link",
				projectId: "proj-1",
				project: personalProject,
				type: "LINK",
				sourceTitle: "Docs",
				urlScheduleId: null,
				extractionStatus: status,
			});

			const handler = await loadHandler();
			await expect(
				handler({
					input: { id: "ctx-link", projectId: "proj-1" },
					context: personalCtx,
				}),
			).rejects.toMatchObject({
				code: "CONFLICT",
			});

			// Critically: nothing downstream of the guard runs.
			expect(mockDeleteUrlSourceSchedule).not.toHaveBeenCalled();
			expect(mockTemporalStart).not.toHaveBeenCalled();
			expect(mockEmitContextChange).not.toHaveBeenCalled();
		},
	);

	it.each([["COMPLETED"], ["FAILED"], ["CANCELLED"]])(
		"allows delete when LINK row is in terminal status %s",
		async (status) => {
			// Terminal statuses are safe to delete from. CANCELLED is
			// explicitly terminal — the cancel-crawl flow finalizes
			// to this state precisely so the row becomes deletable
			// again.
			mockGetContextById.mockResolvedValue({
				id: "ctx-link",
				projectId: "proj-1",
				project: personalProject,
				type: "LINK",
				sourceTitle: "Docs",
				urlScheduleId: null,
				extractionStatus: status,
			});

			const handler = await loadHandler();
			const result = await handler({
				input: { id: "ctx-link", projectId: "proj-1" },
				context: personalCtx,
			});
			expect(result).toEqual({ success: true });
			expect(mockTemporalStart).toHaveBeenCalled();
		},
	);

	it("does NOT apply the crawl guard to non-LINK contexts", async () => {
		// FILE / TEXT / MEETING_TRANSCRIPT don't have crawls, so a
		// stale extractionStatus value should never block their delete.
		mockGetContextById.mockResolvedValue({
			id: "ctx-file",
			projectId: "proj-1",
			project: personalProject,
			type: "FILE",
			extractionStatus: "EXTRACTING",
			urlScheduleId: null,
		});

		const handler = await loadHandler();
		const result = await handler({
			input: { id: "ctx-file", projectId: "proj-1" },
			context: personalCtx,
		});
		expect(result).toEqual({ success: true });
		expect(mockTemporalStart).toHaveBeenCalled();
	});

	it("schedule-delete failure does NOT block the DB delete", async () => {
		mockGetContextById.mockResolvedValue({
			id: "ctx-link",
			projectId: "proj-1",
			project: personalProject,
			type: "LINK",
			sourceTitle: "Docs",
			urlScheduleId: "url-source-schedule-ctx-link",
		});
		mockDeleteUrlSourceSchedule.mockRejectedValueOnce(
			new Error("temporal unavailable"),
		);

		const handler = await loadHandler();
		const result = await handler({
			input: { id: "ctx-link", projectId: "proj-1" },
			context: personalCtx,
		});

		expect(result).toEqual({ success: true });
		// The deletion workflow still ran.
		expect(mockTemporalStart).toHaveBeenCalledWith(
			"contextDeletionWorkflow",
			expect.anything(),
		);
	});
});

describe("deleteContext — workflow start failure", () => {
	it("rejects instead of reporting success when the deletion workflow cannot start", async () => {
		mockGetContextById.mockResolvedValue({
			id: "ctx-file",
			projectId: "proj-1",
			project: personalProject,
			type: "FILE",
			urlScheduleId: null,
		});
		mockTemporalStart.mockRejectedValueOnce(new Error("temporal offline"));

		const handler = await loadHandler();
		await expect(
			handler({
				input: { id: "ctx-file", projectId: "proj-1" },
				context: personalCtx,
			}),
		).rejects.toMatchObject({
			code: "INTERNAL_SERVER_ERROR",
			message: "Failed to start context deletion",
		});
		// Nothing tells collaborators a delete happened that never started.
		expect(mockEmitContextChange).not.toHaveBeenCalled();
		expect(mockEmitActivity).not.toHaveBeenCalled();
	});
});

/**
 * "Remove duplicates" (Fizzy #2619) sends the id of the item each copy was
 * matched against. The server re-checks the match against the stored rows,
 * so a stale list can never delete an item that is no longer a copy.
 */
describe("deleteContext — expectedDuplicateOfContextId guard", () => {
	const copy = {
		id: "ctx-copy",
		projectId: "proj-1",
		project: personalProject,
		type: "FILE",
		urlScheduleId: null,
		contentHash: "hash-a",
	};
	const original = {
		id: "ctx-original",
		projectId: "proj-1",
		project: personalProject,
		type: "FILE",
		urlScheduleId: null,
		contentHash: "hash-a",
	};

	function storedRows(rows: Array<Record<string, unknown>>) {
		mockGetContextById.mockImplementation(
			async (id: string) => rows.find((row) => row.id === id) ?? null,
		);
	}

	const conflict = {
		code: "CONFLICT",
		message:
			"This item is no longer a duplicate of the item it was matched with",
	};

	it("deletes the copy when the original still holds the same content", async () => {
		storedRows([copy, original]);

		const handler = await loadHandler();
		const result = await handler({
			input: {
				id: "ctx-copy",
				projectId: "proj-1",
				expectedDuplicateOfContextId: "ctx-original",
			},
			context: personalCtx,
		});

		expect(result).toEqual({ success: true });
		expect(mockGetContextById).toHaveBeenCalledWith("ctx-original");
		expect(mockTemporalStart).toHaveBeenCalledWith(
			"contextDeletionWorkflow",
			expect.objectContaining({
				args: [expect.objectContaining({ contextId: "ctx-copy" })],
			}),
		);
	});

	it("answers CONFLICT and starts nothing when the original is gone", async () => {
		storedRows([copy]);

		const handler = await loadHandler();
		await expect(
			handler({
				input: {
					id: "ctx-copy",
					projectId: "proj-1",
					expectedDuplicateOfContextId: "ctx-original",
				},
				context: personalCtx,
			}),
		).rejects.toMatchObject(conflict);
		expect(mockDeleteUrlSourceSchedule).not.toHaveBeenCalled();
		expect(mockTemporalStart).not.toHaveBeenCalled();
		expect(mockEmitContextChange).not.toHaveBeenCalled();
	});

	it("answers CONFLICT when the two rows no longer hold the same content", async () => {
		storedRows([copy, { ...original, contentHash: "hash-b" }]);

		const handler = await loadHandler();
		await expect(
			handler({
				input: {
					id: "ctx-copy",
					projectId: "proj-1",
					expectedDuplicateOfContextId: "ctx-original",
				},
				context: personalCtx,
			}),
		).rejects.toMatchObject(conflict);
		expect(mockTemporalStart).not.toHaveBeenCalled();
	});

	it("answers CONFLICT when the copy has no hash, even if the original has none either", async () => {
		storedRows([
			{ ...copy, contentHash: null },
			{ ...original, contentHash: null },
		]);

		const handler = await loadHandler();
		await expect(
			handler({
				input: {
					id: "ctx-copy",
					projectId: "proj-1",
					expectedDuplicateOfContextId: "ctx-original",
				},
				context: personalCtx,
			}),
		).rejects.toMatchObject(conflict);
		expect(mockTemporalStart).not.toHaveBeenCalled();
	});

	it("answers CONFLICT when the original is in another project", async () => {
		storedRows([copy, { ...original, projectId: "proj-2" }]);

		const handler = await loadHandler();
		await expect(
			handler({
				input: {
					id: "ctx-copy",
					projectId: "proj-1",
					expectedDuplicateOfContextId: "ctx-original",
				},
				context: personalCtx,
			}),
		).rejects.toMatchObject(conflict);
		expect(mockTemporalStart).not.toHaveBeenCalled();
	});

	it("answers CONFLICT when a row names itself as its original", async () => {
		storedRows([copy]);

		const handler = await loadHandler();
		await expect(
			handler({
				input: {
					id: "ctx-copy",
					projectId: "proj-1",
					expectedDuplicateOfContextId: "ctx-copy",
				},
				context: personalCtx,
			}),
		).rejects.toMatchObject(conflict);
		expect(mockTemporalStart).not.toHaveBeenCalled();
	});

	it("applies no duplicate check when the field is omitted", async () => {
		storedRows([{ ...copy, contentHash: null }]);

		const handler = await loadHandler();
		const result = await handler({
			input: { id: "ctx-copy", projectId: "proj-1" },
			context: personalCtx,
		});

		expect(result).toEqual({ success: true });
		expect(mockGetContextById).toHaveBeenCalledTimes(1);
		expect(mockTemporalStart).toHaveBeenCalled();
	});
});

/**
 * Fizzy #2638: the tenant the deletion workflow runs under is the project's
 * hosting organization, read from the loaded row. `requireProjectPermission`
 * never reads the organization and `hasProjectAccess` ignores it, so a value
 * taken from the request body was never verified: a caller who reaches an
 * organization-A project and also belongs to organization B could send B, or
 * null, and have A's points deleted from the wrong collection.
 */
describe("deleteContext — the workflow runs under the project's hosting organization", () => {
	const orgRow = {
		id: "ctx-file",
		projectId: "proj-1",
		project: { organizationId: "org-a" },
		type: "FILE",
		urlScheduleId: null,
	};

	function workflowInput(): Record<string, unknown> {
		expect(mockTemporalStart).toHaveBeenCalledTimes(1);
		const options = mockTemporalStart.mock.calls[0][1] as {
			args: [Record<string, unknown>];
		};
		return options.args[0];
	}

	it("passes the hosting organization when the caller sends it", async () => {
		mockGetContextById.mockResolvedValue(orgRow);

		const handler = await loadHandler();
		await handler({
			input: {
				id: "ctx-file",
				projectId: "proj-1",
				organizationId: "org-a",
			},
			context: personalCtx,
		});

		expect(workflowInput().organizationId).toBe("org-a");
	});

	it("passes the hosting organization when the caller sends null", async () => {
		mockGetContextById.mockResolvedValue(orgRow);

		const handler = await loadHandler();
		await handler({
			input: {
				id: "ctx-file",
				projectId: "proj-1",
				organizationId: null,
			},
			context: personalCtx,
		});

		expect(workflowInput().organizationId).toBe("org-a");
	});

	it("ignores the session's active organization when the caller sends nothing", async () => {
		mockGetContextById.mockResolvedValue(orgRow);

		const handler = await loadHandler();
		await handler({
			input: { id: "ctx-file", projectId: "proj-1" },
			context: {
				...personalCtx,
				session: { activeOrganizationId: "org-b" },
			},
		});

		expect(workflowInput().organizationId).toBe("org-a");
	});

	it("refuses another organization's id and starts nothing", async () => {
		mockGetContextById.mockResolvedValue({
			...orgRow,
			type: "LINK",
			urlScheduleId: "url-source-schedule-ctx-file",
		});

		const handler = await loadHandler();
		await expect(
			handler({
				input: {
					id: "ctx-file",
					projectId: "proj-1",
					organizationId: "org-b",
				},
				context: personalCtx,
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: "organizationId does not match the project",
		});

		expect(mockDeleteUrlSourceSchedule).not.toHaveBeenCalled();
		expect(mockTemporalStart).not.toHaveBeenCalled();
		expect(mockEmitContextChange).not.toHaveBeenCalled();
		expect(mockEmitActivity).not.toHaveBeenCalled();
	});

	it("refuses an organization id for a personal project", async () => {
		mockGetContextById.mockResolvedValue({
			...orgRow,
			project: personalProject,
		});

		const handler = await loadHandler();
		await expect(
			handler({
				input: {
					id: "ctx-file",
					projectId: "proj-1",
					organizationId: "org-b",
				},
				context: personalCtx,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mockTemporalStart).not.toHaveBeenCalled();
	});

	it("passes no organization for a personal project", async () => {
		mockGetContextById.mockResolvedValue({
			...orgRow,
			project: personalProject,
		});

		const handler = await loadHandler();
		await handler({
			input: { id: "ctx-file", projectId: "proj-1" },
			context: {
				...personalCtx,
				session: { activeOrganizationId: "org-b" },
			},
		});

		expect(workflowInput().organizationId).toBeUndefined();
	});
});

/**
 * Living Memory design 2026-09-23 §6: a synced knowledge file (a row with a
 * `sourcePath`) is no longer deleted by `contextDeletionWorkflow`. The tab
 * names the version it displays, the row is deleted synchronously and
 * row-first by the helper behind `--prune`, and the answer is final. A row a
 * repository sync owns is refused before any work.
 */
describe("deleteContext — a synced file is deleted row-first, in the version the tab displays", () => {
	const HASH = "c".repeat(64);
	const OTHER_HASH = "d".repeat(64);
	const synced = {
		id: "ctx-synced",
		projectId: "proj-1",
		project: { organizationId: "org-a" },
		type: "TEXT",
		sourcePath: "docs/glossary.md",
		contentHash: HASH,
		repositorySyncId: null,
		urlScheduleId: null,
	};
	const orgCtx = {
		user: { id: "user-1", name: "Example Dev", email: "dev@example.com" },
		session: { activeOrganizationId: "org-a" },
	};

	function storedRows(rows: Array<Record<string, unknown>>) {
		mockGetContextById.mockImplementation(
			async (id: string) => rows.find((row) => row.id === id) ?? null,
		);
	}

	beforeEach(() => {
		mockDeleteSyncedContext.mockResolvedValue({
			status: "deleted",
			contextId: "ctx-synced",
			sourcePath: "docs/glossary.md",
			contentHash: HASH,
		});
		mockGetContextRepositorySync.mockResolvedValue(null);
	});

	it("requires expectedContentHash for a synced row, and starts nothing without it", async () => {
		storedRows([synced]);

		const handler = await loadHandler();
		await expect(
			handler({
				input: { id: "ctx-synced", projectId: "proj-1" },
				context: orgCtx,
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringMatching(
				/expectedContentHash.*version it displays/,
			),
		});
		expect(mockDeleteSyncedContext).not.toHaveBeenCalled();
		expect(mockTemporalStart).not.toHaveBeenCalled();
		expect(mockEmitContextChange).not.toHaveBeenCalled();
	});

	it("deletes through the synced-row helper, never the workflow, under the hosting organization, and answers finally", async () => {
		storedRows([synced]);
		const context = {
			...orgCtx,
			session: { activeOrganizationId: "org-b" },
		};

		const handler = await loadHandler();
		const result = await handler({
			input: {
				id: "ctx-synced",
				projectId: "proj-1",
				expectedContentHash: HASH.toUpperCase(),
			},
			context,
		});

		expect(result).toEqual({
			success: true,
			status: "deleted",
			contextId: "ctx-synced",
			sourcePath: "docs/glossary.md",
			contentHash: HASH,
		});
		expect(mockDeleteSyncedContext).toHaveBeenCalledTimes(1);
		expect(mockDeleteSyncedContext).toHaveBeenCalledWith({
			projectId: "proj-1",
			sourcePath: "docs/glossary.md",
			expectedContentHash: HASH,
			// Only the row the tab displayed.
			contextId: "ctx-synced",
			userId: "user-1",
			// The project's, not the session's.
			organizationId: "org-a",
			via: "web",
			request: context,
		});
		expect(mockTemporalStart).not.toHaveBeenCalled();
		// The helper recorded and published it; the route adds nothing.
		expect(mockEmitContextChange).not.toHaveBeenCalled();
		expect(mockEmitActivity).not.toHaveBeenCalled();
	});

	it("answers absent when the row went after the tab read it", async () => {
		storedRows([synced]);
		mockDeleteSyncedContext.mockResolvedValue({
			status: "absent",
			sourcePath: "docs/glossary.md",
		});

		const handler = await loadHandler();
		const result = await handler({
			input: {
				id: "ctx-synced",
				projectId: "proj-1",
				expectedContentHash: HASH,
			},
			context: orgCtx,
		});

		expect(result).toEqual({
			success: true,
			status: "absent",
			sourcePath: "docs/glossary.md",
		});
	});

	it("answers another stored version with the existing CONFLICT shape and its stamp", async () => {
		storedRows([synced]);
		const conflict = {
			status: "conflict",
			contextId: "ctx-synced",
			sourcePath: "docs/glossary.md",
			contentHash: HASH,
			current: {
				contextId: "ctx-synced",
				contentHash: OTHER_HASH,
				contentUpdatedAt: new Date("2026-09-22T11:00:00Z"),
				contentUpdatedBy: { id: "user-2", name: "Other Dev" },
			},
		};
		mockDeleteSyncedContext.mockResolvedValue(conflict);

		const handler = await loadHandler();
		const error = await handler({
			input: {
				id: "ctx-synced",
				projectId: "proj-1",
				expectedContentHash: HASH,
			},
			context: orgCtx,
		}).catch((caught: unknown) => caught);

		expect(error).toMatchObject({ code: "CONFLICT", data: conflict });
		expect((error as Error).message).toMatch(/nothing was deleted/i);
		expect(mockTemporalStart).not.toHaveBeenCalled();
	});

	it("refuses a row a repository sync owns before any work, naming the repository and branch — even without a hash", async () => {
		storedRows([{ ...synced, repositorySyncId: "sync-1" }]);
		mockGetContextRepositorySync.mockResolvedValue({
			id: "sync-1",
			ref: "main",
			repositoryIntegration: {
				repositoryOwner: "example-org",
				repositoryName: "handbook",
			},
		});

		const handler = await loadHandler();
		await expect(
			handler({
				input: { id: "ctx-synced", projectId: "proj-1" },
				context: orgCtx,
			}),
		).rejects.toMatchObject({
			code: "CONFLICT",
			message:
				"docs/glossary.md is synced from example-org/handbook @ main; change it in the repository and run Sync now.",
			data: {
				code: "REPOSITORY_MANAGED",
				repository: "example-org/handbook",
				ref: "main",
			},
		});
		expect(mockGetContextRepositorySync).toHaveBeenCalledWith(
			"proj-1",
			"org-a",
		);
		expect(mockDeleteSyncedContext).not.toHaveBeenCalled();
		expect(mockTemporalStart).not.toHaveBeenCalled();
		expect(mockEmitContextChange).not.toHaveBeenCalled();
	});

	it("names the connected repository when the configuration that owned the row is gone", async () => {
		storedRows([{ ...synced, repositorySyncId: "sync-1" }]);
		mockGetContextRepositorySync.mockResolvedValue(null);

		const handler = await loadHandler();
		await expect(
			handler({
				input: {
					id: "ctx-synced",
					projectId: "proj-1",
					expectedContentHash: HASH,
				},
				context: orgCtx,
			}),
		).rejects.toMatchObject({
			code: "CONFLICT",
			data: { code: "REPOSITORY_MANAGED", repository: null, ref: null },
		});
		expect(mockDeleteSyncedContext).not.toHaveBeenCalled();
	});

	it("passes on the helper's refusal for a row adopted after the tab read it", async () => {
		storedRows([synced]);
		const refusal = Object.assign(new Error("adopted"), {
			code: "CONFLICT",
			data: { code: "REPOSITORY_MANAGED", repository: null, ref: null },
		});
		mockDeleteSyncedContext.mockRejectedValue(refusal);

		const handler = await loadHandler();
		await expect(
			handler({
				input: {
					id: "ctx-synced",
					projectId: "proj-1",
					expectedContentHash: HASH,
				},
				context: orgCtx,
			}),
		).rejects.toBe(refusal);
		expect(mockTemporalStart).not.toHaveBeenCalled();
	});

	it("Remove duplicates: deletes the copy in the displayed version while the original still holds it", async () => {
		storedRows([
			synced,
			{ ...synced, id: "ctx-original", sourcePath: "notes/glossary.md" },
		]);

		const handler = await loadHandler();
		const result = await handler({
			input: {
				id: "ctx-synced",
				projectId: "proj-1",
				expectedDuplicateOfContextId: "ctx-original",
				expectedContentHash: HASH,
			},
			context: orgCtx,
		});

		expect(result).toMatchObject({ success: true, status: "deleted" });
		expect(mockDeleteSyncedContext).toHaveBeenCalledWith(
			expect.objectContaining({
				contextId: "ctx-synced",
				expectedContentHash: HASH,
			}),
		);
	});

	it("Remove duplicates: answers CONFLICT, deleting nothing, when the original no longer holds the displayed version", async () => {
		storedRows([
			synced,
			{
				...synced,
				id: "ctx-original",
				sourcePath: "notes/glossary.md",
				contentHash: OTHER_HASH,
			},
		]);

		const handler = await loadHandler();
		await expect(
			handler({
				input: {
					id: "ctx-synced",
					projectId: "proj-1",
					expectedDuplicateOfContextId: "ctx-original",
					expectedContentHash: HASH,
				},
				context: orgCtx,
			}),
		).rejects.toMatchObject({
			code: "CONFLICT",
			message:
				"This item is no longer a duplicate of the item it was matched with",
		});
		expect(mockDeleteSyncedContext).not.toHaveBeenCalled();
		expect(mockTemporalStart).not.toHaveBeenCalled();
	});

	it("keeps the workflow route for a context with no source path, whatever hash is sent", async () => {
		storedRows([
			{
				id: "ctx-text",
				projectId: "proj-1",
				project: { organizationId: "org-a" },
				type: "TEXT",
				sourcePath: null,
				contentHash: HASH,
				repositorySyncId: null,
				urlScheduleId: null,
			},
		]);

		const handler = await loadHandler();
		const result = await handler({
			input: {
				id: "ctx-text",
				projectId: "proj-1",
				expectedContentHash: OTHER_HASH,
			},
			context: orgCtx,
		});

		expect(result).toEqual({ success: true });
		expect(mockDeleteSyncedContext).not.toHaveBeenCalled();
		expect(mockTemporalStart).toHaveBeenCalledWith(
			"contextDeletionWorkflow",
			expect.objectContaining({
				args: [expect.objectContaining({ contextId: "ctx-text" })],
			}),
		);
		expect(mockEmitContextChange).toHaveBeenCalledTimes(1);
	});
});
