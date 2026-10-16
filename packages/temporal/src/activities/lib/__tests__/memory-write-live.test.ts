/**
 * What a Living Memory write re-checks live before it touches the repository
 * (ADR-022): the verdict over the facts, in the order a person would fix them.
 * The database reads and the permission lookups are faked; the folder rule is
 * the real `checkWriteTargetFolder`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	getMemoryWriteRunState: vi.fn(),
	canCreateProjectContexts: vi.fn(),
}));

vi.mock("@repo/database", async () => ({
	...(await import(
		"@repo/database/prisma/queries/projects/context-source-path"
	)),
	...(await import(
		"@repo/database/prisma/queries/projects/context-repository-sync-selection"
	)),
	getMemoryWriteRunState: h.getMemoryWriteRunState,
	canCreateProjectContexts: h.canCreateProjectContexts,
}));

import {
	checkMemoryWriteStillAllowed,
	type FrozenWrite,
	judgeMemoryWriteState,
} from "../memory-write-live";

const write: FrozenWrite = {
	projectId: "proj-1",
	organizationId: "org-1",
	userId: "user-member",
	targetId: "target-1",
	targetVersion: 3,
	folder: "docs/memory",
	mode: "DIRECT_PUSH",
	ref: "main",
	repositoryIntegrationId: "int-1",
};

function state(overrides: Record<string, unknown> = {}) {
	return {
		readOnlyMode: false,
		sync: {
			id: "sync-1",
			generation: 4,
			userId: "user-delegate",
			ref: "main",
			repositoryIntegrationId: "int-1",
			paths: ["docs"],
			excludedPaths: ["docs/drafts"],
			automatic: true,
			automaticPausedReason: null,
			integration: {
				id: "int-1",
				projectId: "proj-1",
				provider: "GITHUB",
				repositoryUrl: "https://github.com/example/example",
				status: "ACTIVE",
			},
		},
		target: {
			id: "target-1",
			version: 3,
			folder: "docs/memory",
			mode: "DIRECT_PUSH",
		},
		instructionRoots: [],
		userName: "Example Member",
		...overrides,
	} as Parameters<typeof judgeMemoryWriteState>[1];
}

const holds = { member: true, delegate: true };

describe("judgeMemoryWriteState", () => {
	it("lets a write go on when everything it froze still holds, handing back the narrowed state", () => {
		const verdict = judgeMemoryWriteState(write, state(), holds);

		expect(verdict.ok).toBe(true);
		if (verdict.ok) {
			expect(verdict.state.sync.id).toBe("sync-1");
			expect(verdict.state.target.folder).toBe("docs/memory");
		}
	});

	it.each([
		["the target is gone", { target: null }],
		[
			"the target is another version",
			{
				target: {
					id: "target-1",
					version: 4,
					folder: "docs/memory",
					mode: "DIRECT_PUSH",
				},
			},
		],
		[
			"the target is another folder",
			{
				target: {
					id: "target-1",
					version: 3,
					folder: "docs/other",
					mode: "DIRECT_PUSH",
				},
			},
		],
		[
			"the target is another mode",
			{
				target: {
					id: "target-1",
					version: 3,
					folder: "docs/memory",
					mode: "PULL_REQUEST",
				},
			},
		],
	])("refuses TARGET_CHANGED when %s", (_name, overrides) => {
		expect(judgeMemoryWriteState(write, state(overrides), holds)).toEqual({
			ok: false,
			code: "TARGET_CHANGED",
		});
	});

	it("refuses SYNC_CHANGED when the sync is gone, on another branch or on another integration", () => {
		const base = state();
		const sync = base.sync as NonNullable<typeof base.sync>;

		for (const changed of [
			null,
			{ ...sync, ref: "develop" },
			{ ...sync, repositoryIntegrationId: "int-2" },
			{
				...sync,
				integration: { ...sync.integration, projectId: "proj-2" },
			},
		]) {
			expect(
				judgeMemoryWriteState(write, state({ sync: changed }), holds),
			).toEqual({ ok: false, code: "SYNC_CHANGED" });
		}
	});

	it("refuses SYNC_NOT_INGESTING when automatic sync is off or paused", () => {
		const base = state();
		const sync = base.sync as NonNullable<typeof base.sync>;

		for (const changed of [
			{ ...sync, automatic: false },
			{ ...sync, automaticPausedReason: "PERMISSION_REVOKED" },
		]) {
			expect(
				judgeMemoryWriteState(write, state({ sync: changed }), holds),
			).toEqual({ ok: false, code: "SYNC_NOT_INGESTING" });
		}
	});

	it("refuses READ_ONLY_MODE, then a member and a delegate who lost the right, in that order", () => {
		expect(
			judgeMemoryWriteState(write, state({ readOnlyMode: true }), {
				member: false,
				delegate: false,
			}),
		).toEqual({ ok: false, code: "READ_ONLY_MODE" });
		expect(
			judgeMemoryWriteState(write, state(), {
				member: false,
				delegate: false,
			}),
		).toEqual({ ok: false, code: "PERMISSION_REVOKED" });
		expect(
			judgeMemoryWriteState(write, state(), {
				member: true,
				delegate: false,
			}),
		).toEqual({ ok: false, code: "SYNC_DELEGATE_LOST_PERMISSION" });
	});

	it("refuses TARGET_STALE when the folder no longer passes the rule that admitted it", () => {
		const base = state();
		const sync = base.sync as NonNullable<typeof base.sync>;

		expect(
			judgeMemoryWriteState(
				write,
				state({ sync: { ...sync, paths: ["notes"] } }),
				holds,
			),
		).toEqual({ ok: false, code: "TARGET_STALE" });
		expect(
			judgeMemoryWriteState(
				write,
				state({ instructionRoots: ["docs"] }),
				holds,
			),
		).toEqual({ ok: false, code: "TARGET_STALE" });
	});
});

describe("checkMemoryWriteStillAllowed", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		h.getMemoryWriteRunState.mockResolvedValue(state());
		h.canCreateProjectContexts.mockResolvedValue(true);
	});

	it("reads the live facts for the write's own tenant and member, and asks for the delegate's right only when it is another member", async () => {
		const verdict = await checkMemoryWriteStillAllowed(write);

		expect(verdict.ok).toBe(true);
		expect(h.getMemoryWriteRunState).toHaveBeenCalledWith({
			projectId: "proj-1",
			organizationId: "org-1",
			targetId: "target-1",
			userId: "user-member",
		});
		expect(h.canCreateProjectContexts.mock.calls).toEqual([
			["proj-1", "user-member"],
			["proj-1", "user-delegate"],
		]);
	});

	it("reads a project that left the organization as a changed target", async () => {
		h.getMemoryWriteRunState.mockResolvedValue(null);

		expect(await checkMemoryWriteStillAllowed(write)).toEqual({
			ok: false,
			code: "TARGET_CHANGED",
		});
	});

	it("refuses a member who lost CONTEXT_CREATE since the write was admitted", async () => {
		h.canCreateProjectContexts.mockImplementation(
			async (_project: string, user: string) => user !== "user-member",
		);

		expect(await checkMemoryWriteStillAllowed(write)).toEqual({
			ok: false,
			code: "PERMISSION_REVOKED",
		});
	});
});
