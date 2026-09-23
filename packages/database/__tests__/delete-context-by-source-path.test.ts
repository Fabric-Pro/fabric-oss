/**
 * The compare-and-set delete behind `fabric context push --prune`
 * (Fizzy #2636), as the three database steps the deletion workflow runs:
 * `findSyncedContextIdAtPath` (names the workflow), then
 * `claimSyncedContextRowForDeletion`, then — after the caller removed the
 * row's points from the vector index — `deleteClaimedSyncedContextRow`.
 *
 * What this pins:
 *  - only the version the caller names is claimed or deleted: a path holding
 *    anything else is a conflict that changes nothing and names the last
 *    writer;
 *  - a path with no row is `absent`, so a retry of a delete whose response
 *    was lost hears "gone" rather than an error;
 *  - the claim marks the row unindexed (`embeddedAt: null`) under the
 *    replace's guard, so a process that stops between the vector delete and
 *    the row delete leaves a row that says it has no index, and repeating
 *    the claim is harmless;
 *  - the row delete is keyed on the claim's guard, so a version pushed after
 *    the claim is never deleted; a lost race hands back the row that
 *    survived, so its index can be rebuilt;
 *  - the audit row is the delete's durable receipt: written in the SAME
 *    transaction as the row delete, keyed by the operation id, so the row is
 *    never gone without it (a failed insert rolls the delete back), a repeat
 *    after an attempt that committed finds its own receipt and answers
 *    `deleted` without a second row, and a row somebody else deleted (no
 *    receipt of this operation) is `gone`;
 *  - only a synced row is addressable: a row added in the Context tab has no
 *    path, and is never claimed or deleted even when it holds the named
 *    content;
 *  - tenant scoping: the organization arm, never OR-ed with the personal
 *    one, and never another project's row — nor another tenant's receipt.
 *
 * The client is an in-memory table that evaluates each `where` by equality,
 * so a scope that is too wide or too narrow shows up as the wrong row being
 * read, claimed or deleted. `$transaction` runs its callback against a
 * working copy that is committed only when the callback returns, and a write
 * made through `db` instead of the transaction client commits at once, so a
 * delete that ran outside the audit's transaction would survive a rollback.
 *
 * Run with: pnpm --filter @repo/database test -- __tests__/delete-context-by-source-path.test.ts
 */

