/**
 * Real-middleware authorization coverage for the coding-instructions
 * repository-sync procedures (review round 1, S2b).
 *
 * `repository-sync-procedures.test.ts` fully mocks `../../../../../orpc/
 * procedures`, so `.use(requireProjectPermission(...))` becomes a no-op
 * there — its "declared permissions" test proves only which permission KEY
 * each module names, never that the middleware actually refuses anyone. This
 * file imports the REAL procedures (the real `orpc/procedures` module,
 * unmocked), pulls the tagged permission middleware off each one's composed
 * chain, and calls that single middleware directly with a hand-built
 * `{context, next}` — the same technique
 * `modules/projects/procedures/__tests__/project-tabs-authz.test.ts` and
 * `modules/projects/procedures/readiness/__tests__/dismiss-cli-nudge.test.ts`
 * use to exercise `assertProjectPermission` for real without a live database.
 *
 * Every procedure also composes `projectNotFoundUnlessVisible` ahead of that
 * gate (Fizzy #2727, as the Living Memory set does): the org-role fallback in
 * `requireProjectPermission` admits an organization member with no
 * ProjectMember row, who must not learn a project's repository, branch and
 * folder, nor re-point, sync or disable it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockResolveAccess, mockHasProjectAccess } = vi.hoisted(() => ({
	mockResolveAccess: vi.fn(),
	mockHasProjectAccess: vi.fn(),
}));

// Importing the real `orpc/procedures` pulls in the whole oRPC stack, which
// reaches other `@repo/database` exports transitively (see the identical
// note in `dismiss-cli-nudge.test.ts`). Spread the real module rather than
// replacing it so those imports resolve; `resolveEffectiveProjectPermissions`
// — the one function `assertProjectPermission` actually consults — is
// overridden below instead of through this mock.
vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	hasProjectAccess: (...args: unknown[]) => mockHasProjectAccess(...args),
}));

vi.mock("../../../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: (...args: unknown[]) =>
		mockResolveAccess(...args),
}));

import { projectNotFoundUnlessVisible } from "../../../../../../orpc/middleware/project-visibility";
import {
	PERMISSION_MIDDLEWARE_TAG,
	Permissions,
} from "../../../../../../orpc/procedures";
import { configureRepositorySyncProcedure } from "../configure";
import { disableRepositorySyncProcedure } from "../disable";
import { getRepositorySyncProcedure } from "../get";
import { listRepositorySyncRunsProcedure } from "../list-runs";
import { listInstructionRepositoryTreeProcedure } from "../list-tree";
import { syncRepositoryNowProcedure } from "../sync-now";
import { updateRepositorySyncProposalSettingsProcedure } from "../update-proposal-settings";

type TaggedMiddleware = ((
	options: { context: unknown; next: () => unknown },
	input: unknown,
) => Promise<unknown>) & { [PERMISSION_MIDDLEWARE_TAG]?: string };

function chain(procedure: unknown): TaggedMiddleware[] {
	return (procedure as { "~orpc": { middlewares: TaggedMiddleware[] } })[
		"~orpc"
	].middlewares;
}

/** The gate a procedure declares, pulled off its composed middleware chain. */
function permissionMiddleware(procedure: unknown): TaggedMiddleware {
	const found = chain(procedure).find(
		(mw) => mw[PERMISSION_MIDDLEWARE_TAG] !== undefined,
	);
	expect(found).toBeDefined();
	return found as TaggedMiddleware;
}

const READ_PROCEDURES = [
	["get", getRepositorySyncProcedure],
	["listRuns", listRepositorySyncRunsProcedure],
] as const;
// `listTree` writes nothing, but spends the integration's credential, so it
// sits behind configure's own permission (Fizzy #2725).
const MUTATING_PROCEDURES = [
	["configure", configureRepositorySyncProcedure],
	["listTree", listInstructionRepositoryTreeProcedure],
	["syncNow", syncRepositoryNowProcedure],
	["disable", disableRepositorySyncProcedure],
	["updateProposalSettings", updateRepositorySyncProposalSettingsProcedure],
] as const;
const ALL_PROCEDURES = [...READ_PROCEDURES, ...MUTATING_PROCEDURES] as const;

const PROJECT_ID = "proj_1";
const USER = "user_1";

beforeEach(() => {
	mockResolveAccess.mockReset();
	mockHasProjectAccess.mockReset();
});

