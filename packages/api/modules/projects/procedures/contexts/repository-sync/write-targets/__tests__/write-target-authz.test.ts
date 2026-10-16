/**
 * Real-procedure authorization coverage for the Living Memory write folders
 * and the admission check (ADR-022).
 *
 * `write-target-procedures.test.ts` replaces `orpc/procedures` with a builder
 * that records the chain. This file imports the REAL composed procedures and
 * reads their middleware chain off `~orpc.middlewares`, so what is pinned is
 * what ships: each procedure carries `projectNotFoundUnlessVisible` BEFORE
 * its permission gate, the gate names CONTEXT_READ for `list`, CONTEXT_READ
 * for `get` of a write's receipt, and
 * CONTEXT_CREATE for `create`, `update`, `delete`, `validate`,
 * `createUploadUrls` and `submit`, CONTEXT_READ for `get`, and the real gate
 * refuses a read-only member everything but `list` and `get`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockResolveAccess } = vi.hoisted(() => ({
	mockResolveAccess: vi.fn(),
}));

// Importing the real `orpc/procedures` reaches other `@repo/database`
// exports transitively; spread the real module so they resolve.
vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
}));
vi.mock("../../../../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: (...args: unknown[]) =>
		mockResolveAccess(...args),
}));

import { projectNotFoundUnlessVisible } from "../../../../../../../orpc/middleware/project-visibility";
import {
	PERMISSION_MIDDLEWARE_TAG,
	Permissions,
} from "../../../../../../../orpc/procedures";
import { createMemoryWriteUploadUrlsProcedure } from "../../../memory-writes/create-upload-urls";
import { getMemoryWriteProcedure } from "../../../memory-writes/get";
import { submitMemoryWriteProcedure } from "../../../memory-writes/submit";
import { validateMemoryWriteProcedure } from "../../../memory-writes/validate";
import { createContextWriteTargetProcedure } from "../create";
import { deleteContextWriteTargetProcedure } from "../delete";
import { listContextWriteTargetsProcedure } from "../list";
import { updateContextWriteTargetProcedure } from "../update";

type TaggedMiddleware = ((
	options: { context: unknown; next: () => unknown },
	input: unknown,
) => Promise<unknown>) & { [PERMISSION_MIDDLEWARE_TAG]?: string };

function chain(procedure: unknown): TaggedMiddleware[] {
	return (procedure as { "~orpc": { middlewares: TaggedMiddleware[] } })[
		"~orpc"
	].middlewares;
}

function permissionMiddleware(procedure: unknown): TaggedMiddleware {
	const found = chain(procedure).find(
		(mw) => mw[PERMISSION_MIDDLEWARE_TAG] !== undefined,
	);
	expect(found).toBeDefined();
	return found as TaggedMiddleware;
}

const READ = [
	["list", listContextWriteTargetsProcedure],
	["get", getMemoryWriteProcedure],
] as const;
const MUTATING = [
	["create", createContextWriteTargetProcedure],
	["update", updateContextWriteTargetProcedure],
	["delete", deleteContextWriteTargetProcedure],
	["validate", validateMemoryWriteProcedure],
	["createUploadUrls", createMemoryWriteUploadUrlsProcedure],
	["submit", submitMemoryWriteProcedure],
] as const;
const ALL = [...READ, ...MUTATING] as const;

beforeEach(() => {
	mockResolveAccess.mockReset();
});

describe("contexts.repositorySync.writeTargets and contexts.memoryWrites: the composed chain", () => {
	it("gates list and get on CONTEXT_READ and every other procedure on CONTEXT_CREATE", () => {
		for (const [name, procedure] of READ) {
			expect(
				permissionMiddleware(procedure)[PERMISSION_MIDDLEWARE_TAG],
				name,
			).toBe(Permissions.CONTEXT_READ);
		}
		for (const [name, procedure] of MUTATING) {
			expect(
				permissionMiddleware(procedure)[PERMISSION_MIDDLEWARE_TAG],
				name,
			).toBe(Permissions.CONTEXT_CREATE);
		}
	});

	it("decides visibility before permission on every one of them", () => {
		for (const [name, procedure] of ALL) {
			const middlewares = chain(procedure);
			const visibility = middlewares.indexOf(
				projectNotFoundUnlessVisible as unknown as TaggedMiddleware,
			);
			const permission = middlewares.indexOf(
				permissionMiddleware(procedure),
			);
			expect(visibility, name).toBeGreaterThanOrEqual(0);
			expect(visibility, name).toBeLessThan(permission);
		}
	});

	it("lets a read-only member through the gates of list and get and refuses them everything else", async () => {
		mockResolveAccess.mockResolvedValue({
			permissions: [Permissions.CONTEXT_READ],
			source: "project-member",
			organizationId: "org-1",
		});

		for (const [, procedure] of READ) {
			const next = vi.fn(() => ({ ok: true }));
			await expect(
				permissionMiddleware(procedure)(
					{ context: { user: { id: "user-1" } }, next },
					{ projectId: "proj-1" },
				),
			).resolves.toBeTruthy();
			expect(next).toHaveBeenCalled();
		}
		for (const [, procedure] of MUTATING) {
			const next = vi.fn();
			await expect(
				permissionMiddleware(procedure)(
					{ context: { user: { id: "user-1" } }, next },
					{ projectId: "proj-1" },
				),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(next).not.toHaveBeenCalled();
		}
	});
});
