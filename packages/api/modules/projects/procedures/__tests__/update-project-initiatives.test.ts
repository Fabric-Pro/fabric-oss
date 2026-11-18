/**
 * Initiatives toggle: permission guard on update-project, and initiativeCount on get-project.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUpdateProject = vi.fn();
const mockGetProject = vi.fn();
const mockResolveAccess = vi.fn();
const mockCountProjectInitiatives = vi.fn();

vi.mock("@repo/database", async () => ({
	engagementProfileSchema: (await import("zod")).z.enum([
		"EXPLORE",
		"PROPOSAL",
		"GOVERNED",
		"DELEGATED",
	]),
	db: {
		project: { findUnique: (...a: unknown[]) => mockGetProject(...a) },
		member: { findFirst: vi.fn().mockResolvedValue({ role: "admin" }) },
	},
	updateProject: (...a: unknown[]) => mockUpdateProject(...a),
	getProjectById: (...a: unknown[]) => mockGetProject(...a),
	countProjectInitiatives: (...a: unknown[]) =>
		mockCountProjectInitiatives(...a),
	getProjectRole: vi.fn(),
	hasProjectAccess: vi.fn().mockResolvedValue(true),
	isFeatureEnabled: vi.fn().mockReturnValue(false),
	resolveAttachmentRetentionOverrides: vi.fn().mockResolvedValue(new Map()),
	seedTerminalStatusesIfEmpty: vi.fn(),
	Prisma: { JsonNull: Symbol("JsonNull") },
	cleanupCodeSearchOnRepoUnlink: vi.fn(async () => ({
		deletedContextQdrantIds: [],
		organizationId: null,
	})),
	moveWizardTempContextsToProject: vi.fn(async () => ({
		movedCount: 0,
		contextIds: [],
		contextIdMapping: {},
		sessionId: "s",
	})),
	syncLegacyProjectRepoOnDisconnect: vi.fn(async () => {}),
	setAiUsageRecorder: vi.fn(),
	GATEWAY_PROVIDERS: new Set(["OPENAI", "ANTHROPIC"]),
	DB_GATEWAY_PROVIDERS: ["OPENAI", "ANTHROPIC"],
	AI_PROVIDER_METADATA: {},
}));

vi.mock("../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: (...a: unknown[]) =>
		mockResolveAccess(...a),
}));

vi.mock("../../../../lib/project-permissions", () => ({
	userHasProjectPermission: vi.fn().mockResolvedValue(true),
	userHasProjectPermissionStrict: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../lib/governance", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../lib/governance")>();
	return {
		...actual,
		userHasProjectPermissionStrict: vi.fn().mockResolvedValue(true),
	};
});

vi.mock("@repo/permissions", () => ({
	hasPermission: (perms: string[], p: string) => perms.includes(p),
	Permissions: {
		PROJECT_UPDATE: "PROJECT_UPDATE",
		PROJECT_SETTINGS_EDIT: "PROJECT_SETTINGS_EDIT",
		STORY_UPDATE: "STORY_UPDATE",
		STORY_CREATE: "STORY_CREATE",
		AI_RECOMMENDED_LIFECYCLE: "AI_RECOMMENDED_LIFECYCLE",
	},
}));

vi.mock("../../../../orpc/procedures", () => {
	const builder: Record<string, unknown> = {};
	builder.use = () => builder;
	builder.route = () => builder;
	builder.input = () => builder;
	builder.handler = (fn: unknown) => ({ handler: fn });
	return {
		tenantProtectedProcedure: builder,
		resolveOrganizationId: (o: string | null | undefined) => o ?? null,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: () => (c: unknown) => c,
	};
});

type Handler = (args: {
	input: Record<string, unknown>;
	context: { user: { id: string; role?: string }; session: { id: string } };
}) => Promise<unknown>;

async function loadUpdateHandler(): Promise<Handler> {
	const mod = await import("../update-project");
	return (mod.updateProjectProcedure as unknown as { handler: Handler })
		.handler;
}

async function loadGetHandler(): Promise<Handler> {
	const mod = await import("../get-project");
	return (mod.getProjectProcedure as unknown as { handler: Handler }).handler;
}

beforeEach(() => {
	vi.clearAllMocks();
	mockGetProject.mockResolvedValue({
		id: "proj-1",
		userId: "user-1",
		organizationId: "org-1",
		initiativesEnabled: true,
	});
	mockUpdateProject.mockResolvedValue({ id: "proj-1" });
	mockCountProjectInitiatives.mockResolvedValue(4);
});

describe("updateProjectProcedure — initiativesEnabled field guard", () => {
	it("rejects a caller without PROJECT_SETTINGS_EDIT", async () => {
		mockResolveAccess.mockResolvedValue({
			source: "org-role",
			permissions: ["PROJECT_UPDATE"],
			organizationId: null,
		});
		const handler = await loadUpdateHandler();
		await expect(
			handler({
				input: {
					id: "proj-1",
					organizationId: null,
					initiativesEnabled: true,
				},
				context: { user: { id: "user-2" }, session: { id: "s" } },
			}),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			message:
				"Only project admins or owners can turn Initiatives on or off.",
		});
		expect(mockUpdateProject).not.toHaveBeenCalled();
	});

	it("allows an admin with PROJECT_SETTINGS_EDIT and writes initiativesEnabled", async () => {
		mockResolveAccess.mockResolvedValue({
			source: "org-role",
			permissions: ["PROJECT_UPDATE", "PROJECT_SETTINGS_EDIT"],
			organizationId: null,
		});
		const handler = await loadUpdateHandler();
		await handler({
			input: {
				id: "proj-1",
				organizationId: null,
				initiativesEnabled: true,
			},
			context: { user: { id: "user-1" }, session: { id: "s" } },
		});
		const dataArg = mockUpdateProject.mock.calls[0][2];
		expect(dataArg.initiativesEnabled).toBe(true);
	});
});

describe("getProjectProcedure — initiativeCount calculation", () => {
	it("counts initiatives when initiativesEnabled is true", async () => {
		mockGetProject.mockResolvedValue({
			id: "proj-1",
			userId: "user-1",
			organizationId: "org-1",
			initiativesEnabled: true,
		});
		mockCountProjectInitiatives.mockResolvedValue(7);

		const handler = await loadGetHandler();
		const result = (await handler({
			input: { id: "proj-1" },
			context: { user: { id: "user-1" }, session: { id: "s" } },
		})) as { project: { initiativeCount: number } };

		expect(result.project.initiativeCount).toBe(7);
		expect(mockCountProjectInitiatives).toHaveBeenCalledWith("proj-1");
	});

	it("skips counting and returns 0 when initiativesEnabled is false", async () => {
		mockGetProject.mockResolvedValue({
			id: "proj-1",
			userId: "user-1",
			organizationId: "org-1",
			initiativesEnabled: false,
		});

		const handler = await loadGetHandler();
		const result = (await handler({
			input: { id: "proj-1" },
			context: { user: { id: "user-1" }, session: { id: "s" } },
		})) as { project: { initiativeCount: number } };

		expect(result.project.initiativeCount).toBe(0);
		expect(mockCountProjectInitiatives).not.toHaveBeenCalled();
	});
});
