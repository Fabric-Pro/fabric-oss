/**
 * `deleteSingleContextActivity`, the legacy `contextDeletionWorkflow`'s one
 * activity: vectors first, then the row.
 *
 * What this pins (Living Memory design 2026-09-23 §4.3, §6):
 *  - an execution still open at deploy time can race a repository sync that
 *    adopts the same unowned path and hash between the vector delete and the
 *    row delete. The row delete is guarded on `repositorySyncId IS NULL`, so
 *    the now-managed row survives; its points are gone, so it is left with
 *    `embeddedAt = NULL` and a hash-guarded re-embed start is requested;
 *  - a failed re-embed start is logged, never thrown: the deletion finishes;
 *  - a row already managed when the activity reads it is not touched at all;
 *  - the row delete carries the project and the input's organization when
 *    the input carries one, and none when it does not (or carries `null`);
 *  - an ordinary, unmanaged row is still deleted.
 *
 * The database is an in-memory table. `deleteContext` is modelled as the
 * id-only delete the activity used to end with, and `deleteUnmanagedContextRow`
 * with its guard, so a regression to the id-only delete shows up as the
 * managed row disappearing.
 *
 * Run with: pnpm --filter @repo/temporal exec vitest run context-deletion-activity
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = {
	id: string;
	projectId: string;
	organizationId: string | null;
	type: string;
	sourcePath: string | null;
	sourceTitle: string | null;
	metadata: Record<string, unknown>;
	qdrantId: string | null;
	repositorySyncId: string | null;
	embeddedAt: Date | null;
};

const mocks = vi.hoisted(() => ({
	rows: [] as Array<Record<string, unknown>>,
	/** Runs inside the vector delete: the window a sync adopts in. */
	duringVectorDelete: null as null | (() => void),
	deleteProjectContext: vi.fn(),
	deleteUrlSourceChunks: vi.fn(),
	workflowStart: vi.fn(),
	getTemporalClient: vi.fn(),
	deleteUnmanagedContextRowCalls: [] as unknown[],
	warn: vi.fn(),
}));

function matches(
	row: Record<string, unknown>,
	where: Record<string, unknown>,
): boolean {
	return Object.entries(where).every(
		([key, value]) => (row[key] ?? null) === value,
	);
}

vi.mock("@repo/database", () => ({
	getContextById: vi.fn(async (id: string) => {
		const row = mocks.rows.find((candidate) => candidate.id === id);
		return row ? { ...row } : null;
	}),
	// The id-only delete the activity used to end with.
	deleteContext: vi.fn(async (id: string) => {
		const index = mocks.rows.findIndex((row) => row.id === id);
		if (index === -1) {
			throw new Error("Record to delete does not exist.");
		}
		return mocks.rows.splice(index, 1)[0];
	}),
	// The guarded delete, as `contexts.ts` implements it (its own test is in
	// packages/database/__tests__/delete-context-by-source-path.test.ts).
	deleteUnmanagedContextRow: vi.fn(
		async (input: {
			contextId: string;
			projectId: string;
			organizationId?: string;
		}) => {
			mocks.deleteUnmanagedContextRowCalls.push(input);
			const scope: Record<string, unknown> = {
				id: input.contextId,
				projectId: input.projectId,
				...(input.organizationId !== undefined
					? { organizationId: input.organizationId }
					: {}),
			};
			const before = mocks.rows.length;
			mocks.rows = mocks.rows.filter(
				(row) => !matches(row, { ...scope, repositorySyncId: null }),
			);
			if (mocks.rows.length < before) {
				return { status: "deleted" };
			}
			const row = mocks.rows.find((candidate) =>
				matches(candidate, scope),
			);
			if (!row) {
				return { status: "absent" };
			}
			row.embeddedAt = null;
			const context = {
				id: row.id,
				projectId: row.projectId,
				organizationId: row.organizationId,
				sourcePath: row.sourcePath,
				title:
					((row.metadata as Record<string, unknown>)
						.title as string) ?? row.id,
			};
			return row.repositorySyncId !== null
				? { status: "repository-managed", context }
				: { status: "changed", context };
		},
	),
}));