import { createHash } from "node:crypto";
import { keyIsSensitive } from "@repo/utils/sensitive-keys";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const table = vi.hoisted(() => {
	interface Store {
		rows: Row[];
		audit: Row[];
		users: Row[];
	}
	const committed: Store = { rows: [], audit: [], users: [] };
	const state = { committed, nextId: 1, transactions: 0 };
	// The store the model method being called works on: the committed one,
	// unless a transaction client is calling (set for the synchronous start
	// of the call, which is where every fake method reads it).
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
				// The one operator the receipt lookup uses: a JSON path.
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

	function pick(row: Row | undefined, select?: Record<string, boolean>) {
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
		select?: Record<string, boolean>;
	};

	const projectContext = {
		findFirst: vi.fn(async (args: FindArgs) => {
			const store = current;
			return pick(
				store.rows.find((row) => matches(row, args.where)),
				args.select,
			);
		}),
		updateMany: vi.fn(
			async (args: {
				where: Record<string, unknown>;
				data: Record<string, unknown>;
			}) => {
				const store = current;
				const hit = store.rows.filter((row) =>
					matches(row, args.where),
				);
				for (const row of hit) {
					Object.assign(row, args.data);
				}
				return { count: hit.length };
			},
		),
		deleteMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
			const store = current;
			const before = store.rows.length;
			store.rows = store.rows.filter((row) => !matches(row, args.where));
			return { count: before - store.rows.length };
		}),
	};

	const auditLog = {
		create: vi.fn(async (args: { data: Record<string, unknown> }) => {
			const store = current;
			const { user, organization, project, ...scalars } = args.data as {
				user?: { connect: { id: string } };
				organization?: { connect: { id: string } };
				project?: { connect: { id: string } };
			} & Row;
			// A nested connect to a missing user fails as Prisma's does.
			if (
				user &&
				!store.users.some(
					(candidate) => candidate.id === user.connect.id,
				)
			) {
				throw new Error(
					"No 'User' record(s) found for nested connect on 'AuditLog'",
				);
			}
			const row: Row = {
				id: `audit-${state.nextId++}`,
				...scalars,
				userId: user?.connect.id ?? null,
				organizationId: organization?.connect.id ?? null,
				projectId: project?.connect.id ?? null,
			};
			store.audit.push(row);
			return row;
		}),
		findFirst: vi.fn(async (args: FindArgs) => {
			const store = current;
			return pick(
				store.audit.find((row) => matches(row, args.where)),
				args.select,
			);
		}),
	};

	const user = {
		findUnique: vi.fn(async (args: FindArgs) => {
			const store = current;
			return pick(
				store.users.find((row) => matches(row, args.where)),
				args.select,
			);
		}),
	};

	const models = { projectContext, auditLog, user } as const;

	/** A client whose every model method works on `store`. */
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
			state.transactions++;
			const work: Store = {
				rows: committed.rows.map((row) => ({ ...row })),
				audit: committed.audit.map((row) => ({ ...row })),
				users: committed.users,
			};
			// Throws: nothing of `work` is committed.
			const result = await callback(clientOn(work));
			committed.rows = work.rows;
			committed.audit = work.audit;
			return result;
		},
	);

	return {
		state,
		committed,
		projectContext,
		auditLog,
		user,
		db: { ...models, $transaction },
	};
});

vi.mock("../prisma/client", () => ({
	db: table.db,
	Prisma: { sql: vi.fn(), join: vi.fn() },
}));

import {
	claimSyncedContextRowForDeletion,
	deleteClaimedSyncedContextRow,
	findSyncedContextIdAtPath,
} from "../prisma/queries/projects/contexts";
import {
	buildSyncedContextDeleteAuditEvent,
	SYNCED_CONTEXT_DELETE_AUDIT_ACTION,
} from "../prisma/queries/projects/synced-context-delete-audit";

const sha = (content: string) =>
	createHash("sha256").update(content, "utf8").digest("hex");

const V1 = "# Glossary\n\nA tenant is an organization.\n";
const V2 = "# Glossary\n\nA tenant is an organization, always.\n";
const PATH = "docs/glossary.md";
const EMBEDDED_AT = new Date("2026-09-20T09:02:00Z");

function seed(overrides: Row = {}): Row {
	const row: Row = {
		id: `ctx-seed-${table.state.nextId++}`,
		projectId: "proj-1",
		type: "TEXT",
		content: V1,
		sourcePath: PATH,
		contentHash: sha(V1),
		contentUpdatedAt: new Date("2026-09-20T09:00:00Z"),
		contentUpdatedByUserId: "user-1",
		metadata: { title: "glossary.md", sourcePath: PATH },
		sourceTitle: null,
		originalFilename: null,
		qdrantId: "11111111-2222-3333-4444-555555555555",
		embeddedAt: EMBEDDED_AT,
		userId: "user-1",
		organizationId: "org-1",
		updatedAt: new Date("2026-09-20T09:01:00Z"),
		...overrides,
	};
	table.committed.rows.push(row);
	return row;
}

const TARGET = {
	projectId: "proj-1",
	sourcePath: PATH,
	expectedContentHash: sha(V1),
	userId: "user-2",
	organizationId: "org-1" as string | null,
};

function claim(overrides: Partial<typeof TARGET> = {}) {
	return claimSyncedContextRowForDeletion({ ...TARGET, ...overrides });
}

