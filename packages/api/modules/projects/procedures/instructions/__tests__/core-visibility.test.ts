/**
 * Real-procedure visibility coverage for the core coding-instructions
 * procedures (upload, publish, read and settings).
 *
 * `requireProjectPermission`'s org-role fallback lets an organization member
 * with no ProjectMember row through to the procedure, so each of them
 * composes `projectNotFoundUnlessVisible` ahead of its permission gate, as the
 * proposal and repository-sync procedures already do (Fizzy #2727). This file
 * reads the REAL composed chains off `~orpc.middlewares` and runs the two gates
 * in order for that caller.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockResolveAccess, mockHasProjectAccess } = vi.hoisted(() => ({
	mockResolveAccess: vi.fn(),
	mockHasProjectAccess: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	hasProjectAccess: (...args: unknown[]) => mockHasProjectAccess(...args),
}));
vi.mock("../../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: (...args: unknown[]) =>
		mockResolveAccess(...args),
}));

import { projectNotFoundUnlessVisible } from "../../../../../orpc/middleware/project-visibility";
import {
	PERMISSION_MIDDLEWARE_TAG,
	Permissions,
} from "../../../../../orpc/procedures";
import { beginSnapshotProcedure } from "../begin-snapshot";
import { compareSnapshotsProcedure } from "../compare-snapshots";
import { createDownloadUrlProcedure } from "../create-download-url";
import { createUploadUrlsProcedure } from "../create-upload-urls";
import { deleteSnapshotProcedure } from "../delete-snapshot";
import { deriveSnapshotProcedure } from "../derive-snapshot";
import { finalizeSnapshotProcedure } from "../finalize-snapshot";
import { getFileProcedure } from "../get-file";
import { getPublishedSnapshotProcedure } from "../get-published";
import { getSettingsProcedure } from "../get-settings";
import { getSnapshotProcedure } from "../get-snapshot";
import { listFilesProcedure } from "../list-files";
import { listSnapshotsProcedure } from "../list-snapshots";
import { publishSnapshotProcedure } from "../publish-snapshot";
import { updateSettingsProcedure } from "../update-settings";

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

const PROCEDURES = [
	["beginSnapshot", beginSnapshotProcedure],
	["deriveSnapshot", deriveSnapshotProcedure],
	["finalizeSnapshot", finalizeSnapshotProcedure],
	["createUploadUrls", createUploadUrlsProcedure],
	["publishSnapshot", publishSnapshotProcedure],
	["deleteSnapshot", deleteSnapshotProcedure],
	["updateSettings", updateSettingsProcedure],
	["getPublished", getPublishedSnapshotProcedure],
	["listFiles", listFilesProcedure],
	["getFile", getFileProcedure],
	["createDownloadUrl", createDownloadUrlProcedure],
	["compareSnapshots", compareSnapshotsProcedure],
	["listSnapshots", listSnapshotsProcedure],
	["getSettings", getSettingsProcedure],
	["getSnapshot", getSnapshotProcedure],
] as const;

const visibility = projectNotFoundUnlessVisible as unknown as TaggedMiddleware;
const PROJECT_ID = "proj_1";
const USER = "user_1";

function gatesOf(procedure: unknown) {
	const middlewares = chain(procedure);
	return middlewares.slice(
		middlewares.indexOf(visibility),
		middlewares.indexOf(permissionMiddleware(procedure)) + 1,
	);
}

beforeEach(() => {
	mockResolveAccess.mockReset();
	mockHasProjectAccess.mockReset();
});

describe("core instruction procedures: project visibility", () => {
	it("decides visibility before permission on every one", () => {
		for (const [name, procedure] of PROCEDURES) {
			const middlewares = chain(procedure);
			const visibilityAt = middlewares.indexOf(visibility);
			expect(visibilityAt, name).toBeGreaterThanOrEqual(0);
			expect(visibilityAt, name).toBeLessThan(
				middlewares.indexOf(permissionMiddleware(procedure)),
			);
		}
	});

	it("answers an organization member with no project tie NOT_FOUND on every one, though the org-role fallback grants every permission", async () => {
		mockHasProjectAccess.mockResolvedValue(false);
		mockResolveAccess.mockResolvedValue({
			permissions: Object.values(Permissions),
			source: "org",
			organizationId: "org_1",
		});

		for (const [name, procedure] of PROCEDURES) {
			const gated = gatesOf(procedure);
			const next = vi.fn(() => ({ ok: true }));
			const run = (i: number): Promise<unknown> =>
				i === gated.length
					? Promise.resolve(next())
					: gated[i](
							{
								context: { user: { id: USER } },
								next: () => run(i + 1),
							},
							{ projectId: PROJECT_ID },
						);
			await expect(run(0), name).rejects.toMatchObject({
				code: "NOT_FOUND",
				message: "Project not found",
			});
			expect(next, name).not.toHaveBeenCalled();
		}
		expect(mockHasProjectAccess).toHaveBeenCalledWith(PROJECT_ID, USER);
	});

	it("lets a caller who can discover the project through to the permission gate", async () => {
		mockHasProjectAccess.mockResolvedValue(true);
		const next = vi.fn(() => ({ ok: true }));

		await expect(
			visibility(
				{ context: { user: { id: USER } }, next },
				{ projectId: PROJECT_ID },
			),
		).resolves.toBeTruthy();

		expect(next).toHaveBeenCalled();
	});
});
