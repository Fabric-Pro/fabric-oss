/**
 * `deleteSyncedContextRow` — the synchronous, row-first delete of a synced
 * knowledge file (Living Memory design 2026-09-23 §6) that replaces the
 * claim → vectors → row workflow on every surface.
 *
 * What this pins:
 *  - only the named version of an UNOWNED row is deleted, and the delete, its
 *    queued vector cleanup and its audit row commit together or not at all;
 *  - a row a repository sync authored is never deleted: at the read, and
 *    when it is adopted between the read and the delete (the guard carries
 *    `repositorySyncId IS NULL`) — the answer is `repository-managed`, naming
 *    the repository and branch;
 *  - another version, another row than the one displayed, or a version with
 *    no hash is a `conflict` naming the stored version; no row is `absent`;
 *    a repeat of an operation that committed answers `deleted` from its
 *    receipt without deleting or recording twice;
 *  - tenant scoping: the exclusive organization arm, never another project's
 *    or tenant's row, and the cleanup record carries the tenant XOR.
 *
 * The client is an in-memory table that evaluates each `where` by equality.
 * `$transaction` runs its callback against a working copy that is committed
 * only when the callback returns, so a write that escaped the transaction —
 * or a transaction that did not roll back — shows up in the committed store.
 *
 * Run with: pnpm --filter @repo/database test -- __tests__/delete-synced-context-row.test.ts
 */

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const table = vi.hoisted(() => {
	interface Store {
		rows: Row[];
		audit: Row[];
		cleanups: Row[];
		users: Row[];
		syncs: Row[];
	}
	const committed: Store = {
		rows: [],
		audit: [],
		cleanups: [],
		users: [],
		syncs: [],
	};
	const state = { committed, nextId: 1 };
	let current: Store = committed;
	function on<T>(store: Store, call: () => T): T {
		const previous = current;
		current = store;
		try {
			return call();
		} finally {
			current = previous;
		}
	}

	function matches(row: Row, where: Record<string, unknown>): boolean {
		return Object.entries(where).every(([key, value]) => {
			if (value !== null && typeof value === "object") {
				const filter = value as { path?: unknown; equals?: unknown };
				if (Array.isArray(filter.path) && "equals" in filter) {
					let cursor: unknown = row[key];
					for (const segment of filter.path as string[]) {
						cursor =
							cursor && typeof cursor === "object"
								? (cursor as Record<string, unknown>)[segment]
								: undefined;
					}
					return cursor === filter.equals;
				}
				throw new Error(
					`fake table: unsupported operator on ${key} — the query must stay an equality filter`,
				);
			}
			return (row[key] ?? null) === value;
		});
	}

	function pick(row: Row | undefined, select?: Record<string, unknown>) {
		if (!row) {
			return null;
		}
		if (!select) {
			return { ...row };
		}
		return Object.fromEntries(
			Object.keys(select).map((key) => [key, row[key] ?? null]),
		);
	}

	type FindArgs = {
		where: Record<string, unknown>;
		select?: Record<string, unknown>;
	};

	const projectContext = {
		findFirst: vi.fn(async (args: FindArgs) =>
			pick(
				current.rows.find((row) => matches(row, args.where)),
				args.select,
			),
		),
		deleteMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
			const store = current;
			const before = store.rows.length;
			store.rows = store.rows.filter((row) => !matches(row, args.where));
			return { count: before - store.rows.length };
		}),
	};

	const projectContextPendingVectorCleanup = {
		create: vi.fn(async (args: { data: Row }) => {
			const row = { id: `cleanup-${state.nextId++}`, ...args.data };
			current.cleanups.push(row);
			return { id: row.id };
		}),
	};

	const projectContextRepositorySync = {
		findFirst: vi.fn(async (args: FindArgs) => {
			const sync = current.syncs.find((row) => matches(row, args.where));
			return sync
				? {
						ref: sync.ref,
						repositoryIntegration: {
							repositoryOwner: sync.repositoryOwner,
							repositoryName: sync.repositoryName,
						},
					}
				: null;
		}),
	};

	const auditLog = {
		create: vi.fn(async (args: { data: Record<string, unknown> }) => {
			const { user, organization, project, ...scalars } = args.data as {
				user?: { connect: { id: string } };
				organization?: { connect: { id: string } };
				project?: { connect: { id: string } };
			} & Row;
			const row: Row = {
				id: `audit-${state.nextId++}`,
				...scalars,
				userId: user?.connect.id ?? null,
				organizationId: organization?.connect.id ?? null,
				projectId: project?.connect.id ?? null,
			};
			current.audit.push(row);
			return row;
		}),
		findFirst: vi.fn(async (args: FindArgs) =>
			pick(
				current.audit.find((row) => matches(row, args.where)),
				args.select,
			),
		),
	};

	const user = {
		findUnique: vi.fn(async (args: FindArgs) =>
			pick(
				current.users.find((row) => matches(row, args.where)),
				args.select,
			),
		),
	};

	const models = {
		projectContext,
		projectContextPendingVectorCleanup,
		projectContextRepositorySync,
		auditLog,
		user,
	} as const;

	function clientOn(store: Store) {
		return Object.fromEntries(
			Object.entries(models).map(([name, model]) => [
				name,
				Object.fromEntries(
					Object.entries(model).map(([method, fn]) => [
						method,
						(args: unknown) =>
							on(store, () =>
								(fn as (a: unknown) => unknown)(args),
							),
					]),
				),
			]),
		);
	}

	const $transaction = vi.fn(
		async (callback: (tx: unknown) => Promise<unknown>) => {
			const work: Store = {
				rows: committed.rows.map((row) => ({ ...row })),
				audit: committed.audit.map((row) => ({ ...row })),
				cleanups: committed.cleanups.map((row) => ({ ...row })),
				users: committed.users,
				syncs: committed.syncs,
			};
			const result = await callback(clientOn(work));
			committed.rows = work.rows;
			committed.audit = work.audit;
			committed.cleanups = work.cleanups;
			return result;
		},
	);

	return {
		state,
		committed,
		projectContext,
		projectContextPendingVectorCleanup,
		auditLog,
		/** Rows the next transaction's working copy starts from. */
		work: () => current,
		db: { ...models, $transaction },
	};
});