/** The delete's operation id: a UUID the API generates per request. */
const OPERATION_ID = "0b6f1a52-9d3e-4c1a-8f4e-2d7c5b9a3e10";
/** Another request's operation id, deleting the same row at the same time. */
const OTHER_OPERATION_ID = "7c2e4d91-5a8b-4f3c-9e1d-6b0a2f8c4d57";

/** The request the delete came from, as it crosses Temporal history. */
const AUDIT_CONTEXT = {
	via: "v1-api" as const,
	impersonatedById: null,
	ipAddress: "203.0.113.7",
	userAgent: "fabric-cli/1.0",
	requestId: "req-1",
	sessionId: null,
	correlationId: "corr-1",
};

function removeRow(
	contextId: string,
	overrides: Partial<typeof TARGET> & { operationId?: string } = {},
) {
	return deleteClaimedSyncedContextRow({
		...TARGET,
		operationId: OPERATION_ID,
		title: "glossary.md",
		audit: AUDIT_CONTEXT,
		...overrides,
		contextId,
	});
}

/** The audit rows this operation wrote. */
function receipts(operationId = OPERATION_ID) {
	return table.committed.audit.filter(
		(row) =>
			(row.metadata as { operationId?: unknown } | null)?.operationId ===
			operationId,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	table.committed.rows = [];
	table.committed.audit = [];
	table.committed.users = [
		{ id: "user-2", email: "dev@example.com", name: "Example Dev" },
	];
	table.state.nextId = 1;
	table.state.transactions = 0;
});

describe("findSyncedContextIdAtPath", () => {
	it("names the synced row at the path under the tenant arm", async () => {
		const row = seed();

		expect(
			await findSyncedContextIdAtPath({
				projectId: "proj-1",
				sourcePath: PATH,
				userId: "user-2",
				organizationId: "org-1",
			}),
		).toBe(row.id);
		expect(table.projectContext.findFirst.mock.calls[0][0].where).toEqual({
			projectId: "proj-1",
			sourcePath: PATH,
			organizationId: "org-1",
		});
	});

	it("is null for an empty path, another project, another organization or a manual row", async () => {
		seed({ projectId: "proj-2" });
		seed({ organizationId: "org-2" });
		seed({ sourcePath: null, type: "FILE" });

		expect(
			await findSyncedContextIdAtPath({
				projectId: "proj-1",
				sourcePath: PATH,
				userId: "user-2",
				organizationId: "org-1",
			}),
		).toBeNull();
	});
});

