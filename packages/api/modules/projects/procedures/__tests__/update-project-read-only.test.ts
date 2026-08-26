/**
 * Read-only mode toggle permission guard.
 *
 * `readOnlyMode` is stricter than the procedure's PROJECT_UPDATE gate: only
 * callers with PROJECT_SETTINGS_EDIT (org admin/owner, project
 * OWNER/PROJECT_ADMIN) — or the personal-project owner — may change it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUpdateProject = vi.fn();
const mockGetProject = vi.fn();
const mockResolveAccess = vi.fn();

vi.mock("@repo/database", () => ({
	db: { project: { findUnique: (...a: unknown[]) => mockGetProject(...a) } },
	updateProject: (...a: unknown[]) => mockUpdateProject(...a),
	getProjectById: (...a: unknown[]) => mockGetProject(...a),
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

vi.mock("@repo/permissions", () => ({
	hasPermission: (perms: string[], p: string) => perms.includes(p),
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
	context: { user: { id: string }; session: { id: string } };
}) => Promise<unknown>;

async function loadHandler(): Promise<Handler> {
	const mod = await import("../update-project");
	return (mod.updateProjectProcedure as unknown as { handler: Handler })
		.handler;
}

beforeEach(() => {
	vi.clearAllMocks();
	mockGetProject.mockResolvedValue({
		id: "proj-1",
		userId: "user-1",
		organizationId: null,
	});
	mockUpdateProject.mockResolvedValue({ id: "proj-1" });
});

describe("updateProjectProcedure — readOnlyMode field guard", () => {
	it("rejects a caller without PROJECT_SETTINGS_EDIT (AC9)", async () => {
		mockResolveAccess.mockResolvedValue({
			source: "org-role",
			permissions: ["PROJECT_UPDATE"], // member/editor grant
			organizationId: null,
		});
		const handler = await loadHandler();
		await expect(
			handler({
				input: {
					id: "proj-1",
					organizationId: null,
					readOnlyMode: true,
				},
				context: { user: { id: "user-2" }, session: { id: "s" } },
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mockUpdateProject).not.toHaveBeenCalled();
	});

	it("allows a caller with PROJECT_SETTINGS_EDIT and writes the flag", async () => {
		mockResolveAccess.mockResolvedValue({
			source: "org-role",
			permissions: ["PROJECT_UPDATE", "PROJECT_SETTINGS_EDIT"],
			organizationId: null,
		});
		const handler = await loadHandler();
		await handler({
			input: { id: "proj-1", organizationId: null, readOnlyMode: true },
			context: { user: { id: "user-1" }, session: { id: "s" } },
		});
		const dataArg = mockUpdateProject.mock.calls[0][2];
		expect(dataArg.readOnlyMode).toBe(true);
	});

	it("allows the personal-project owner unconditionally", async () => {
		mockResolveAccess.mockResolvedValue({
			source: "owner",
			permissions: [],
			organizationId: null,
		});
		const handler = await loadHandler();
		await handler({
			input: { id: "proj-1", organizationId: null, readOnlyMode: false },
			context: { user: { id: "user-1" }, session: { id: "s" } },
		});
		const dataArg = mockUpdateProject.mock.calls[0][2];
		expect(dataArg.readOnlyMode).toBe(false);
	});

	it("does not resolve permissions or write the flag when readOnlyMode is absent", async () => {
		const handler = await loadHandler();
		await handler({
			input: { id: "proj-1", organizationId: null, name: "Renamed" },
			context: { user: { id: "user-1" }, session: { id: "s" } },
		});
		expect(mockResolveAccess).not.toHaveBeenCalled();
		const dataArg = mockUpdateProject.mock.calls[0][2];
		expect("readOnlyMode" in dataArg).toBe(false);
	});
});
