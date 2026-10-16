/**
 * Living Memory write receipts (ADR-022): storing an admitted write, reading
 * it back, and settling it once.
 *
 * What this pins: admission is one transaction under an advisory lock on the
 * member and the project; an identical request in flight or landed returns its
 * receipt (a refused, conflicted or failed one is not returned); a member at the
 * pending cap is refused, counting only receipts newer than the window; the
 * receipt freezes the target and carries its entries; every read is scoped to
 * the project AND the organization; and settling is conditional on `PENDING`,
 * writes its audit row in the same transaction, and leaves a settled receipt as
 * it is.
 *
 * Run with: pnpm --filter @repo/database test -- __tests__/memory-writes.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
	const tx = {
		$executeRaw: vi.fn(),
		projectMemoryWrite: {
			findFirst: vi.fn(),
			count: vi.fn(),
			create: vi.fn(),
			updateMany: vi.fn(),
		},
	};
	return {
		tx,
		audit: vi.fn(),
		db: {
			$transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)),
			projectMemoryWrite: { findFirst: vi.fn() },
			project: { findFirst: vi.fn() },
			projectContextRepositorySync: { findFirst: vi.fn() },
			projectContextWriteTarget: { findFirst: vi.fn() },
			projectInstructionRepositorySync: { findMany: vi.fn() },
			user: { findUnique: vi.fn() },
		},
	};
});

vi.mock("../prisma/client", () => ({ db: h.db }));
vi.mock("../prisma/queries/audit-log", () => ({
	recordAuditTx: h.audit,
}));

import {
	getMemoryWriteForRun,
	getMemoryWriteReceipt,
	getMemoryWriteRunState,
	type MemoryWriteEntryInput,
	settleMemoryWrite,
	submitMemoryWrite,
} from "../prisma/queries/projects/memory-writes";

const NOW = new Date("2026-10-15T12:00:00.000Z");
const HOUR = 60 * 60_000;
const scope = { projectId: "proj-1", organizationId: "org-1" };

const entries: MemoryWriteEntryInput[] = [
	{
		path: "docs/memory/a.md",
		op: "PUT",
		ifMatchOid: null,
		stagedKey: "memory-writes/proj-1/uuid-a",
		bytes: 10,
		sha256: "a".repeat(64),
	},
	{
		path: "docs/memory/b.md",
		op: "DELETE",
		ifMatchOid: "b".repeat(40),
		stagedKey: null,
		bytes: null,
		sha256: null,
	},
];

const submitInput = {
	...scope,
	userId: "user-1",
	via: "APP" as const,
	oauthClientId: null,
	target: {
		id: "target-1",
		version: 3,
		folder: "docs/memory",
		mode: "DIRECT_PUSH" as const,
		ref: "main",
		repositoryIntegrationId: "int-1",
	},
	message: "Add notes",
	digest: "digest-1",
	entries,
	dedupeWindowMs: 2 * HOUR,
	pendingWindowMs: 3 * HOUR,
	maxPending: 5,
	now: NOW,
};

beforeEach(() => {
	vi.clearAllMocks();
	h.db.$transaction.mockImplementation(async (fn) => fn(h.tx));
	h.tx.projectMemoryWrite.findFirst.mockResolvedValue(null);
	h.tx.projectMemoryWrite.count.mockResolvedValue(0);
	h.tx.projectMemoryWrite.create.mockResolvedValue({
		id: "write-1",
		status: "PENDING",
		digest: "digest-1",
	});
});

describe("submitMemoryWrite", () => {
	it("creates a PENDING receipt that freezes the target, with its entries, under the member's lock on the project", async () => {
		const result = await submitMemoryWrite(submitInput);

		expect(result).toEqual({
			kind: "created",
			write: { id: "write-1", status: "PENDING", digest: "digest-1" },
		});
		expect(h.tx.$executeRaw).toHaveBeenCalledTimes(1);
		expect(h.tx.projectMemoryWrite.create).toHaveBeenCalledWith({
			data: {
				...scope,
				userId: "user-1",
				targetId: "target-1",
				targetVersion: 3,
				folder: "docs/memory",
				mode: "DIRECT_PUSH",
				ref: "main",
				repositoryIntegrationId: "int-1",
				oauthClientId: null,
				via: "APP",
				message: "Add notes",
				digest: "digest-1",
				entries: { create: entries },
			},
			select: { id: true, status: true, digest: true },
		});
	});

	it("takes the lock before it reads anything", async () => {
		const order: string[] = [];
		h.tx.$executeRaw.mockImplementation(async () => {
			order.push("lock");
		});
		h.tx.projectMemoryWrite.findFirst.mockImplementation(async () => {
			order.push("read");
			return null;
		});

		await submitMemoryWrite(submitInput);

		expect(order).toEqual(["lock", "read"]);
	});

	it("returns the receipt of an identical request from the same member that is in flight or landed, writing nothing", async () => {
		h.tx.projectMemoryWrite.findFirst.mockResolvedValue({
			id: "write-0",
			status: "COMMITTED",
			digest: "digest-1",
		});

		const result = await submitMemoryWrite(submitInput);

		expect(result).toEqual({
			kind: "deduplicated",
			write: { id: "write-0", status: "COMMITTED", digest: "digest-1" },
		});
		expect(h.tx.projectMemoryWrite.create).not.toHaveBeenCalled();
		expect(h.tx.projectMemoryWrite.findFirst).toHaveBeenCalledWith({
			where: {
				...scope,
				userId: "user-1",
				digest: "digest-1",
				status: { in: ["PENDING", "COMMITTED", "PULL_REQUEST"] },
				createdAt: { gte: new Date(NOW.getTime() - 2 * HOUR) },
			},
			orderBy: { createdAt: "desc" },
			select: { id: true, status: true, digest: true },
		});
	});

	it("answers a retry of a request that is at the cap with its own receipt, not a refusal", async () => {
		h.tx.projectMemoryWrite.count.mockResolvedValue(5);
		h.tx.projectMemoryWrite.findFirst.mockResolvedValue({
			id: "write-0",
			status: "PENDING",
			digest: "digest-1",
		});

		expect((await submitMemoryWrite(submitInput)).kind).toBe(
			"deduplicated",
		);
	});

	it("refuses a member who has the most writes pending, counting only those newer than the window", async () => {
		h.tx.projectMemoryWrite.count.mockResolvedValue(5);

		const result = await submitMemoryWrite(submitInput);

		expect(result).toEqual({ kind: "too-many-pending", pending: 5 });
		expect(h.tx.projectMemoryWrite.create).not.toHaveBeenCalled();
		expect(h.tx.projectMemoryWrite.count).toHaveBeenCalledWith({
			where: {
				...scope,
				userId: "user-1",
				status: "PENDING",
				createdAt: { gte: new Date(NOW.getTime() - 3 * HOUR) },
			},
		});
	});

	it("admits a member one short of the cap", async () => {
		h.tx.projectMemoryWrite.count.mockResolvedValue(4);

		expect((await submitMemoryWrite(submitInput)).kind).toBe("created");
	});
});

describe("reading a receipt", () => {
	it("scopes the receipt a reader sees to the project and organization, with the paths and operations only", async () => {
		h.db.projectMemoryWrite.findFirst.mockResolvedValue({ id: "write-1" });

		await getMemoryWriteReceipt({ ...scope, writeId: "write-1" });

		const args = h.db.projectMemoryWrite.findFirst.mock.calls[0]?.[0];
		expect(args.where).toEqual({ id: "write-1", ...scope });
		expect(args.select.entries).toEqual({
			select: { path: true, op: true },
			orderBy: { path: "asc" },
		});
		expect(args.select).not.toHaveProperty("message");
		expect(JSON.stringify(args.select)).not.toContain("stagedKey");
	});

	it("scopes the receipt the workflow acts on the same way, with the staged keys it reads", async () => {
		await getMemoryWriteForRun({ ...scope, writeId: "write-1" });

		const args = h.db.projectMemoryWrite.findFirst.mock.calls[0]?.[0];
		expect(args.where).toEqual({ id: "write-1", ...scope });
		expect(args.select.entries.select).toMatchObject({
			stagedKey: true,
			bytes: true,
			sha256: true,
			ifMatchOid: true,
		});
	});
});

describe("getMemoryWriteRunState", () => {
	const syncRow = {
		id: "sync-1",
		generation: 4,
		userId: "user-delegate",
		ref: "main",
		repositoryIntegrationId: "int-1",
		paths: ["docs"],
		excludedPaths: [],
		automatic: true,
		automaticPausedReason: null,
		repositoryIntegration: {
			id: "int-1",
			projectId: "proj-1",
			provider: "GITHUB",
			repositoryUrl: "https://github.com/example/example",
			status: "ACTIVE",
		},
	};

	beforeEach(() => {
		h.db.project.findFirst.mockResolvedValue({ readOnlyMode: false });
		h.db.projectContextRepositorySync.findFirst.mockResolvedValue({
			...syncRow,
		});
		h.db.user.findUnique.mockResolvedValue({ name: "Example Member" });
		h.db.projectContextWriteTarget.findFirst.mockResolvedValue({
			id: "target-1",
			version: 3,
			folder: "docs/memory",
			mode: "DIRECT_PUSH",
		});
		h.db.projectInstructionRepositorySync.findMany.mockResolvedValue([
			{ rootPath: "docs/coding" },
		]);
	});

	it("reads the project, the sync with its integration, the target, the instruction roots and the member, scoped to the tenant", async () => {
		const state = await getMemoryWriteRunState({
			...scope,
			targetId: "target-1",
			userId: "user-1",
		});

		const { repositoryIntegration, ...flat } = syncRow;
		expect(state).toEqual({
			readOnlyMode: false,
			sync: { ...flat, integration: repositoryIntegration },
			target: {
				id: "target-1",
				version: 3,
				folder: "docs/memory",
				mode: "DIRECT_PUSH",
			},
			instructionRoots: ["docs/coding"],
			userName: "Example Member",
		});
		expect(h.db.project.findFirst).toHaveBeenCalledWith({
			where: { id: "proj-1", organizationId: "org-1" },
			select: { readOnlyMode: true },
		});
		expect(
			h.db.projectContextRepositorySync.findFirst.mock.calls[0]?.[0]
				.where,
		).toEqual(scope);
		expect(h.db.projectContextWriteTarget.findFirst).toHaveBeenCalledWith({
			where: { id: "target-1", syncId: "sync-1", ...scope },
			select: { id: true, version: true, folder: true, mode: true },
		});
		expect(
			h.db.projectInstructionRepositorySync.findMany,
		).toHaveBeenCalledWith({
			where: { projectId: "proj-1", repositoryIntegrationId: "int-1" },
			select: { rootPath: true },
		});
	});

	it("reads a project outside the organization as null, and a project with no sync as one with nothing to write into", async () => {
		h.db.project.findFirst.mockResolvedValue(null);
		expect(
			await getMemoryWriteRunState({
				...scope,
				targetId: "t",
				userId: "u",
			}),
		).toBeNull();

		h.db.project.findFirst.mockResolvedValue({ readOnlyMode: true });
		h.db.projectContextRepositorySync.findFirst.mockResolvedValue(null);
		expect(
			await getMemoryWriteRunState({
				...scope,
				targetId: "t",
				userId: "u",
			}),
		).toEqual({
			readOnlyMode: true,
			sync: null,
			target: null,
			instructionRoots: [],
			userName: "Example Member",
		});
	});
});

describe("settleMemoryWrite", () => {
	const settle = {
		...scope,
		writeId: "write-1",
		status: "COMMITTED" as const,
		outcome: { status: "COMMITTED", sha: "a".repeat(40) },
		metadata: { sha: "a".repeat(40) },
	};
	const receipt = {
		userId: "user-1",
		status: "PENDING",
		mode: "DIRECT_PUSH",
		folder: "docs/memory",
		ref: "main",
		via: "APP",
		_count: { entries: 2 },
	};

	beforeEach(() => {
		h.tx.projectMemoryWrite.findFirst.mockResolvedValue(receipt);
		h.tx.projectMemoryWrite.updateMany.mockResolvedValue({ count: 1 });
	});

	it("settles a PENDING receipt, conditional on PENDING, and writes the audit row in the same transaction", async () => {
		expect(await settleMemoryWrite(settle)).toEqual({
			applied: true,
			status: "COMMITTED",
		});

		const update = h.tx.projectMemoryWrite.updateMany.mock.calls[0]?.[0];
		expect(update.where).toEqual({
			id: "write-1",
			...scope,
			status: "PENDING",
		});
		expect(update.data).toMatchObject({
			status: "COMMITTED",
			outcome: settle.outcome,
		});
		expect(update.data.settledAt).toBeInstanceOf(Date);
		expect(h.audit).toHaveBeenCalledWith(
			h.tx,
			expect.objectContaining({
				action: "project.context.memory_write_settled",
				outcome: "success",
				actor: { type: "user", userId: "user-1" },
				organizationId: "org-1",
				projectId: "proj-1",
				resource: { type: "project_memory_write", id: "write-1" },
				metadata: {
					status: "COMMITTED",
					mode: "DIRECT_PUSH",
					folder: "docs/memory",
					ref: "main",
					via: "APP",
					fileCount: 2,
					sha: "a".repeat(40),
				},
			}),
		);
	});

	it("audits a failure as a failure", async () => {
		await settleMemoryWrite({
			...settle,
			status: "FAILED",
			outcome: { status: "FAILED", code: "BRANCH_BUSY", retryable: true },
			metadata: { code: "BRANCH_BUSY" },
		});

		expect(h.audit.mock.calls[0]?.[1].outcome).toBe("failure");
	});

	it("leaves a receipt that is settled already as it is, reporting its status and writing no audit row", async () => {
		h.tx.projectMemoryWrite.findFirst.mockResolvedValue({
			...receipt,
			status: "FAILED",
		});
		h.tx.projectMemoryWrite.updateMany.mockResolvedValue({ count: 0 });

		expect(await settleMemoryWrite(settle)).toEqual({
			applied: false,
			status: "FAILED",
		});
		expect(h.audit).not.toHaveBeenCalled();
	});

	it("reports a receipt that is not this project's as missing, and writes nothing", async () => {
		h.tx.projectMemoryWrite.findFirst.mockResolvedValue(null);

		expect(await settleMemoryWrite(settle)).toEqual({
			applied: false,
			status: null,
		});
		expect(h.tx.projectMemoryWrite.updateMany).not.toHaveBeenCalled();
		expect(h.audit).not.toHaveBeenCalled();
		expect(
			h.tx.projectMemoryWrite.findFirst.mock.calls[0]?.[0].where,
		).toEqual({
			id: "write-1",
			...scope,
		});
	});
});