describe("claimSyncedContextRowForDeletion — the named version", () => {
	it("claims the row holding the named version by marking it unindexed, and hands back what the cleanup needs", async () => {
		const row = seed();

		const result = await claim();

		expect(result).toMatchObject({
			status: "claimed",
			context: {
				id: row.id,
				type: "TEXT",
				sourcePath: PATH,
				contentHash: sha(V1),
				qdrantId: row.qdrantId,
			},
		});
		if (result.status === "claimed") {
			// The body never rides along.
			expect(result.context).not.toHaveProperty("content");
		}
		expect(row.embeddedAt).toBeNull();
		// Claimed, not deleted.
		expect(table.committed.rows).toHaveLength(1);
		expect(table.projectContext.deleteMany).not.toHaveBeenCalled();
	});

	it("keys the claim on the row, the project, the tenant, the path and the named hash, and writes only embeddedAt", async () => {
		const row = seed();

		await claim();

		expect(table.projectContext.updateMany).toHaveBeenCalledTimes(1);
		expect(table.projectContext.updateMany.mock.calls[0][0]).toEqual({
			where: {
				id: row.id,
				projectId: "proj-1",
				organizationId: "org-1",
				sourcePath: PATH,
				contentHash: sha(V1),
			},
			data: { embeddedAt: null },
		});
	});

	it("claims again, harmlessly, when repeated", async () => {
		const row = seed();

		const first = await claim();
		const second = await claim();

		expect(first.status).toBe("claimed");
		expect(second).toMatchObject({
			status: "claimed",
			context: { id: row.id },
		});
		expect(row.embeddedAt).toBeNull();
		expect(table.committed.rows).toHaveLength(1);
	});

	it("is a conflict naming the stored version, and changes nothing, when the path holds another version", async () => {
		const row = seed({
			content: V2,
			contentHash: sha(V2),
			contentUpdatedByUserId: "user-3",
		});

		const result = await claim();

		expect(result).toEqual({
			status: "conflict",
			current: {
				contextId: row.id,
				contentHash: sha(V2),
				contentUpdatedAt: new Date("2026-09-20T09:00:00Z"),
				contentUpdatedByUserId: "user-3",
			},
		});
		expect(table.projectContext.updateMany).not.toHaveBeenCalled();
		expect(row.embeddedAt).toBe(EMBEDDED_AT);
	});

	it("is a conflict for a stored version with no hash, which no caller can name", async () => {
		seed({ contentHash: null });

		const result = await claim();

		expect(result.status).toBe("conflict");
		expect(table.projectContext.updateMany).not.toHaveBeenCalled();
	});

	it("is absent when no row is at the path, so a retry after a lost response is not an error", async () => {
		const result = await claim();

		expect(result).toEqual({ status: "absent" });
		expect(table.projectContext.updateMany).not.toHaveBeenCalled();
	});

	it("never claims a row added in the Context tab, which has no path, even when it holds the named content", async () => {
		const manual = seed({ sourcePath: null, type: "FILE" });

		const result = await claim();

		expect(result).toEqual({ status: "absent" });
		expect(table.projectContext.updateMany).not.toHaveBeenCalled();
		expect(manual.embeddedAt).toBe(EMBEDDED_AT);
	});

	it("answers from a re-read when the row changed between the read and the claim", async () => {
		const row = seed();
		table.projectContext.updateMany.mockImplementationOnce(async () => {
			Object.assign(row, {
				content: V2,
				contentHash: sha(V2),
				contentUpdatedByUserId: "user-3",
			});
			return { count: 0 };
		});

		const result = await claim();

		expect(result).toMatchObject({
			status: "conflict",
			current: { contextId: row.id, contentHash: sha(V2) },
		});
		expect(row.embeddedAt).toBe(EMBEDDED_AT);
	});
});

describe("deleteClaimedSyncedContextRow — after the index cleanup", () => {
	it("deletes the claimed row, keyed on the claim's guard", async () => {
		const row = seed({ embeddedAt: null });

		const result = await removeRow(row.id as string);

		expect(result).toEqual({ status: "deleted" });
		expect(table.committed.rows).toHaveLength(0);
		expect(table.projectContext.deleteMany.mock.calls[0][0].where).toEqual({
			id: row.id,
			projectId: "proj-1",
			organizationId: "org-1",
			sourcePath: PATH,
			contentHash: sha(V1),
		});
	});

	it("never deletes a version pushed after the claim: a conflict that hands back the surviving row", async () => {
		const row = seed({ embeddedAt: null });
		Object.assign(row, {
			content: V2,
			contentHash: sha(V2),
			contentUpdatedByUserId: "user-3",
		});

		const result = await removeRow(row.id as string);

		expect(result).toMatchObject({
			status: "conflict",
			current: { contextId: row.id, contentHash: sha(V2) },
			reindex: { id: row.id, sourcePath: PATH, contentHash: sha(V2) },
		});
		expect(table.committed.rows).toHaveLength(1);
	});

	it("is absent, handing back the row, when it was moved to another path after the claim", async () => {
		const row = seed({ embeddedAt: null });
		row.sourcePath = "docs/renamed.md";

		const result = await removeRow(row.id as string);

		expect(result).toMatchObject({
			status: "absent",
			reindex: { id: row.id, sourcePath: "docs/renamed.md" },
		});
		expect(table.committed.rows).toHaveLength(1);
	});

	it("is a conflict naming the new occupant, and hands back the moved row, when another row took the path", async () => {
		const row = seed({ embeddedAt: null });
		row.sourcePath = "docs/renamed.md";
		const newcomer = seed({ content: V2, contentHash: sha(V2) });

		const result = await removeRow(row.id as string);

		expect(result).toMatchObject({
			status: "conflict",
			current: { contextId: newcomer.id, contentHash: sha(V2) },
			reindex: { id: row.id, sourcePath: "docs/renamed.md" },
		});
		expect(table.committed.rows).toHaveLength(2);
	});
});

