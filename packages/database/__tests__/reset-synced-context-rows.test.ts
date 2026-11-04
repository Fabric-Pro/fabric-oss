/**
 * `resetSyncedContextRows` — the Living Memory reset: every synced knowledge
 * file of one project deleted in one transaction.
 *
 * What this pins:
 *  - only rows WITH a `sourcePath` are deleted (a source added in the
 *    Context tab stays), only in the named project, and only under the
 *    exclusive tenant arm: another organization's rows and a personal row
 *    in the same project id are never touched;
 *  - the delete, ONE vector-cleanup record holding every deleted id, and ONE
 *    audit row with the count commit together;
 *  - a configured repository sync refuses the reset, naming the repository
 *    and branch, and changes nothing;
 *  - a row a sync adopted is never deleted nor queued for cleanup;
 *  - a second reset deletes nothing, queues nothing and records nothing.
 *
 * The client is an in-memory table; `$transaction` runs its callback against
 * a working copy committed only when the callback returns.
 *
 * Run with: pnpm --filter @repo/database test -- __tests__/reset-synced-context-rows.test.ts
 */

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

	/** Equality, plus the two operators the reset uses: `not: null` and `in`. */
	function matches(row: Row, where: Record<string, unknown>): boolean {
		return Object.entries(where).every(([key, value]) => {
			const actual = row[key] ?? null;
			if (value !== null && typeof value === "object") {
				const filter = value as { not?: unknown; in?: unknown };
				if ("not" in filter && filter.not === null) {
					return actual !== null;
				}
				if (Array.isArray(filter.in)) {
					return filter.in.includes(actual);
				}
				throw new Error(`fake table: unsupported operator on ${key}`);
			}
			return actual === value;
		});
	}

	function pick(row: Row, select?: Record<string, unknown>) {
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
		findMany: vi.fn(async (args: FindArgs) =>
			current.rows
				.filter((row) => matches(row, args.where))
				.map((row) => pick(row, args.select)),
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
	};

	const user = {
		findUnique: vi.fn(async (args: FindArgs) => {
			const found = current.users.find((row) => matches(row, args.where));
			return found ? pick(found, args.select) : null;
		}),
	};

	const models = {
		projectContext,
		projectContextPendingVectorCleanup,
		projectContextRepositorySync,
		auditLog,
		user,
	} as const;

	function clientOn(store: Store) {
		const client: Record<string, unknown> = Object.fromEntries(
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
		// Lock 1 by project (`lockContextRepositorySyncByProject`): its
		// parameters are the project, then the organization.
		client.$queryRaw = async (
			_strings: TemplateStringsArray,
			projectId: unknown,
			organizationId: unknown,
		) =>
			store.syncs.filter(
				(sync) =>
					sync.projectId === projectId &&
					sync.organizationId === organizationId,
			);
		return client;
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

	return { state, committed, db: { ...models, $transaction } };
});

vi.mock("../prisma/client", () => ({
	db: table.db,
	Prisma: { sql: vi.fn(), join: vi.fn() },
}));

import {
	resetSyncedContextRows,
	SYNCED_CONTEXT_RESET_AUDIT_ACTION,
} from "../prisma/queries/projects/reset-synced-contexts";

const AUDIT = {
	via: "web" as const,
	impersonatedById: null,
	ipAddress: "203.0.113.7",
	userAgent: "Mozilla/5.0",
	requestId: "req-1",
	sessionId: "sess-1",
	correlationId: "corr-1",
};

function synced(id: string, overrides: Row = {}): Row {
	return {
		id,
		projectId: "proj-1",
		organizationId: "org-1",
		userId: "user-9",
		sourcePath: `docs/${id}.md`,
		repositorySyncId: null,
		...overrides,
	};
}

function reset(
	overrides: Partial<Parameters<typeof resetSyncedContextRows>[0]> = {},
) {
	return resetSyncedContextRows({
		projectId: "proj-1",
		organizationId: "org-1",
		userId: "user-1",
		operationId: "op-1",
		audit: AUDIT,
		...overrides,
	});
}

beforeEach(() => {
	table.committed.rows = [];
	table.committed.audit = [];
	table.committed.cleanups = [];
	table.committed.users = [
		{ id: "user-1", email: "dev@example.com", name: "Example Dev" },
	];
	table.committed.syncs = [];
	table.state.nextId = 1;
});

describe("resetSyncedContextRows", () => {
	it("deletes every synced row of the project and tenant, and nothing else", async () => {
		table.committed.rows = [
			synced("a"),
			synced("b"),
			// A source added in the Context tab: no path, never part of a reset.
			synced("manual", { sourcePath: null }),
			// Another project in the same organization.
			synced("other-project", { projectId: "proj-2" }),
			// Another tenant under the same project id.
			synced("other-org", { organizationId: "org-2" }),
		];

		const result = await reset();

		expect(result).toEqual({
			status: "reset",
			deletedIds: ["a", "b"],
			cleanupId: "cleanup-1",
		});
		expect(table.committed.rows.map((row) => row.id).sort()).toEqual([
			"manual",
			"other-org",
			"other-project",
		]);
	});

	it("queues ONE vector cleanup with every deleted id, under the organization", async () => {
		table.committed.rows = [synced("a"), synced("b")];

		await reset();

		expect(table.committed.cleanups).toEqual([
			expect.objectContaining({
				projectId: "proj-1",
				contextIds: ["a", "b"],
				organizationId: "org-1",
			}),
		]);
	});

	it("writes one audit row with who, the scope and the count", async () => {
		table.committed.rows = [synced("a"), synced("b")];

		await reset();

		expect(table.committed.audit).toHaveLength(1);
		expect(table.committed.audit[0]).toMatchObject({
			action: SYNCED_CONTEXT_RESET_AUDIT_ACTION,
			userId: "user-1",
			organizationId: "org-1",
			projectId: "proj-1",
			metadata: expect.objectContaining({
				scope: "project",
				deletedCount: 2,
				via: "web",
				operationId: "op-1",
			}),
		});
	});

	it("is idempotent: a second reset deletes, queues and records nothing", async () => {
		table.committed.rows = [synced("a")];
		await reset();

		const again = await reset({ operationId: "op-2" });

		expect(again).toEqual({
			status: "reset",
			deletedIds: [],
			cleanupId: null,
		});
		expect(table.committed.cleanups).toHaveLength(1);
		expect(table.committed.audit).toHaveLength(1);
	});

	it("refuses while a repository sync is configured, and changes nothing", async () => {
		table.committed.rows = [synced("a")];
		table.committed.syncs = [
			{
				id: "sync-1",
				projectId: "proj-1",
				organizationId: "org-1",
				ref: "main",
				repositoryOwner: "example-org",
				repositoryName: "notes",
			},
		];

		const result = await reset();

		expect(result).toEqual({
			status: "repository-sync-active",
			sync: { repository: "example-org/notes", ref: "main" },
		});
		expect(table.committed.rows).toHaveLength(1);
		expect(table.committed.cleanups).toHaveLength(0);
		expect(table.committed.audit).toHaveLength(0);
	});

	it("never deletes or queues a row a repository sync owns", async () => {
		table.committed.rows = [
			synced("a"),
			synced("managed", { repositorySyncId: "sync-gone" }),
		];

		const result = await reset();

		expect(result).toMatchObject({ deletedIds: ["a"] });
		expect(table.committed.rows.map((row) => row.id)).toEqual(["managed"]);
		expect(table.committed.cleanups[0]).toMatchObject({
			contextIds: ["a"],
		});
	});

	it("scopes the personal arm by its user, never OR-ed with an organization", async () => {
		table.committed.rows = [
			synced("mine", { organizationId: null, userId: "user-1" }),
			synced("someone-else", { organizationId: null, userId: "user-2" }),
			synced("org-row"),
		];

		const result = await reset({ organizationId: null });

		expect(result).toMatchObject({ deletedIds: ["mine"] });
		expect(table.committed.rows.map((row) => row.id).sort()).toEqual([
			"org-row",
			"someone-else",
		]);
	});
});