vi.mock("@repo/rag", () => ({
	deleteProjectContext: mocks.deleteProjectContext,
	deleteUrlSourceChunks: mocks.deleteUrlSourceChunks,
}));

vi.mock("../src/client", () => ({
	getTemporalClient: mocks.getTemporalClient,
}));

vi.mock("../src/activities/lib/activity-logger", () => ({
	activityLogger: { info: vi.fn(), warn: mocks.warn, error: vi.fn() },
}));

import { deleteSingleContextActivity } from "../src/activities/context-deletion";

const PATH = "docs/glossary.md";
const EMBEDDED_AT = new Date("2026-09-20T09:02:00Z");

function seed(overrides: Partial<Row> = {}): Row {
	const row: Row = {
		id: "ctx-1",
		projectId: "proj-1",
		organizationId: "org-1",
		type: "TEXT",
		sourcePath: PATH,
		sourceTitle: null,
		metadata: { title: "Glossary", sourcePath: PATH },
		qdrantId: "11111111-2222-3333-4444-555555555555",
		repositorySyncId: null,
		embeddedAt: EMBEDDED_AT,
		...overrides,
	};
	mocks.rows.push(row as unknown as Record<string, unknown>);
	return row;
}

const INPUT = {
	contextId: "ctx-1",
	projectId: "proj-1",
	userId: "user-1",
	organizationId: "org-1",
};

function stored(id = "ctx-1") {
	return mocks.rows.find((row) => row.id === id) as Row | undefined;
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.rows = [];
	mocks.deleteUnmanagedContextRowCalls = [];
	mocks.duringVectorDelete = null;
	mocks.deleteProjectContext.mockImplementation(async () => {
		mocks.duringVectorDelete?.();
	});
	mocks.workflowStart.mockResolvedValue(undefined);
	mocks.getTemporalClient.mockResolvedValue({
		workflow: { start: mocks.workflowStart },
	});
});

describe("deleteSingleContextActivity — an open legacy deletion racing adoption", () => {
	it("keeps a row a repository sync adopts after the vector delete, clears embeddedAt and requests a re-embed", async () => {
		seed();
		// The sync adopts the unowned path and hash in the window between the
		// activity's vector delete and its row delete.
		mocks.duringVectorDelete = () => {
			const row = stored();
			if (row) {
				row.repositorySyncId = "sync-1";
			}
		};

		const result = await deleteSingleContextActivity(INPUT);

		expect(mocks.deleteProjectContext).toHaveBeenCalledTimes(1);
		const row = stored();
		expect(row).toBeDefined();
		expect(row?.repositorySyncId).toBe("sync-1");
		expect(row?.embeddedAt).toBeNull();
		expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
		expect(mocks.workflowStart).toHaveBeenCalledWith(
			"contextEmbeddingWorkflow",
			expect.objectContaining({
				taskQueue: "project-documents",
				args: [
					expect.objectContaining({
						contextId: "ctx-1",
						projectId: "proj-1",
						userId: "user-1",
						organizationId: "org-1",
						type: "TEXT",
						reembed: true,
						metadata: {
							filename: PATH,
							sourceTitle: "Glossary",
							sourcePath: PATH,
						},
					}),
				],
			}),
		);
		// The workflow's result shape is unchanged; the reason rides along.
		expect(result).toEqual({
			success: true,
			qdrantDeleted: true,
			dbDeleted: false,
			dbSkippedReason: "repository-managed",
			reembedRequested: true,
		});
	});

	it("logs a failed re-embed start and still finishes, leaving embeddedAt NULL as the repair obligation", async () => {
		seed();
		mocks.duringVectorDelete = () => {
			const row = stored();
			if (row) {
				row.repositorySyncId = "sync-1";
			}
		};
		mocks.workflowStart.mockRejectedValue(new Error("temporal down"));

		const result = await deleteSingleContextActivity(INPUT);

		expect(stored()?.embeddedAt).toBeNull();
		expect(result).toMatchObject({
			success: true,
			dbDeleted: false,
			dbSkippedReason: "repository-managed",
			reembedRequested: false,
		});
		expect(mocks.warn).toHaveBeenCalledWith(
			"Could not start re-embedding of a kept context",
			expect.objectContaining({ contextId: "ctx-1" }),
		);
	});

	it("leaves a row that is already managed when read untouched: no vector delete, no row delete", async () => {
		seed({ repositorySyncId: "sync-1" });

		const result = await deleteSingleContextActivity(INPUT);

		expect(mocks.deleteProjectContext).not.toHaveBeenCalled();
		expect(mocks.deleteUnmanagedContextRowCalls).toEqual([]);
		expect(stored()?.embeddedAt).toEqual(EMBEDDED_AT);
		expect(mocks.workflowStart).not.toHaveBeenCalled();
		expect(result).toEqual({
			success: true,
			qdrantDeleted: false,
			dbDeleted: false,
			dbSkippedReason: "repository-managed",
		});
	});
});