describe("deleteClaimedSyncedContextRow — the audit row is the delete's receipt", () => {
	it("writes the audit row in the same transaction as the delete, keyed by the operation id, never with the content", async () => {
		const row = seed({ embeddedAt: null });

		expect(await removeRow(row.id as string)).toEqual({
			status: "deleted",
		});

		expect(table.db.$transaction).toHaveBeenCalledTimes(1);
		expect(table.committed.rows).toHaveLength(0);
		expect(table.committed.audit).toHaveLength(1);
		expect(table.committed.audit[0]).toMatchObject({
			action: "project.context_source.synced_file_deleted",
			category: "project",
			severity: "info",
			outcome: "success",
			// The actor is the caller, snapshotted from the user row at write
			// time: the workflow's history carries only the id.
			actorType: "user",
			userId: "user-2",
			actorEmailSnapshot: "dev@example.com",
			actorNameSnapshot: "Example Dev",
			impersonatedById: null,
			organizationId: "org-1",
			projectId: "proj-1",
			resourceType: "project_context",
			resourceId: row.id,
			resourceName: "glossary.md",
			ipAddress: "203.0.113.7",
			userAgent: "fabric-cli/1.0",
			requestId: "req-1",
			sessionId: null,
			durationMs: null,
			metadata: {
				sourcePath: PATH,
				contentHash: sha(V1),
				via: "v1-api",
				operationId: OPERATION_ID,
				correlationId: "corr-1",
			},
		});
		expect(JSON.stringify(table.committed.audit[0])).not.toContain(
			"A tenant is an organization",
		);
	});

	it("rolls the delete back when the audit row cannot be written, so the row is never gone without its receipt", async () => {
		const row = seed({ embeddedAt: null });
		table.auditLog.create.mockRejectedValueOnce(
			new Error("audit_log insert failed"),
		);

		await expect(removeRow(row.id as string)).rejects.toThrow(
			"audit_log insert failed",
		);

		expect(table.projectContext.deleteMany).toHaveBeenCalledTimes(1);
		expect(table.committed.rows).toEqual([row]);
		expect(table.committed.audit).toHaveLength(0);
	});

	it("answers deleted, with no second audit row, when repeated after an attempt that committed", async () => {
		const row = seed({ embeddedAt: null });

		expect(await removeRow(row.id as string)).toEqual({
			status: "deleted",
		});
		expect(await removeRow(row.id as string)).toEqual({
			status: "deleted",
		});

		expect(table.committed.rows).toHaveLength(0);
		expect(receipts()).toHaveLength(1);
		expect(table.committed.audit).toHaveLength(1);
	});

	it("answers gone, recording nothing, when somebody else deleted the row after the claim", async () => {
		const row = seed({ embeddedAt: null });
		// Another caller's delete: the row goes, with no receipt of this
		// operation (the Context tab's delete, or another request's).
		table.committed.rows = [];

		expect(await removeRow(row.id as string)).toEqual({ status: "gone" });
		expect(table.committed.audit).toHaveLength(0);
	});

	it("answers gone when the only receipt for the row is another operation's", async () => {
		const row = seed({ embeddedAt: null });
		expect(
			await removeRow(row.id as string, {
				operationId: "other-operation",
			}),
		).toEqual({ status: "deleted" });

		expect(await removeRow(row.id as string)).toEqual({ status: "gone" });
		expect(receipts()).toHaveLength(0);
		expect(receipts("other-operation")).toHaveLength(1);
	});

	it("never counts a receipt under another organization or project as this operation's", async () => {
		const row = seed({ embeddedAt: null });
		table.committed.rows = [];
		const foreignReceipt = {
			id: "audit-foreign",
			action: SYNCED_CONTEXT_DELETE_AUDIT_ACTION,
			resourceType: "project_context",
			resourceId: row.id,
			userId: "user-2",
			metadata: { operationId: OPERATION_ID },
		};
		table.committed.audit.push(
			{ ...foreignReceipt, organizationId: "org-2", projectId: "proj-1" },
			{ ...foreignReceipt, organizationId: "org-1", projectId: "proj-2" },
		);

		expect(await removeRow(row.id as string)).toEqual({ status: "gone" });
		const lookup = table.auditLog.findFirst.mock.calls[0]?.[0]?.where;
		expect(lookup).toMatchObject({
			action: "project.context_source.synced_file_deleted",
			organizationId: "org-1",
			projectId: "proj-1",
			resourceId: row.id,
			metadata: { path: ["operationId"], equals: OPERATION_ID },
		});
		expect(lookup).not.toHaveProperty("OR");
	});

	it("serializes two concurrent deletes of the same version, each with its own operation id: one deletes and records, the other finds no receipt of its own and is gone", async () => {
		const row = seed();

		// Both requests claim before either deletes: the second claim matches
		// the same row and writes the same null.
		expect((await claim()).status).toBe("claimed");
		expect((await claim()).status).toBe("claimed");
		expect(row.embeddedAt).toBeNull();

		// (Each removes the points in between; that delete is idempotent.)
		const first = await removeRow(row.id as string);
		const second = await removeRow(row.id as string, {
			operationId: OTHER_OPERATION_ID,
		});

		expect(first).toEqual({ status: "deleted" });
		// The activity answers `gone` as `absent`: this request deleted
		// nothing, and records nothing.
		expect(second).toEqual({ status: "gone" });
		expect(table.committed.rows).toHaveLength(0);
		expect(table.committed.audit).toHaveLength(1);
		expect(receipts()).toHaveLength(1);
		expect(receipts(OTHER_OPERATION_ID)).toHaveLength(0);
	});

	it("records nothing when the row survived: changed or moved after the claim", async () => {
		const changed = seed({ embeddedAt: null });
		Object.assign(changed, { content: V2, contentHash: sha(V2) });
		expect((await removeRow(changed.id as string)).status).toBe("conflict");

		table.committed.rows = [];
		const moved = seed({ embeddedAt: null });
		moved.sourcePath = "docs/renamed.md";
		expect((await removeRow(moved.id as string)).status).toBe("absent");

		expect(table.committed.audit).toHaveLength(0);
	});

	it("still records the delete when the caller's user row is gone, naming no user rather than failing forever", async () => {
		const row = seed({ embeddedAt: null });
		table.committed.users = [];

		expect(await removeRow(row.id as string)).toEqual({
			status: "deleted",
		});
		expect(table.committed.audit[0]).toMatchObject({
			actorType: "user",
			userId: null,
			actorEmailSnapshot: null,
			actorNameSnapshot: null,
			metadata: { operationId: OPERATION_ID, via: "v1-api" },
		});
	});
});