describe("repositorySync procedures: real requireProjectPermission middleware", () => {
	it("each declares the permission the brief specifies (spec §8.5)", () => {
		for (const [name, procedure] of READ_PROCEDURES) {
			expect(
				permissionMiddleware(procedure)[PERMISSION_MIDDLEWARE_TAG],
				name,
			).toBe(Permissions.INSTRUCTION_READ);
		}
		for (const [name, procedure] of MUTATING_PROCEDURES) {
			expect(
				permissionMiddleware(procedure)[PERMISSION_MIDDLEWARE_TAG],
				name,
			).toBe(Permissions.INSTRUCTION_CREATE);
		}
	});

	it("a VIEWER ProjectMember (read-only) is allowed get/listRuns", async () => {
		mockResolveAccess.mockResolvedValue({
			permissions: [Permissions.INSTRUCTION_READ],
			source: "project-member",
			organizationId: "org_1",
		});

		for (const [, procedure] of READ_PROCEDURES) {
			const next = vi.fn(() => ({ ok: true }));
			await expect(
				permissionMiddleware(procedure)(
					{ context: { user: { id: USER } }, next },
					{ projectId: PROJECT_ID },
				),
			).resolves.toBeTruthy();
			expect(next).toHaveBeenCalled();
		}
	});

	it("a VIEWER ProjectMember (read-only) is refused configure/syncNow/disable", async () => {
		mockResolveAccess.mockResolvedValue({
			permissions: [Permissions.INSTRUCTION_READ],
			source: "project-member",
			organizationId: "org_1",
		});

		for (const [, procedure] of MUTATING_PROCEDURES) {
			const next = vi.fn();
			await expect(
				permissionMiddleware(procedure)(
					{ context: { user: { id: USER } }, next },
					{ projectId: PROJECT_ID },
				),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(next).not.toHaveBeenCalled();
		}
	});

	it("a caller with no tie to the project gets NOT_FOUND on every one of the five, never FORBIDDEN", async () => {
		// `source: "none"` is `assertProjectPermission`'s existence-before-
		// permission branch (Fizzy #2639): a caller not tied to the project at
		// all must not learn a permission key even exists to be refused by.
		mockResolveAccess.mockResolvedValue({
			permissions: [],
			source: "none",
			organizationId: null,
		});

		for (const [, procedure] of ALL_PROCEDURES) {
			await expect(
				permissionMiddleware(procedure)(
					{ context: { user: { id: USER } }, next: vi.fn() },
					{ projectId: PROJECT_ID },
				),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
		}
	});

	it("an EDITOR ProjectMember holding INSTRUCTION_CREATE is let through every one of the five", async () => {
		mockResolveAccess.mockResolvedValue({
			permissions: [
				Permissions.INSTRUCTION_READ,
				Permissions.INSTRUCTION_CREATE,
			],
			source: "project-member",
			organizationId: "org_1",
		});

		for (const [, procedure] of ALL_PROCEDURES) {
			const next = vi.fn(() => ({ ok: true }));
			await expect(
				permissionMiddleware(procedure)(
					{ context: { user: { id: USER } }, next },
					{ projectId: PROJECT_ID },
				),
			).resolves.toBeTruthy();
			expect(next).toHaveBeenCalled();
		}
	});
});

describe("repositorySync procedures: project visibility (Fizzy #2727)", () => {
	const visibility =
		projectNotFoundUnlessVisible as unknown as TaggedMiddleware;

	it("decides visibility before permission on every one of the seven", () => {
		for (const [name, procedure] of ALL_PROCEDURES) {
			const middlewares = chain(procedure);
			const visibilityAt = middlewares.indexOf(visibility);
			expect(visibilityAt, name).toBeGreaterThanOrEqual(0);
			expect(visibilityAt, name).toBeLessThan(
				middlewares.indexOf(permissionMiddleware(procedure)),
			);
		}
	});

	it("answers an organization member who cannot discover the project NOT_FOUND on every one, though the org-role fallback would grant INSTRUCTION_CREATE", async () => {
		mockHasProjectAccess.mockResolvedValue(false);
		mockResolveAccess.mockResolvedValue({
			permissions: [
				Permissions.INSTRUCTION_READ,
				Permissions.INSTRUCTION_CREATE,
			],
			source: "org",
			organizationId: "org_1",
		});

		for (const [name, procedure] of ALL_PROCEDURES) {
			const middlewares = chain(procedure);
			const gated = middlewares.slice(
				middlewares.indexOf(visibility),
				middlewares.indexOf(permissionMiddleware(procedure)) + 1,
			);
			// Run the chain from the visibility gate through the permission
			// gate, in the order the procedure composes them.
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
		for (const [name, procedure] of ALL_PROCEDURES) {
			const next = vi.fn(() => ({ ok: true }));
			await expect(
				chain(procedure)[chain(procedure).indexOf(visibility)](
					{ context: { user: { id: USER } }, next },
					{ projectId: PROJECT_ID },
				),
				name,
			).resolves.toBeTruthy();
			expect(next, name).toHaveBeenCalled();
		}
	});
});
