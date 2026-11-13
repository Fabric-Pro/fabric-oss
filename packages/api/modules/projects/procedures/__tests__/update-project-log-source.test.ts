/**
 * The project's log-source binding, set from Settings ▸ Testing.
 *
 * It names the log workspace a scheduled scan reads with the worker's own
 * identity, so it carries the same admin/owner guard as the recurring-error
 * toggle, and it is written through `setProjectLogSourceBinding` and audited
 * like every other update-project field.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	projectLogSourceInputSchema,
	SHARED_LOG_WORKSPACE_MESSAGE,
} from "../../lib/log-source-input";

const mockUpdateProject = vi.fn();
const mockGetProject = vi.fn();
const mockResolveAccess = vi.fn();
const mockSetBinding = vi.fn();
const mockRecordAudit = vi.fn();

vi.mock("@repo/database", async () => ({
	engagementProfileSchema: (await import("zod")).z.enum([
		"EXPLORE",
		"PROPOSAL",
		"GOVERNED",
		"DELEGATED",
	]),

	db: { project: { findUnique: (...a: unknown[]) => mockGetProject(...a) } },
	updateProject: (...a: unknown[]) => mockUpdateProject(...a),
	setProjectLogSourceBinding: (...a: unknown[]) => mockSetBinding(...a),
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

vi.mock("../../../../lib/audit", () => ({
	recordAuditFromRequest: (...a: unknown[]) => mockRecordAudit(...a),
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

const context = { user: { id: "user-1" }, session: { id: "s" } };
const WORKSPACE_ID = "0b6f3c1e-2d4a-4e8b-9c7d-5a1f2e3d4c5b";

function asAdmin() {
	mockResolveAccess.mockResolvedValue({
		source: "org-role",
		permissions: ["PROJECT_UPDATE", "PROJECT_SETTINGS_EDIT"],
		organizationId: null,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mockGetProject.mockResolvedValue({
		id: "proj-1",
		userId: "user-1",
		organizationId: "org-1",
	});
	mockUpdateProject.mockResolvedValue({ id: "proj-1", name: "Example" });
});

describe("updateProjectProcedure — logSource", () => {
	it("lets a project admin bind an Azure Monitor workspace", async () => {
		asAdmin();
		const handler = await loadHandler();

		await handler({
			input: {
				id: "proj-1",
				logSource: {
					provider: "azure-monitor",
					workspaceId: WORKSPACE_ID,
				},
			},
			context,
		});

		expect(mockSetBinding).toHaveBeenCalledWith("proj-1", {
			provider: "azure-monitor",
			config: { workspaceId: WORKSPACE_ID },
		});
		// The tenant-filtered project write runs first.
		expect(mockUpdateProject.mock.invocationCallOrder[0]).toBeLessThan(
			mockSetBinding.mock.invocationCallOrder[0],
		);
		expect(mockRecordAudit).toHaveBeenCalledWith(
			context,
			expect.objectContaining({
				action: "project.updated",
				metadata: expect.objectContaining({
					changedFields: ["logSource"],
					logSource: {
						provider: "azure-monitor",
						workspaceId: WORKSPACE_ID,
					},
				}),
			}),
		);
	});

	it("lets a project admin clear it with null", async () => {
		asAdmin();
		const handler = await loadHandler();

		await handler({ input: { id: "proj-1", logSource: null }, context });

		expect(mockSetBinding).toHaveBeenCalledWith("proj-1", null);
		expect(mockRecordAudit).toHaveBeenCalledWith(
			context,
			expect.objectContaining({
				metadata: expect.objectContaining({
					changedFields: ["logSource"],
					logSource: null,
				}),
			}),
		);
	});

	it.each([
		["set", { provider: "azure-monitor", workspaceId: WORKSPACE_ID }],
		["clear", null],
	])(
		"refuses a member without PROJECT_SETTINGS_EDIT (%s)",
		async (_label, logSource) => {
			mockResolveAccess.mockResolvedValue({
				source: "org-role",
				permissions: ["PROJECT_UPDATE"],
				organizationId: null,
			});
			const handler = await loadHandler();

			await expect(
				handler({
					input: { id: "proj-1", logSource },
					context: { user: { id: "user-2" }, session: { id: "s" } },
				}),
			).rejects.toMatchObject({
				code: "FORBIDDEN",
				message:
					"Only project admins or owners can change the project's log source.",
			});
			expect(mockUpdateProject).not.toHaveBeenCalled();
			expect(mockSetBinding).not.toHaveBeenCalled();
		},
	);

	it("leaves the binding untouched when the field is absent", async () => {
		const handler = await loadHandler();

		await handler({ input: { id: "proj-1", name: "Renamed" }, context });

		expect(mockResolveAccess).not.toHaveBeenCalled();
		expect(mockSetBinding).not.toHaveBeenCalled();
	});
});

describe("projectLogSourceInputSchema", () => {
	it("accepts an Azure Monitor workspace GUID and null", () => {
		expect(
			projectLogSourceInputSchema.safeParse({
				provider: "azure-monitor",
				workspaceId: WORKSPACE_ID,
			}).success,
		).toBe(true);
		expect(projectLogSourceInputSchema.safeParse(null).success).toBe(true);
	});

	it.each([
		"not-a-guid",
		"",
		"0b6f3c1e2d4a4e8b9c7d5a1f2e3d4c5b",
		`${WORKSPACE_ID}; drop`,
	])("rejects a malformed workspace id %j", (workspaceId) => {
		const parsed = projectLogSourceInputSchema.safeParse({
			provider: "azure-monitor",
			workspaceId,
		});
		expect(parsed.success).toBe(false);
	});

	it("rejects a provider the settings cannot configure", () => {
		expect(
			projectLogSourceInputSchema.safeParse({
				provider: "datadog",
				workspaceId: WORKSPACE_ID,
			}).success,
		).toBe(false);
	});
});

describe("updateProjectProcedure — the deployment's shared telemetry workspace", () => {
	const SHARED_ID = "7c2e9a41-5b3d-4f6e-8a1c-2d9b0e4f7a63";
	const bind = (workspaceId: string) => ({
		id: "proj-1",
		logSource: { provider: "azure-monitor", workspaceId },
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it.each([SHARED_ID, SHARED_ID.toUpperCase()])(
		"refuses %s before writing anything, and says why",
		async (workspaceId) => {
			vi.stubEnv("FABRIC_BUG_ANALYSIS_LOG_WORKSPACE_ID", SHARED_ID);
			asAdmin();
			const handler = await loadHandler();

			await expect(
				handler({ input: bind(workspaceId), context }),
			).rejects.toMatchObject({
				code: "BAD_REQUEST",
				message: SHARED_LOG_WORKSPACE_MESSAGE,
			});
			expect(mockUpdateProject).not.toHaveBeenCalled();
			expect(mockSetBinding).not.toHaveBeenCalled();
		},
	);

	it("still answers FORBIDDEN to a caller who may not change the log source", async () => {
		vi.stubEnv("FABRIC_BUG_ANALYSIS_LOG_WORKSPACE_ID", SHARED_ID);
		mockResolveAccess.mockResolvedValue({
			source: "org-role",
			permissions: ["PROJECT_UPDATE"],
			organizationId: null,
		});
		const handler = await loadHandler();

		await expect(
			handler({ input: bind(SHARED_ID), context }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("saves a different workspace while the shared one is configured", async () => {
		vi.stubEnv("FABRIC_BUG_ANALYSIS_LOG_WORKSPACE_ID", SHARED_ID);
		asAdmin();
		const handler = await loadHandler();

		await handler({ input: bind(WORKSPACE_ID), context });

		expect(mockSetBinding).toHaveBeenCalled();
	});

	it("has nothing to refuse where the deployment names no shared workspace", async () => {
		vi.stubEnv("FABRIC_BUG_ANALYSIS_LOG_WORKSPACE_ID", "");
		asAdmin();
		const handler = await loadHandler();

		await handler({ input: bind(SHARED_ID), context });

		expect(mockSetBinding).toHaveBeenCalled();
	});
});