describe("buildSyncedContextDeleteAuditEvent", () => {
	it("records the path, the deleted version's hash, the surface and the operation id — never the content", () => {
		const event = buildSyncedContextDeleteAuditEvent({
			organizationId: "org-1",
			projectId: "proj-1",
			contextId: "ctx-1",
			title: "glossary.md",
			sourcePath: PATH,
			contentHash: sha(V1),
			operationId: OPERATION_ID,
			actor: {
				userId: "user-2",
				emailSnapshot: "dev@example.com",
				nameSnapshot: "Example Dev",
			},
			audit: { ...AUDIT_CONTEXT, via: "web", sessionId: "sess-1" },
		});

		expect(SYNCED_CONTEXT_DELETE_AUDIT_ACTION).toBe(
			"project.context_source.synced_file_deleted",
		);
		expect(event).toEqual({
			action: "project.context_source.synced_file_deleted",
			category: "project",
			organizationId: "org-1",
			projectId: "proj-1",
			actor: {
				type: "user",
				userId: "user-2",
				emailSnapshot: "dev@example.com",
				nameSnapshot: "Example Dev",
				impersonatedById: null,
			},
			resource: {
				type: "project_context",
				id: "ctx-1",
				name: "glossary.md",
			},
			metadata: {
				sourcePath: PATH,
				contentHash: sha(V1),
				via: "web",
				operationId: OPERATION_ID,
			},
			ipAddress: "203.0.113.7",
			userAgent: "fabric-cli/1.0",
			requestId: "req-1",
			sessionId: "sess-1",
			correlationId: "corr-1",
		});
		expect(event.metadata).not.toHaveProperty("content");
	});

	it("uses no metadata key the shared redactor would blank out", () => {
		const event = buildSyncedContextDeleteAuditEvent({
			organizationId: "org-1",
			projectId: "proj-1",
			contextId: "ctx-1",
			title: "glossary.md",
			sourcePath: PATH,
			contentHash: sha(V1),
			operationId: OPERATION_ID,
			actor: {
				userId: "user-2",
				emailSnapshot: null,
				nameSnapshot: null,
			},
			audit: AUDIT_CONTEXT,
		});

		expect(
			Object.keys(event.metadata ?? {}).filter((key) =>
				keyIsSensitive(key),
			),
		).toEqual([]);
		expect(JSON.stringify(event)).not.toMatch(/"content"\s*:/);
	});
});

