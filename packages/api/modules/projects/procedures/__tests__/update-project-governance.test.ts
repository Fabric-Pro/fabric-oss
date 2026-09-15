/**
 * Tests for the governance branch of updateProjectProcedure (Slice 0).
 *
 * Verifies:
 * - An EDITOR (PROJECT_UPDATE) cannot change `engagementProfile` → FORBIDDEN.
 * - An org admin restricted by an active project-level VIEWER row is denied
 *   (strict middleware order, plan §3.4).
 * - The owner can change the profile; `engagementProfileUpdatedAt` is set and
 *   a `governance_changed` ProjectActivity row is written in the same batch
 *   transaction as the update.
 * - `enforceSpikeGate: true` / `enforceDiscoveryGate: true` are allowed (run types exist).
 * - Non-governance updates never consult the governance permission.
 * - Re-sending the current value writes no audit row.
 */

import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const {
	handlers,
	mockProjectFindUnique,
	mockProjectUpdate,
	mockProjectMemberFindUnique,
	mockMemberFindFirst,
	mockProjectActivityCreate,
	mockTransaction,
	mockUpdateProject,
} = vi.hoisted(() => ({
	handlers: {} as Record<string, (...args: unknown[]) => unknown>,
	mockProjectFindUnique: vi.fn(),
	mockProjectUpdate: vi.fn(),
	mockProjectMemberFindUnique: vi.fn(),
	mockMemberFindFirst: vi.fn(),
	mockProjectActivityCreate: vi.fn(),
	mockTransaction: vi.fn(),
	mockUpdateProject: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		project: {
			findUnique: (...args: unknown[]) => mockProjectFindUnique(...args),
			update: (...args: unknown[]) => mockProjectUpdate(...args),
		},
		projectMember: {
			findUnique: (...args: unknown[]) =>
				mockProjectMemberFindUnique(...args),
		},
		member: {
			findFirst: (...args: unknown[]) => mockMemberFindFirst(...args),
		},
		projectActivity: {
			create: (...args: unknown[]) => mockProjectActivityCreate(...args),
		},
		$transaction: (...args: unknown[]) => mockTransaction(...args),
	},
	updateProject: (...args: unknown[]) => mockUpdateProject(...args),
	cleanupCodeSearchOnRepoUnlink: vi.fn(),
	moveWizardTempContextsToProject: vi.fn(),
	syncLegacyProjectRepoOnDisconnect: vi.fn(),
	engagementProfileSchema: z.enum([
		"EXPLORE",
		"PROPOSAL",
		"GOVERNED",
		"DELEGATED",
	]),
	Prisma: { JsonNull: "__JSON_NULL__", DbNull: "__DB_NULL__" },
}));

vi.mock("@repo/database/prisma/zod", async () => ({
	ClarifyingQuestionFrequencySchema: (await import("zod")).z.enum([
		"MINIMAL",
		"BALANCED",
		"THOROUGH",
	]),
	QaStrategyLevelSchema: (await import("zod")).z.enum([
		"LIGHT",
		"STANDARD",
		"STRICT",
	]),
	MaturationStatusSchema: (await import("zod")).z.enum([
		"TODO",
		"DISCOVERY",
		"DONE",
	]),

	ProjectStatusSchema: { optional: () => ({}) },
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: vi.fn(),
}));

vi.mock("../../../../orpc/procedures", async () => {
	// Real permission keys: the governance check compares them against the
	// real role matrix from @repo/permissions.
	const { Permissions } =
		await vi.importActual<typeof import("@repo/permissions")>(
			"@repo/permissions",
		);

	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: (schema: unknown) => {
			(chainable as { _input?: unknown })._input = schema;
			return chainable;
		},
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.updateProject = fn;
			return {
				_handler: fn,
				_input: (chainable as { _input?: unknown })._input,
			};
		},
	});
	return {
		tenantProtectedProcedure: chainable,
		resolveOrganizationId: vi.fn(
			(organizationId: string | null | undefined) =>
				organizationId ?? null,
		),
		requirePermission: vi.fn(() => ({})),
		requireProjectPermission: vi.fn(() => ({})),
		Permissions,
	};
});

// Side-effect: register the handler.
import "../update-project";