describe("deleteSingleContextActivity — the guarded row delete", () => {
	it("still deletes an ordinary unmanaged row, scoped to its project and the input's organization", async () => {
		seed({ sourcePath: null, metadata: {} });

		const result = await deleteSingleContextActivity(INPUT);

		expect(stored()).toBeUndefined();
		expect(mocks.deleteUnmanagedContextRowCalls).toEqual([
			{
				contextId: "ctx-1",
				projectId: "proj-1",
				organizationId: "org-1",
			},
		]);
		expect(mocks.workflowStart).not.toHaveBeenCalled();
		expect(result).toEqual({
			success: true,
			qdrantDeleted: true,
			dbDeleted: true,
		});
	});

	it.each([
		["omits", undefined],
		["passes null for", null],
	])(
		"scopes by no organization when the input %s one",
		async (_label, organizationId) => {
			seed({ sourcePath: null, metadata: {} });

			const result = await deleteSingleContextActivity({
				...INPUT,
				organizationId: organizationId as unknown as string | undefined,
			});

			expect(mocks.deleteUnmanagedContextRowCalls).toEqual([
				{ contextId: "ctx-1", projectId: "proj-1" },
			]);
			expect(result.dbDeleted).toBe(true);
		},
	);

	it("refuses a row under another organization before touching its vectors", async () => {
		seed({ organizationId: "org-2" });

		const result = await deleteSingleContextActivity(INPUT);

		expect(mocks.deleteProjectContext).not.toHaveBeenCalled();
		expect(stored()).toBeDefined();
		expect(result).toMatchObject({ success: false, dbDeleted: false });
	});

	it("deletes a row that carries no organization of its own, scoped by project alone", async () => {
		seed({ sourcePath: null, metadata: {}, organizationId: null });

		const result = await deleteSingleContextActivity(INPUT);

		expect(mocks.deleteProjectContext).toHaveBeenCalledTimes(1);
		expect(mocks.deleteUnmanagedContextRowCalls).toEqual([
			{ contextId: "ctx-1", projectId: "proj-1" },
		]);
		expect(result).toMatchObject({ success: true, dbDeleted: true });
	});

	it("answers success without a row delete when somebody else deleted the row after the read", async () => {
		seed({ sourcePath: null, metadata: {} });
		mocks.duringVectorDelete = () => {
			mocks.rows = [];
		};

		const result = await deleteSingleContextActivity(INPUT);

		expect(result).toEqual({
			success: true,
			qdrantDeleted: true,
			dbDeleted: false,
		});
	});
});