describe("the claim and the delete — tenant scoping", () => {
	it("reads under the exclusive organization arm, never an OR", async () => {
		const row = seed();

		await claim();
		await removeRow(row.id as string);

		for (const call of table.projectContext.findFirst.mock.calls) {
			expect(call[0].where).toMatchObject({ organizationId: "org-1" });
			expect(call[0].where).not.toHaveProperty("OR");
			expect(call[0].where).not.toHaveProperty("userId");
		}
	});

	it("never claims, deletes or names another project's row at the same path", async () => {
		const other = seed({ projectId: "proj-2" });

		expect(await claim()).toEqual({ status: "absent" });
		expect(await removeRow(other.id as string)).toEqual({ status: "gone" });
		expect(table.committed.rows).toEqual([other]);
		expect(other.embeddedAt).toBe(EMBEDDED_AT);
	});

	it("never claims, deletes or names another organization's row", async () => {
		const foreign = seed({ organizationId: "org-2" });

		expect(await claim()).toEqual({ status: "absent" });
		expect(await removeRow(foreign.id as string)).toEqual({
			status: "gone",
		});
		expect(table.committed.rows).toEqual([foreign]);
		expect(foreign.embeddedAt).toBe(EMBEDDED_AT);
	});

	it("never touches a personal row from the organization arm, nor an organization row from the personal arm", async () => {
		const personal = seed({ organizationId: null, userId: "user-2" });

		expect(await claim()).toEqual({ status: "absent" });
		expect(await removeRow(personal.id as string)).toEqual({
			status: "gone",
		});
		expect(table.committed.rows).toEqual([personal]);

		table.committed.rows = [];
		const orgRow = seed();
		expect(await claim({ organizationId: null })).toEqual({
			status: "absent",
		});
		expect(
			await removeRow(orgRow.id as string, { organizationId: null }),
		).toEqual({ status: "gone" });
		expect(table.committed.rows).toEqual([orgRow]);
		expect(orgRow.embeddedAt).toBe(EMBEDDED_AT);
	});
});
