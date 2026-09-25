/**
 * Real-procedure visibility coverage for the coding-instructions proposal
 * procedures (Fizzy #2727).
 *
 * `requireProjectPermission`'s org-role fallback grants an organization member
 * with no ProjectMember row instruction:update, which makes them a reviewer:
 * they could list every proposal, including a REPOSITORY proposal's pull
 * request URL, and act on it. Each procedure therefore composes
 * `projectNotFoundUnlessVisible` ahead of its permission gate. This file reads
 * the REAL composed chains off `~orpc.middlewares`, as
 * `repository-sync/__tests__/repository-sync-authz.test.ts` does, and runs the
 * two gates in order for that caller.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockResolveAccess, mockHasProjectAccess } = vi.hoisted(() => ({
	mockResolveAccess: vi.fn(),
	mockHasProjectAccess: vi.fn(),
}));

// Importing the real `orpc/procedures` reaches other `@repo/database`
// exports transitively; spread the real module so they resolve.
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
import {
	approveInstructionProposalProcedure,
	cancelInstructionProposalProcedure,
	getInstructionProposalFileProcedure,
	getInstructionProposalProcedure,
	getInstructionProposalPullRequestProcedure,
	listInstructionProposalsProcedure,
	refreshInstructionProposalPullRequestProcedure,
	rejectInstructionProposalProcedure,
	retryInstructionProposalPullRequestProcedure,
} from "../proposals";

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
	["list", listInstructionProposalsProcedure],
	["get", getInstructionProposalProcedure],
	["getFile", getInstructionProposalFileProcedure],
	["approve", approveInstructionProposalProcedure],
	["reject", rejectInstructionProposalProcedure],
	["cancel", cancelInstructionProposalProcedure],
	["getPullRequest", getInstructionProposalPullRequestProcedure],
	["refreshPullRequest", refreshInstructionProposalPullRequestProcedure],
	["retryPullRequest", retryInstructionProposalPullRequestProcedure],
] as const;

const visibility = projectNotFoundUnlessVisible as unknown as TaggedMiddleware;
const PROJECT_ID = "proj_1";
const USER = "user_1";

beforeEach(() => {
	mockResolveAccess.mockReset();
	mockHasProjectAccess.mockReset();
});

describe("instruction proposal procedures: project visibility (Fizzy #2727)", () => {
	it("decides visibility before permission on every one of the nine", () => {
		for (const [name, procedure] of PROCEDURES) {
			const middlewares = chain(procedure);
			const visibilityAt = middlewares.indexOf(visibility);
			expect(visibilityAt, name).toBeGreaterThanOrEqual(0);
			expect(visibilityAt, name).toBeLessThan(
				middlewares.indexOf(permissionMiddleware(procedure)),
			);
		}
	});

	it("answers an organization member who cannot discover the project NOT_FOUND on every one, though the org-role fallback would make them a reviewer", async () => {
		mockHasProjectAccess.mockResolvedValue(false);
		mockResolveAccess.mockResolvedValue({
			permissions: [
				Permissions.INSTRUCTION_READ,
				Permissions.INSTRUCTION_UPDATE,
			],
			source: "org",
			organizationId: "org_1",
		});

		for (const [name, procedure] of PROCEDURES) {
			const middlewares = chain(procedure);
			const gated = middlewares.slice(
				middlewares.indexOf(visibility),
				middlewares.indexOf(permissionMiddleware(procedure)) + 1,
			);
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
		for (const [name, procedure] of PROCEDURES) {
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