vi.mock("../prisma/client", () => ({
	db: table.db,
	Prisma: { sql: vi.fn(), join: vi.fn() },
}));

import { deleteSyncedContextRow } from "../prisma/queries/projects/contexts";
import { SYNCED_CONTEXT_DELETE_AUDIT_ACTION } from "../prisma/queries/projects/synced-context-delete-audit";

const sha = (content: string) =>
	createHash("sha256").update(content, "utf8").digest("hex");

const V1 = "# Runbook\n\nPage the on-call engineer.\n";
const V2 = "# Runbook\n\nPage the on-call engineer twice.\n";
const PATH = "ops/runbook.md";
const OPERATION_ID = "5d0c7e2a-1b3f-4a6e-9c8d-2f4a6b8c0e1d";
const AUDIT_CONTEXT = {
	via: "web" as const,
	impersonatedById: null,
	ipAddress: "203.0.113.9",
	userAgent: "Mozilla/5.0",
	requestId: "req-7",
	sessionId: null,
	correlationId: "corr-7",
};

function seed(overrides: Row = {}): Row {
	const row: Row = {
		id: `ctx-${table.state.nextId++}`,
		projectId: "proj-1",
		type: "TEXT",
		content: V1,
		sourcePath: PATH,
		contentHash: sha(V1),
		contentUpdatedAt: new Date("2026-09-20T09:00:00Z"),
		contentUpdatedByUserId: "user-1",
		metadata: { title: "Runbook", sourcePath: PATH },
		sourceTitle: null,
		originalFilename: null,
		qdrantId: null,
		embeddedAt: new Date("2026-09-20T09:01:00Z"),
		repositorySyncId: null,
		userId: "user-1",
		organizationId: "org-1",
		updatedAt: new Date("2026-09-20T09:01:00Z"),
		...overrides,
	};
	table.committed.rows.push(row);
	return row;
}

