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
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockResolveAccess } = vi.hoisted(() => ({
	mockResolveAccess: vi.fn(),
}));

// Importing the real `orpc/procedures` pulls in the whole oRPC stack, which
// reaches other `@repo/database` exports transitively (see the identical
// note in `dismiss-cli-nudge.test.ts`). Spread the real module rather than
// replacing it so those imports resolve; `resolveEffectiveProjectPermissions`
// — the one function `assertProjectPermission` actually consults — is
// overridden below instead of through this mock.
vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
}));

vi.mock("../../../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: (...args: unknown[]) =>
		mockResolveAccess(...args),
}));

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

/** The gate a procedure declares, pulled off its composed middleware chain. */
function permissionMiddleware(procedure: unknown): TaggedMiddleware {
	const { middlewares } = (
		procedure as unknown as { "~orpc": { middlewares: TaggedMiddleware[] } }
	)["~orpc"];
	const found = middlewares.find(
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