const ACTIVE_MEMBER = { acceptedAt: new Date("2026-01-01"), expiresAt: null };

const orgProject = {
	name: "Acme Portal",
	userId: "owner_1",
	organizationId: "org_1",
	repositoryUrl: null,
	engagementProfile: "GOVERNED",
	enforceSpecifyGate: false,
	enforceSpikeGate: false,
	enforceDiscoveryGate: false,
	documentTiersAdvisory: false,
	quotedPhases: [] as string[],
};

const personalProject = { ...orgProject, organizationId: null };

function ctxFor(userId: string, activeOrganizationId: string | null) {
	return {
		user: { id: userId, name: "Actor", email: "actor@example.com" },
		session: { id: "session-1", activeOrganizationId },
	} as unknown;
}

async function expectOrpcError(
	promise: Promise<unknown>,
	code: string,
	messageIncludes?: string,
) {
	let caught: unknown;
	try {
		await promise;
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(ORPCError);
	expect((caught as ORPCError<string, unknown>).code).toBe(code);
	if (messageIncludes) {
		expect((caught as ORPCError<string, unknown>).message).toContain(
			messageIncludes,
		);
	}
}

describe("updateProjectProcedure governance", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockProjectFindUnique.mockResolvedValue(orgProject);
		mockProjectUpdate.mockImplementation((args: { data: unknown }) => ({
			id: "proj_1",
			...orgProject,
			...(args.data as Record<string, unknown>),
			codeAnalysisStatus: "IDLE",
		}));
		mockUpdateProject.mockResolvedValue({
			id: "proj_1",
			...orgProject,
			codeAnalysisStatus: "IDLE",
		});
		mockProjectActivityCreate.mockImplementation((args: unknown) => args);
		// Batch transaction: run every op and return their results in order.
		mockTransaction.mockImplementation(async (ops: unknown[]) =>
			Promise.all(ops),
		);
		mockMemberFindFirst.mockResolvedValue(null);
		mockProjectMemberFindUnique.mockResolvedValue(null);
	});

	it("rejects an EDITOR changing engagementProfile with FORBIDDEN and writes nothing", async () => {
		mockProjectMemberFindUnique.mockResolvedValue({
			role: "EDITOR",
			...ACTIVE_MEMBER,
		});

		await expectOrpcError(
			handlers.updateProject({
				input: {
					id: "proj_1",
					organizationId: "org_1",
					engagementProfile: "EXPLORE",
				},
				context: ctxFor("editor_1", "org_1"),
			}) as Promise<unknown>,
			"FORBIDDEN",
			"project:governance:manage",
		);

		expect(mockUpdateProject).not.toHaveBeenCalled();
		expect(mockProjectUpdate).not.toHaveBeenCalled();
		expect(mockTransaction).not.toHaveBeenCalled();
		expect(mockProjectActivityCreate).not.toHaveBeenCalled();
	});

	it("denies an org admin who holds an active project-level VIEWER row (strict middleware order)", async () => {
		mockProjectMemberFindUnique.mockResolvedValue({
			role: "VIEWER",
			...ACTIVE_MEMBER,
		});
		mockMemberFindFirst.mockResolvedValue({ role: "admin" });

		await expectOrpcError(
			handlers.updateProject({
				input: {
					id: "proj_1",
					organizationId: "org_1",
					enforceSpecifyGate: true,
				},
				context: ctxFor("admin_1", "org_1"),
			}) as Promise<unknown>,
			"FORBIDDEN",
		);

		// The active ProjectMember row is authoritative; the org role is never consulted.
		expect(mockMemberFindFirst).not.toHaveBeenCalled();
		expect(mockTransaction).not.toHaveBeenCalled();
	});

	it("lets the owner change the profile, stamps engagementProfileUpdatedAt and writes an audit row in one transaction", async () => {
		mockProjectFindUnique.mockResolvedValue(personalProject);

		const result = (await handlers.updateProject({
			input: {
				id: "proj_1",
				organizationId: null,
				engagementProfile: "EXPLORE",
			},
			context: ctxFor("owner_1", null),
		})) as { project: Record<string, unknown> };

		// Update + audit row run together.
		expect(mockTransaction).toHaveBeenCalledTimes(1);
		expect(mockUpdateProject).not.toHaveBeenCalled();

		expect(mockProjectUpdate).toHaveBeenCalledTimes(1);
		const updateArgs = mockProjectUpdate.mock.calls[0][0];
		expect(updateArgs.where).toEqual({
			id: "proj_1",
			organizationId: null,
		});
		expect(updateArgs.data.engagementProfile).toBe("EXPLORE");
		expect(updateArgs.data.engagementProfileUpdatedAt).toBeInstanceOf(Date);

		expect(mockProjectActivityCreate).toHaveBeenCalledTimes(1);
		const activity = mockProjectActivityCreate.mock.calls[0][0].data;
		expect(activity).toMatchObject({
			projectId: "proj_1",
			userId: "owner_1",
			userName: "Actor",
			activityType: "governance_changed",
			resourceType: "project",
			resourceId: "proj_1",
			resourceName: "Acme Portal",
			organizationId: null,
		});
		expect(activity.metadata).toEqual({
			changed: {
				engagementProfile: { before: "GOVERNED", after: "EXPLORE" },
			},
		});

		expect(result.project.engagementProfile).toBe("EXPLORE");
	});

	it("lets the owner enable enforceSpikeGate now that its run type exists", async () => {
		mockProjectFindUnique.mockResolvedValue(personalProject);
		const result = (await handlers.updateProject({
			input: {
				id: "proj_1",
				organizationId: null,
				enforceSpikeGate: true,
			},
			context: ctxFor("owner_1", null),
		})) as { project: Record<string, unknown> };
		expect(mockTransaction).toHaveBeenCalledTimes(1);
		const updateArgs = mockProjectUpdate.mock.calls[0][0];
		expect(updateArgs.data.enforceSpikeGate).toBe(true);
		const activity = mockProjectActivityCreate.mock.calls[0][0].data;
		expect(activity.metadata).toEqual({
			changed: { enforceSpikeGate: { before: false, after: true } },
		});
		expect(result.project).toBeDefined();
	});

	it("lets the owner enable enforceDiscoveryGate now that its run type exists", async () => {
		mockProjectFindUnique.mockResolvedValue(personalProject);
		const result = (await handlers.updateProject({
			input: {
				id: "proj_1",
				organizationId: null,
				enforceDiscoveryGate: true,
			},
			context: ctxFor("owner_1", null),
		})) as { project: Record<string, unknown> };
		expect(mockTransaction).toHaveBeenCalledTimes(1);
		const updateArgs = mockProjectUpdate.mock.calls[0][0];
		expect(updateArgs.data.enforceDiscoveryGate).toBe(true);
		const activity = mockProjectActivityCreate.mock.calls[0][0].data;
		expect(activity.metadata).toEqual({
			changed: { enforceDiscoveryGate: { before: false, after: true } },
		});
		expect(result.project).toBeDefined();
	});

	it("does not consult the governance permission for non-governance updates", async () => {
		await handlers.updateProject({
			input: { id: "proj_1", organizationId: "org_1", name: "Renamed" },
			context: ctxFor("editor_1", "org_1"),
		});

		// Only the existing-project lookup; no member/org role resolution.
		expect(mockProjectMemberFindUnique).not.toHaveBeenCalled();
		expect(mockMemberFindFirst).not.toHaveBeenCalled();
		expect(mockUpdateProject).toHaveBeenCalledTimes(1);
		expect(mockUpdateProject.mock.calls[0][2].name).toBe("Renamed");
		expect(mockTransaction).not.toHaveBeenCalled();
	});

	it("writes no audit row when a governance field is re-sent with its current value", async () => {
		mockProjectFindUnique.mockResolvedValue(personalProject);

		await handlers.updateProject({
			input: {
				id: "proj_1",
				organizationId: null,
				engagementProfile: "GOVERNED",
				quotedPhases: [],
			},
			context: ctxFor("owner_1", null),
		});

		expect(mockTransaction).not.toHaveBeenCalled();
		expect(mockProjectActivityCreate).not.toHaveBeenCalled();
		expect(mockUpdateProject).toHaveBeenCalledTimes(1);
		expect(
			mockUpdateProject.mock.calls[0][2].engagementProfileUpdatedAt,
		).toBeUndefined();
	});
});