function remove(
	overrides: Partial<Parameters<typeof deleteSyncedContextRow>[0]> = {},
) {
	return deleteSyncedContextRow({
		projectId: "proj-1",
		organizationId: "org-1",
		sourcePath: PATH,
		expectedContentHash: sha(V1),
		userId: "user-2",
		operationId: OPERATION_ID,
		audit: AUDIT_CONTEXT,
		...overrides,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	table.committed.rows = [];
	table.committed.audit = [];
	table.committed.cleanups = [];
	table.committed.users = [
		{ id: "user-2", email: "dev@example.com", name: "Dev Example" },
	];
	table.committed.syncs = [
		{
			id: "sync-1",
			projectId: "proj-1",
			organizationId: "org-1",
			ref: "main",
			repositoryOwner: "example-org",
			repositoryName: "handbook",
		},
	];
	table.state.nextId = 1;
});

describe("deleteSyncedContextRow — the named version of an unowned row", () => {
	it("deletes the row, queues its vector cleanup and writes its audit row, all committed together", async () => {
		const row = seed();

		const result = await remove();

		expect(result).toMatchObject({
			status: "deleted",
			context: { id: row.id, sourcePath: PATH, contentHash: sha(V1) },
			cleanupId: expect.any(String),
		});
		expect(table.committed.rows).toEqual([]);
		expect(table.committed.cleanups).toEqual([
			{
				id: result.status === "deleted" ? result.cleanupId : "",
				projectId: "proj-1",
				contextIds: [row.id],
				// The tenant XOR: an organization record names no user.
				userId: null,
				organizationId: "org-1",
			},
		]);
		expect(table.committed.audit).toHaveLength(1);
		expect(table.committed.audit[0]).toMatchObject({
			action: SYNCED_CONTEXT_DELETE_AUDIT_ACTION,
			organizationId: "org-1",
			projectId: "proj-1",
			resourceType: "project_context",
			resourceId: row.id,
			resourceName: "Runbook",
			metadata: expect.objectContaining({
				sourcePath: PATH,
				contentHash: sha(V1),
				operationId: OPERATION_ID,
				via: "web",
			}),
		});
		expect(JSON.stringify(table.committed.audit[0])).not.toContain(
			"Page the on-call",
		);
	});

	it("keys the delete on the row, the project, the tenant, the path, the named hash and no repository owner", async () => {
		const row = seed();

		await remove();

		expect(table.projectContext.deleteMany.mock.calls[0][0].where).toEqual({
			id: row.id,
			projectId: "proj-1",
			sourcePath: PATH,
			organizationId: "org-1",
			contentHash: sha(V1),
			repositorySyncId: null,
		});
	});

	it("deletes only the row the caller displayed when it names one", async () => {
		const row = seed();

		expect((await remove({ contextId: row.id as string })).status).toBe(
			"deleted",
		);
	});

	it("rolls the delete back when the audit row cannot be written, so nothing is gone without its receipt or its cleanup", async () => {
		const row = seed();
		table.auditLog.create.mockRejectedValueOnce(new Error("audit down"));

		await expect(remove()).rejects.toThrow("audit down");

		expect(table.committed.rows).toEqual([row]);
		expect(table.committed.cleanups).toEqual([]);
		expect(table.committed.audit).toEqual([]);
	});

	it("rolls the delete back when the cleanup record cannot be written", async () => {
		const row = seed();
		table.projectContextPendingVectorCleanup.create.mockRejectedValueOnce(
			new Error("queue down"),
		);

		await expect(remove()).rejects.toThrow("queue down");

		expect(table.committed.rows).toEqual([row]);
		expect(table.committed.audit).toEqual([]);
	});
});

describe("deleteSyncedContextRow — a row a repository sync authored", () => {
	it("is repository-managed, naming the repository and branch, and nothing is deleted, queued or recorded", async () => {
		const row = seed({ repositorySyncId: "sync-1" });

		const result = await remove();

		expect(result).toMatchObject({
			status: "repository-managed",
			context: { id: row.id, repositorySyncId: "sync-1" },
			sync: { repository: "example-org/handbook", ref: "main" },
		});
		expect(table.projectContext.deleteMany).not.toHaveBeenCalled();
		expect(table.committed.rows).toEqual([row]);
		expect(table.committed.cleanups).toEqual([]);
		expect(table.committed.audit).toEqual([]);
	});

	it("never deletes a row the sync adopted between the read and the delete", async () => {
		const row = seed();
		// Unowned when read; the sync's guarded adopt commits before the
		// delete statement runs.
		table.projectContext.findFirst.mockImplementationOnce(async (args) => {
			const working = table.work().rows.find((r) => r.id === row.id);
			const snapshot = { ...working };
			if (working) {
				working.repositorySyncId = "sync-1";
			}
			return Object.fromEntries(
				Object.keys(args.select ?? snapshot).map((key) => [
					key,
					snapshot[key] ?? null,
				]),
			);
		});

		const result = await remove();

		expect(result).toMatchObject({
			status: "repository-managed",
			sync: { repository: "example-org/handbook", ref: "main" },
		});
		expect(table.committed.rows).toHaveLength(1);
		expect(table.committed.cleanups).toEqual([]);
		expect(table.committed.audit).toEqual([]);
	});

	it("names no repository when the configuration was removed while the call ran", async () => {
		seed({ repositorySyncId: "sync-gone" });

		expect(await remove()).toMatchObject({
			status: "repository-managed",
			sync: { repository: null, ref: null },
		});
	});
});

describe("deleteSyncedContextRow — nothing to delete", () => {
	it("is a conflict naming the stored version when the path holds another one", async () => {
		const row = seed({
			content: V2,
			contentHash: sha(V2),
			contentUpdatedByUserId: "user-3",
		});

		expect(await remove()).toEqual({
			status: "conflict",
			current: {
				contextId: row.id,
				contentHash: sha(V2),
				contentUpdatedAt: new Date("2026-09-20T09:00:00Z"),
				contentUpdatedByUserId: "user-3",
			},
		});
		expect(table.projectContext.deleteMany).not.toHaveBeenCalled();
	});

	it("is a conflict when the path holds another row than the one displayed", async () => {
		const row = seed();

		const result = await remove({ contextId: "ctx-displayed-earlier" });

		expect(result).toMatchObject({
			status: "conflict",
			current: { contextId: row.id },
		});
		expect(table.committed.rows).toEqual([row]);
	});

	it("is a conflict for a stored version with no hash, which no caller can name", async () => {
		seed({ contentHash: null });

		expect((await remove()).status).toBe("conflict");
		expect(table.projectContext.deleteMany).not.toHaveBeenCalled();
	});

	it("is a conflict when the row changed between the read and the delete", async () => {
		const row = seed();
		table.projectContext.findFirst.mockImplementationOnce(async (args) => {
			const working = table.work().rows.find((r) => r.id === row.id);
			const snapshot = { ...working };
			if (working) {
				Object.assign(working, { content: V2, contentHash: sha(V2) });
			}
			return Object.fromEntries(
				Object.keys(args.select ?? snapshot).map((key) => [
					key,
					snapshot[key] ?? null,
				]),
			);
		});

		expect(await remove()).toMatchObject({
			status: "conflict",
			current: { contextId: row.id, contentHash: sha(V2) },
		});
		expect(table.committed.rows).toHaveLength(1);
		expect(table.committed.cleanups).toEqual([]);
	});

	it("is absent when no row is at the path", async () => {
		expect(await remove()).toEqual({ status: "absent" });
		expect(table.committed.audit).toEqual([]);
	});

	it("never deletes a row added in the Context tab, which has no path", async () => {
		const manual = seed({ sourcePath: null, type: "FILE" });

		expect(await remove()).toEqual({ status: "absent" });
		expect(table.committed.rows).toEqual([manual]);
	});

	it("answers deleted from its receipt, deleting and recording nothing more, when the operation is repeated after it committed", async () => {
		seed();
		expect((await remove()).status).toBe("deleted");

		expect(await remove()).toEqual({
			status: "deleted",
			context: null,
			cleanupId: null,
		});
		expect(table.committed.audit).toHaveLength(1);
		expect(table.committed.cleanups).toHaveLength(1);
	});

	it("is absent, not deleted, when the only receipt is another operation's", async () => {
		seed();
		await remove({ operationId: "another-operation" });

		expect(await remove()).toEqual({ status: "absent" });
	});
});

describe("deleteSyncedContextRow — tenant scoping", () => {
	it("reads under the exclusive organization arm, never an OR", async () => {
		seed();

		await remove();

		for (const call of table.projectContext.findFirst.mock.calls) {
			expect(call[0].where).toMatchObject({ organizationId: "org-1" });
			expect(call[0].where).not.toHaveProperty("OR");
			expect(call[0].where).not.toHaveProperty("userId");
		}
	});

	it("never deletes another project's or another organization's row at the same path", async () => {
		const otherProject = seed({ projectId: "proj-2" });
		const otherOrg = seed({ organizationId: "org-2" });

		expect(await remove()).toEqual({ status: "absent" });
		expect(table.committed.rows).toEqual([otherProject, otherOrg]);
	});

	it("never deletes an organization row from the personal arm", async () => {
		const orgRow = seed();

		expect(await remove({ organizationId: null })).toEqual({
			status: "absent",
		});
		expect(table.committed.rows).toEqual([orgRow]);
	});
});
