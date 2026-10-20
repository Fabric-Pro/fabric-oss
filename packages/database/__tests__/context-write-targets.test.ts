/**
 * Living Memory write folders — the database layer (ADR-022): create,
 * update, delete and list.
 *
 * What this pins:
 *  - every change locks the sync's configuration row FIRST, in the same
 *    transaction as its reads and its write, and answers `not-configured`
 *    when there is no sync;
 *  - `decide` is handed the sync as the lock read it, the other targets, and
 *    the instruction roots of the project's instructions sync only when it
 *    reads the same repository integration; a refusal writes nothing;
 *  - DIRECT_PUSH records who enabled it and when (the lock's clock), and leaving
 *    DIRECT_PUSH clears both; a DIRECT_PUSH target that keeps its folder keeps
 *    its original approval, one re-pointed at another folder is approved
 *    afresh;
 *  - every update bumps `version` and names the caller the last editor;
 *  - delete removes the folder and answers what it was.
 *
 * The client is a small in-memory store: `$transaction` runs the callback with
 * a transaction client that logs the lock and each operation in order.
 *
 * Run with: pnpm --filter @repo/database test -- __tests__/context-write-targets.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const h = vi.hoisted(() => {
	const state = {
		sync: null as Row | null,
		targets: [] as Row[],
		instructionSyncs: [] as Row[],
		log: [] as string[],
		reconcileCalls: [] as Array<{ logAtCall: string[]; input: unknown }>,
		reconcileResult: {
			excluded: 0,
			included: 0,
			cleanups: [] as unknown[],
		},
		transactionOptions: [] as unknown[],
		nextId: 1,
	};
	const matches = (row: Row, where: Row = {}) =>
		Object.entries(where).every(([key, value]) => row[key] === value);
	const clone = <T>(value: T): T => structuredClone(value);

	const targetTable = {
		findMany: vi.fn(async ({ where }: { where: Row }) => {
			state.log.push("targets.findMany");
			return state.targets
				.filter((row) => matches(row, where))
				.sort((a, b) =>
					String(a.folder).localeCompare(String(b.folder)),
				)
				.map(clone);
		}),
		findFirst: vi.fn(async ({ where }: { where: Row }) => {
			state.log.push("targets.findFirst");
			const row = state.targets.find((candidate) =>
				matches(candidate, where),
			);
			return row ? clone(row) : null;
		}),
		create: vi.fn(async ({ data }: { data: Row }) => {
			state.log.push("targets.create");
			const row: Row = {
				id: `target-${state.nextId++}`,
				version: 1,
				createdAt: new Date("2026-10-15T00:00:00.000Z"),
				updatedAt: new Date("2026-10-15T00:00:00.000Z"),
				...data,
			};
			state.targets.push(row);
			return clone(row);
		}),
		update: vi.fn(
			async ({ where, data }: { where: { id: string }; data: Row }) => {
				state.log.push("targets.update");
				const row = state.targets.find((r) => r.id === where.id);
				if (!row) {
					throw new Error("fake store: no such target");
				}
				for (const [key, value] of Object.entries(data)) {
					const increment = (value as { increment?: number } | null)
						?.increment;
					row[key] =
						typeof increment === "number"
							? Number(row[key]) + increment
							: value;
				}
				return clone(row);
			},
		),
		delete: vi.fn(async ({ where }: { where: { id: string } }) => {
			state.log.push("targets.delete");
			state.targets = state.targets.filter((r) => r.id !== where.id);
		}),
	};
	const tx = {
		$queryRaw: vi.fn(async () => {
			state.log.push("lock");
			return state.sync ? [clone(state.sync)] : [];
		}),
		projectContextWriteTarget: targetTable,
		projectInstructionRepositorySync: {
			findMany: vi.fn(async ({ where }: { where: Row }) => {
				state.log.push("instructionSync.findMany");
				return state.instructionSyncs
					.filter((row) => matches(row, where))
					.map(clone);
			}),
		},
	};
	const db = {
		$transaction: vi.fn(
			async (
				fn: (client: typeof tx) => Promise<unknown>,
				options: unknown,
			) => {
				state.transactionOptions.push(options);
				return fn(tx);
			},
		),
		projectContextWriteTarget: targetTable,
	};
	return { state, db, tx };
});

vi.mock("../prisma/client", () => ({
	db: h.db,
	Prisma: { sql: vi.fn(), join: vi.fn(), DbNull: "DbNull" },
}));
vi.mock("../prisma/queries/audit-log", () => ({ recordAuditTx: vi.fn() }));
vi.mock("../prisma/queries/projects/context-index-mode", () => ({
	reconcileContextIndexing: vi.fn(async (_tx: unknown, input: unknown) => {
		h.state.reconcileCalls.push({
			logAtCall: [...h.state.log],
			input,
		});
		return h.state.reconcileResult;
	}),
}));
vi.mock("../prisma/queries/projects/projects", () => ({
	canCreateProjectInstructions: vi.fn(),
}));

import { CONTEXT_SYNC_TRANSACTION_TIMEOUT_MS } from "../prisma/queries/projects/context-repository-sync";
import {
	type ContextWriteTargetDecision,
	type ContextWriteTargetState,
	createContextWriteTarget,
	deleteContextWriteTarget,
	listContextWriteTargets,
	updateContextWriteTarget,
} from "../prisma/queries/projects/context-write-targets";

const scope = { projectId: "proj-1", organizationId: "org-1" };
const LOCK_CLOCK = new Date("2026-10-15T09:30:00.000Z");

const lockedSync = {
	id: "sync-1",
	projectId: "proj-1",
	organizationId: "org-1",
	userId: "user-delegate",
	repositoryIntegrationId: "int-1",
	ref: "main",
	paths: ["docs"],
	excludedPaths: [],
	now: LOCK_CLOCK,
};

function target(overrides: Row = {}): Row {
	return {
		id: "target-existing",
		syncId: "sync-1",
		projectId: "proj-1",
		organizationId: "org-1",
		userId: "user-earlier",
		folder: "docs/agents-notes",
		mode: "PULL_REQUEST",
		indexMode: "INDEXED",
		directPushEnabledById: null,
		directPushEnabledAt: null,
		version: 3,
		createdAt: new Date("2026-10-01T00:00:00.000Z"),
		updatedAt: new Date("2026-10-02T00:00:00.000Z"),
		...overrides,
	};
}

const accept = (
	folder: string,
	mode: "PULL_REQUEST" | "DIRECT_PUSH",
	indexMode?: "INDEXED" | "STORE_ONLY",
): ContextWriteTargetDecision<string> => ({
	accept: true,
	folder,
	mode,
	...(indexMode ? { indexMode } : {}),
});

beforeEach(() => {
	h.state.sync = { ...lockedSync };
	h.state.targets = [];
	h.state.instructionSyncs = [];
	h.state.log = [];
	h.state.transactionOptions = [];
	h.state.nextId = 1;
	h.state.reconcileCalls = [];
	h.state.reconcileResult = { excluded: 0, included: 0, cleanups: [] };
	vi.clearAllMocks();
});

describe("createContextWriteTarget", () => {
	it("locks the sync before it reads anything, in one bounded transaction", async () => {
		await createContextWriteTarget({ ...scope, userId: "user-1" }, () =>
			accept("docs/notes", "PULL_REQUEST"),
		);

		expect(h.state.log[0]).toBe("lock");
		expect(h.state.log).toEqual([
			"lock",
			"targets.findMany",
			"instructionSync.findMany",
			"targets.create",
		]);
		expect(h.state.transactionOptions).toEqual([
			{ timeout: CONTEXT_SYNC_TRANSACTION_TIMEOUT_MS },
		]);
	});

	it("stores a PULL_REQUEST folder with no direct-push record", async () => {
		const result = await createContextWriteTarget(
			{ ...scope, userId: "user-1" },
			() => accept("docs/notes", "PULL_REQUEST"),
		);

		expect(result).toMatchObject({
			status: "created",
			target: {
				syncId: "sync-1",
				projectId: "proj-1",
				organizationId: "org-1",
				userId: "user-1",
				folder: "docs/notes",
				mode: "PULL_REQUEST",
				directPushEnabledById: null,
				directPushEnabledAt: null,
				version: 1,
			},
		});
	});

	it("records who enabled DIRECT_PUSH, and when, on the lock's clock", async () => {
		const result = await createContextWriteTarget(
			{ ...scope, userId: "user-admin" },
			() => accept("docs/notes", "DIRECT_PUSH"),
		);

		expect(result).toMatchObject({
			status: "created",
			target: {
				mode: "DIRECT_PUSH",
				directPushEnabledById: "user-admin",
				directPushEnabledAt: LOCK_CLOCK,
			},
		});
	});

	it("hands decide the sync as locked, every existing target and the same-integration instruction roots", async () => {
		h.state.targets = [
			target({ id: "t-a", folder: "docs/a" }),
			target({ id: "t-b", folder: "docs/b" }),
		];
		h.state.instructionSyncs = [
			{
				projectId: "proj-1",
				repositoryIntegrationId: "int-1",
				rootPath: "docs/rules",
			},
			{
				projectId: "proj-1",
				repositoryIntegrationId: "int-other",
				rootPath: "elsewhere",
			},
		];
		let seen: ContextWriteTargetState | null = null;

		await createContextWriteTarget(
			{ ...scope, userId: "user-1" },
			(state) => {
				seen = state;
				return accept("docs/c", "PULL_REQUEST");
			},
		);

		expect(seen).toMatchObject({
			sync: { id: "sync-1", paths: ["docs"], ref: "main" },
			instructionRoots: ["docs/rules"],
		});
		expect(
			(seen as unknown as ContextWriteTargetState).siblings.map(
				(sibling) => sibling.folder,
			),
		).toEqual(["docs/a", "docs/b"]);
	});

	it("writes nothing when decide refuses, and returns the refusal", async () => {
		const result = await createContextWriteTarget(
			{ ...scope, userId: "user-1" },
			() => ({ accept: false, refusal: "TARGET_OVERLAP" }),
		);

		expect(result).toEqual({
			status: "refused",
			refusal: "TARGET_OVERLAP",
		});
		expect(h.tx.projectContextWriteTarget.create).not.toHaveBeenCalled();
		expect(h.state.targets).toEqual([]);
	});

	it("answers not-configured without reading or writing when the project has no sync", async () => {
		h.state.sync = null;
		const decide = vi.fn();

		const result = await createContextWriteTarget(
			{ ...scope, userId: "user-1" },
			decide,
		);

		expect(result).toEqual({ status: "not-configured" });
		expect(decide).not.toHaveBeenCalled();
		expect(h.state.log).toEqual(["lock"]);
	});
});

describe("updateContextWriteTarget", () => {
	const input = { ...scope, userId: "user-1", targetId: "target-existing" };

	it("bumps the version and names the caller the last editor", async () => {
		h.state.targets = [target()];

		const result = await updateContextWriteTarget(input, () =>
			accept("docs/agents-notes", "PULL_REQUEST"),
		);

		expect(result).toMatchObject({
			status: "updated",
			target: { id: "target-existing", version: 4, userId: "user-1" },
			previous: { folder: "docs/agents-notes", mode: "PULL_REQUEST" },
		});
	});

	it("locks first and hands decide the stored target and its siblings", async () => {
		h.state.targets = [target(), target({ id: "t-b", folder: "docs/b" })];
		let seenState: ContextWriteTargetState | null = null;
		let seenCurrent: Row | null = null;

		await updateContextWriteTarget(input, (state, current) => {
			seenState = state;
			seenCurrent = current;
			return accept(current.folder, current.mode);
		});

		expect(h.state.log[0]).toBe("lock");
		expect(seenCurrent).toMatchObject({
			id: "target-existing",
			version: 3,
		});
		expect(
			(seenState as unknown as ContextWriteTargetState).siblings.map(
				(sibling) => sibling.id,
			),
		).toEqual(["t-b"]);
	});

	it("records the enabler when a target moves into DIRECT_PUSH", async () => {
		h.state.targets = [target()];

		const result = await updateContextWriteTarget(input, () =>
			accept("docs/agents-notes", "DIRECT_PUSH"),
		);

		expect(result).toMatchObject({
			status: "updated",
			target: {
				mode: "DIRECT_PUSH",
				directPushEnabledById: "user-1",
				directPushEnabledAt: LOCK_CLOCK,
			},
		});
	});

	it("clears the enabler when a target leaves DIRECT_PUSH", async () => {
		h.state.targets = [
			target({
				mode: "DIRECT_PUSH",
				directPushEnabledById: "user-admin",
				directPushEnabledAt: new Date("2026-10-10T00:00:00.000Z"),
			}),
		];

		const result = await updateContextWriteTarget(input, () =>
			accept("docs/agents-notes", "PULL_REQUEST"),
		);

		expect(result).toMatchObject({
			status: "updated",
			target: {
				mode: "PULL_REQUEST",
				directPushEnabledById: null,
				directPushEnabledAt: null,
			},
		});
	});

	it("keeps the original approval of a DIRECT_PUSH target that keeps its folder", async () => {
		const approvedAt = new Date("2026-10-10T00:00:00.000Z");
		h.state.targets = [
			target({
				mode: "DIRECT_PUSH",
				directPushEnabledById: "user-admin",
				directPushEnabledAt: approvedAt,
			}),
		];

		const result = await updateContextWriteTarget(input, () =>
			accept("docs/agents-notes", "DIRECT_PUSH"),
		);

		expect(result).toMatchObject({
			status: "updated",
			target: {
				directPushEnabledById: "user-admin",
				directPushEnabledAt: approvedAt,
				version: 4,
			},
		});
	});

	it("approves afresh a DIRECT_PUSH target pointed at another folder", async () => {
		h.state.targets = [
			target({
				mode: "DIRECT_PUSH",
				directPushEnabledById: "user-admin",
				directPushEnabledAt: new Date("2026-10-10T00:00:00.000Z"),
			}),
		];

		const result = await updateContextWriteTarget(input, () =>
			accept("docs/elsewhere", "DIRECT_PUSH"),
		);

		expect(result).toMatchObject({
			status: "updated",
			target: {
				folder: "docs/elsewhere",
				directPushEnabledById: "user-1",
				directPushEnabledAt: LOCK_CLOCK,
			},
		});
	});

	it("changes nothing when decide refuses", async () => {
		h.state.targets = [target()];

		const result = await updateContextWriteTarget(input, () => ({
			accept: false,
			refusal: "DIRECT_PUSH_REQUIRES_ADMIN",
		}));

		expect(result).toEqual({
			status: "refused",
			refusal: "DIRECT_PUSH_REQUIRES_ADMIN",
		});
		expect(h.tx.projectContextWriteTarget.update).not.toHaveBeenCalled();
		expect(h.state.targets[0]).toMatchObject({ version: 3 });
	});

	it("answers not-found for a target that is not the sync's, without calling decide", async () => {
		h.state.targets = [
			target({ id: "someone-elses", syncId: "sync-other" }),
		];
		const decide = vi.fn();

		const result = await updateContextWriteTarget(input, decide);

		expect(result).toEqual({ status: "not-found" });
		expect(decide).not.toHaveBeenCalled();
	});

	it("answers not-configured when the project has no sync", async () => {
		h.state.sync = null;

		const result = await updateContextWriteTarget(input, vi.fn());

		expect(result).toEqual({ status: "not-configured" });
	});
});

describe("deleteContextWriteTarget", () => {
	const input = { ...scope, targetId: "target-existing" };

	it("removes the folder under the lock and answers what it was", async () => {
		h.state.targets = [
			target({
				mode: "DIRECT_PUSH",
				directPushEnabledById: "user-admin",
			}),
		];

		const result = await deleteContextWriteTarget(input);

		expect(result).toMatchObject({
			status: "deleted",
			target: { id: "target-existing", folder: "docs/agents-notes" },
		});
		expect(h.state.targets).toEqual([]);
		expect(h.state.log).toEqual([
			"lock",
			"targets.findFirst",
			"targets.delete",
		]);
	});

	it("answers not-found for a target that is not the sync's", async () => {
		h.state.targets = [target({ syncId: "sync-other" })];

		const result = await deleteContextWriteTarget(input);

		expect(result).toEqual({ status: "not-found" });
		expect(h.tx.projectContextWriteTarget.delete).not.toHaveBeenCalled();
	});

	it("answers not-configured when the project has no sync", async () => {
		h.state.sync = null;

		const result = await deleteContextWriteTarget(input);

		expect(result).toEqual({ status: "not-configured" });
	});
});

describe("indexing choice (Index for AI search / Store only)", () => {
	const createInput = { ...scope, userId: "user-1" };
	const updateInput = { ...createInput, targetId: "target-existing" };

	it("stores a new folder as INDEXED unless the decision says otherwise", async () => {
		const result = await createContextWriteTarget(createInput, () =>
			accept("docs/notes", "PULL_REQUEST"),
		);

		expect(result).toMatchObject({
			status: "created",
			target: { indexMode: "INDEXED" },
		});
	});

	it("stores a STORE_ONLY folder and reconciles the sync's rows after the write, in the same transaction", async () => {
		const result = await createContextWriteTarget(createInput, () =>
			accept("docs/tasks", "PULL_REQUEST", "STORE_ONLY"),
		);

		expect(result).toMatchObject({
			status: "created",
			target: { indexMode: "STORE_ONLY" },
		});
		expect(h.state.reconcileCalls).toHaveLength(1);
		expect(h.state.reconcileCalls[0]?.logAtCall.at(-1)).toBe(
			"targets.create",
		);
		expect(h.state.reconcileCalls[0]?.input).toEqual({
			...scope,
			syncId: "sync-1",
			actingUserId: "user-delegate",
		});
	});

	it("hands the reconcile's outcome back with the target", async () => {
		h.state.reconcileResult = {
			excluded: 4,
			included: 0,
			cleanups: [{ id: "c-1", contextIds: ["a", "b", "c", "d"] }],
		};

		const result = await createContextWriteTarget(createInput, () =>
			accept("docs/tasks", "PULL_REQUEST", "STORE_ONLY"),
		);

		expect(result).toMatchObject({
			status: "created",
			reindex: h.state.reconcileResult,
		});
	});

	it("keeps a folder's indexing choice when an update does not name one", async () => {
		h.state.targets = [target({ indexMode: "STORE_ONLY" })];

		const result = await updateContextWriteTarget(updateInput, () =>
			accept("docs/agents-notes", "DIRECT_PUSH"),
		);

		expect(result).toMatchObject({
			status: "updated",
			target: { indexMode: "STORE_ONLY" },
		});
	});

	it("changes a folder's indexing choice and reconciles after the update", async () => {
		h.state.targets = [target({ indexMode: "INDEXED" })];

		const result = await updateContextWriteTarget(updateInput, () =>
			accept("docs/agents-notes", "PULL_REQUEST", "STORE_ONLY"),
		);

		expect(result).toMatchObject({
			status: "updated",
			target: { indexMode: "STORE_ONLY" },
			previous: { indexMode: "INDEXED" },
		});
		expect(h.state.reconcileCalls[0]?.logAtCall.at(-1)).toBe(
			"targets.update",
		);
	});

	it("reconciles after a folder is removed, so its rows are indexed again", async () => {
		h.state.targets = [target({ indexMode: "STORE_ONLY" })];

		await deleteContextWriteTarget({
			...scope,
			targetId: "target-existing",
		});

		expect(h.state.reconcileCalls[0]?.logAtCall.at(-1)).toBe(
			"targets.delete",
		);
	});

	it("does not reconcile when nothing was written", async () => {
		h.state.targets = [target()];

		await updateContextWriteTarget(updateInput, () => ({
			accept: false,
			refusal: "no",
		}));
		await deleteContextWriteTarget({ ...scope, targetId: "missing" });

		expect(h.state.reconcileCalls).toEqual([]);
	});
});

describe("listContextWriteTargets", () => {
	it("lists the project's folders by folder, scoped to its tenant", async () => {
		h.state.targets = [
			target({ id: "t-b", folder: "docs/b" }),
			target({ id: "t-a", folder: "docs/a" }),
			target({
				id: "t-other",
				folder: "docs/z",
				projectId: "proj-other",
			}),
		];

		const listed = await listContextWriteTargets(scope);

		expect(listed.map((row) => row.id)).toEqual(["t-a", "t-b"]);
	});
});
