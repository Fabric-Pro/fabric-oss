/**
 * The facts admission reads for a proposed Living Memory write (ADR-022).
 *
 * What this pins: every read is scoped to the project AND the organization the
 * caller resolved; the target is found only through the project's own sync; the
 * instruction roots are those of the project's instructions sync only when it
 * reads the same repository integration; the managed-row lookup asks about the
 * PUT paths only, and is skipped when there are none; and a project outside the
 * organization reads as `null`.
 *
 * Run with: pnpm --filter @repo/database test -- __tests__/memory-write-admission.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	db: {
		project: { findFirst: vi.fn() },
		projectContextRepositorySync: { findFirst: vi.fn() },
		projectContextWriteTarget: { findFirst: vi.fn() },
		projectInstructionRepositorySync: { findMany: vi.fn() },
		projectContext: { count: vi.fn(), findMany: vi.fn() },
	},
}));

vi.mock("../prisma/client", () => ({ db: h.db }));

import { getMemoryWriteAdmissionState } from "../prisma/queries/projects/memory-write-admission";

const input = {
	projectId: "proj-1",
	organizationId: "org-1",
	targetId: "target-1",
	putPaths: ["docs/memory/a.md", "docs/memory/b.md"],
};
const scope = { projectId: "proj-1", organizationId: "org-1" };

const sync = {
	id: "sync-1",
	userId: "user-delegate",
	ref: "main",
	repositoryIntegrationId: "int-1",
	paths: ["docs"],
	excludedPaths: [],
	automatic: true,
	automaticPausedReason: null,
};

beforeEach(() => {
	vi.clearAllMocks();
	h.db.project.findFirst.mockResolvedValue({ readOnlyMode: false });
	h.db.projectContextRepositorySync.findFirst.mockResolvedValue({ ...sync });
	h.db.projectContextWriteTarget.findFirst.mockResolvedValue({
		id: "target-1",
		version: 5,
		folder: "docs/memory",
		mode: "DIRECT_PUSH",
	});
	h.db.projectInstructionRepositorySync.findMany.mockResolvedValue([
		{ rootPath: "docs/coding" },
	]);
	h.db.projectContext.count.mockResolvedValue(12);
	h.db.projectContext.findMany.mockResolvedValue([
		{ sourcePath: "docs/memory/a.md" },
		{ sourcePath: null },
	]);
});

describe("getMemoryWriteAdmissionState", () => {
	it("reads the project, the sync, the target, the instruction roots and the managed rows", async () => {
		const state = await getMemoryWriteAdmissionState(input);

		expect(state).toEqual({
			readOnlyMode: false,
			sync,
			target: {
				id: "target-1",
				version: 5,
				folder: "docs/memory",
				mode: "DIRECT_PUSH",
			},
			instructionRoots: ["docs/coding"],
			managedCount: 12,
			managedKeys: ["docs/memory/a.md"],
		});
	});

	it("scopes every read to the project and the organization", async () => {
		await getMemoryWriteAdmissionState(input);

		expect(h.db.project.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "proj-1", organizationId: "org-1" },
			}),
		);
		expect(
			h.db.projectContextRepositorySync.findFirst,
		).toHaveBeenCalledWith(expect.objectContaining({ where: scope }));
		expect(h.db.projectContext.count).toHaveBeenCalledWith({
			where: { ...scope, repositorySyncId: "sync-1" },
		});
		expect(h.db.projectContext.findMany).toHaveBeenCalledWith({
			where: {
				...scope,
				repositorySyncId: "sync-1",
				sourcePath: { in: input.putPaths },
			},
			select: { sourcePath: true },
		});
	});

	it("finds the target only through the project's own sync", async () => {
		await getMemoryWriteAdmissionState(input);

		expect(h.db.projectContextWriteTarget.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "target-1", syncId: "sync-1", ...scope },
			}),
		);
	});

	it("reads the instruction roots of the same repository integration only", async () => {
		await getMemoryWriteAdmissionState(input);

		expect(
			h.db.projectInstructionRepositorySync.findMany,
		).toHaveBeenCalledWith({
			where: { projectId: "proj-1", repositoryIntegrationId: "int-1" },
			select: { rootPath: true },
		});
	});

	it("does not look for managed rows when there is nothing to create or replace", async () => {
		const state = await getMemoryWriteAdmissionState({
			...input,
			putPaths: [],
		});

		expect(h.db.projectContext.findMany).not.toHaveBeenCalled();
		expect(state?.managedKeys).toEqual([]);
		expect(state?.managedCount).toBe(12);
	});

	it("reports a missing target as null, not an error", async () => {
		h.db.projectContextWriteTarget.findFirst.mockResolvedValue(null);

		const state = await getMemoryWriteAdmissionState(input);

		expect(state?.target).toBeNull();
		expect(state?.sync).toMatchObject({ id: "sync-1" });
	});

	it("reports a project with no sync, reading nothing further, and keeps its read-only flag", async () => {
		h.db.project.findFirst.mockResolvedValue({ readOnlyMode: true });
		h.db.projectContextRepositorySync.findFirst.mockResolvedValue(null);

		const state = await getMemoryWriteAdmissionState(input);

		expect(state).toEqual({
			readOnlyMode: true,
			sync: null,
			target: null,
			instructionRoots: [],
			managedCount: 0,
			managedKeys: [],
		});
		expect(h.db.projectContextWriteTarget.findFirst).not.toHaveBeenCalled();
		expect(h.db.projectContext.count).not.toHaveBeenCalled();
	});

	it("answers null for a project that is not in the organization", async () => {
		h.db.project.findFirst.mockResolvedValue(null);

		await expect(getMemoryWriteAdmissionState(input)).resolves.toBeNull();
		expect(h.db.projectContextWriteTarget.findFirst).not.toHaveBeenCalled();
	});
});
