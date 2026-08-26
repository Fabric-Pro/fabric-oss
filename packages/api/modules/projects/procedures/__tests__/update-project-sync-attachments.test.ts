/**
 * Per-project attachment-sync toggle write-through and permission guard
 * (Fizzy #1746).
 *
 * `syncAttachments` follows the same conditional-spread pass-through as
 * `readOnlyMode` and `pmAutoCloseEnabled`: present in input → written to the
 * update data; absent → left untouched. It is gated the same way as
 * `readOnlyMode` too — only a caller with PROJECT_SETTINGS_EDIT (org
 * admin/owner, project OWNER/PROJECT_ADMIN) or the personal-project owner may
 * flip it, since enabling it starts pushing every story's attachments to the
 * linked PM tool and the UI only exposes the toggle to project owners. These
 * tests call the real handler and assert against the data passed to
 * updateProject().
 *
 * These cases are about write-through and authorization, so they enable
 * FABRIC_FEATURE_PM_ATTACHMENT_SYNC — the API refuses to switch the column ON
 * while the feature is off, which is covered in
 * update-project-sync-attachments-feature-gate.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
		id: "p1",
		userId: "user-1",
		organizationId: null,
	});
	mockUpdateProject.mockResolvedValue({ id: "p1" });
	vi.stubEnv("FABRIC_FEATURE_PM_ATTACHMENT_SYNC", "true");
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("updateProject syncAttachments write-through (Fizzy #1746)", () => {
	it("persists the flag when supplied by an owner", async () => {
		mockResolveAccess.mockResolvedValue({
			source: "owner",
			permissions: [],
			organizationId: null,
		});
		const handler = await loadHandler();
		await handler({
			input: { id: "p1", organizationId: null, syncAttachments: true },
			context: { user: { id: "user-1" }, session: { id: "s" } },
		});
		const dataArg = mockUpdateProject.mock.calls[0][2];
		expect(dataArg).toMatchObject({ syncAttachments: true });
	});

	it("leaves the flag untouched, and does not resolve permissions, when omitted", async () => {
		const handler = await loadHandler();
		await handler({
			input: { id: "p1", organizationId: null, name: "Renamed" },
			context: { user: { id: "user-1" }, session: { id: "s" } },
		});
		expect(mockResolveAccess).not.toHaveBeenCalled();
		const dataArg = mockUpdateProject.mock.calls[0][2];
		expect(dataArg).not.toHaveProperty("syncAttachments");
	});

	it("clears the flag when the PM tool is disconnected (projectManagementMcpConfigId: null), even though the UI hides the toggle at that point", async () => {
		const handler = await loadHandler();
		await handler({
			input: {
				id: "p1",
				organizationId: null,
				projectManagementMcpConfigId: null,
			},
			context: { user: { id: "user-1" }, session: { id: "s" } },
		});
		const dataArg = mockUpdateProject.mock.calls[0][2];
		expect(dataArg.syncAttachments).toBe(false);
		expect(dataArg.adoStatePollActive).toBe(false);
	});

	it("clears the flag when the project is archived", async () => {
		const handler = await loadHandler();
		await handler({
			input: { id: "p1", organizationId: null, status: "ARCHIVED" },
			context: { user: { id: "user-1" }, session: { id: "s" } },
		});
		const dataArg = mockUpdateProject.mock.calls[0][2];
		expect(dataArg.syncAttachments).toBe(false);
	});

	it("disconnect wins over an explicit syncAttachments:true in the same request", async () => {
		mockResolveAccess.mockResolvedValue({
			source: "owner",
			permissions: [],
			organizationId: null,
		});
		const handler = await loadHandler();
		await handler({
			input: {
				id: "p1",
				organizationId: null,
				projectManagementMcpConfigId: null,
				syncAttachments: true,
			},
			context: { user: { id: "user-1" }, session: { id: "s" } },
		});
		const dataArg = mockUpdateProject.mock.calls[0][2];
		expect(dataArg.syncAttachments).toBe(false);
	});
});

describe("updateProjectProcedure — syncAttachments field guard", () => {
	it("rejects a caller without PROJECT_SETTINGS_EDIT (e.g. a project editor)", async () => {
		mockResolveAccess.mockResolvedValue({
			source: "org-role",
			permissions: ["PROJECT_UPDATE"], // member/editor grant
			organizationId: null,
		});
		const handler = await loadHandler();
		await expect(
			handler({
				input: {
					id: "p1",
					organizationId: null,
					syncAttachments: true,
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
			input: { id: "p1", organizationId: null, syncAttachments: true },
			context: { user: { id: "user-1" }, session: { id: "s" } },
		});
		const dataArg = mockUpdateProject.mock.calls[0][2];
		expect(dataArg.syncAttachments).toBe(true);
	});

	it("allows the personal-project owner unconditionally", async () => {
		mockResolveAccess.mockResolvedValue({
			source: "owner",
			permissions: [],
			organizationId: null,
		});
		const handler = await loadHandler();
		await handler({
			input: { id: "p1", organizationId: null, syncAttachments: false },
			context: { user: { id: "user-1" }, session: { id: "s" } },
		});
		const dataArg = mockUpdateProject.mock.calls[0][2];
		expect(dataArg.syncAttachments).toBe(false);
	});
});
