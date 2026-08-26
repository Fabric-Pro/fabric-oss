/**
 * `syncAttachments` may not be switched ON while PM attachment sync does not
 * exist.
 *
 * Hiding the project-settings toggle (`NEXT_PUBLIC_FABRIC_FEATURE_PM_ATTACHMENT_SYNC`)
 * removed the only surface that shows or clears this column, and a migration
 * cleared the values already stored. Neither closes the write path: `PATCH
 * /projects/:id` is a routed, OpenAPI-tagged endpoint, so any caller holding
 * PROJECT_SETTINGS_EDIT can still set the column to `true` — invisibly, since
 * nothing renders it — and the sync engine would later read that as standing
 * consent and start pushing a project's attachments to its linked work item.
 * The migration fixed the stock; this fixes the flow.
 *
 * Only `true` is refused. `false` stays legal in every case, because it is the
 * value every project now holds: a client that PATCHes a whole project object
 * round-tripped from `projects.get` must keep working, and clearing something
 * that does nothing is never the request worth blocking. The disconnect and
 * archive paths force `false` from outside the input and are untouched.
 *
 * BAD_REQUEST rather than a silent drop: a caller asking for a behaviour the
 * deployment cannot perform should be told, not quietly told "ok".
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

const FLAG = "FABRIC_FEATURE_PM_ATTACHMENT_SYNC";

function call(input: Record<string, unknown>) {
	return loadHandler().then((handler) =>
		handler({
			input: { id: "p1", organizationId: null, ...input },
			context: { user: { id: "user-1" }, session: { id: "s" } },
		}),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.unstubAllEnvs();
	mockGetProject.mockResolvedValue({
		id: "p1",
		userId: "user-1",
		organizationId: null,
	});
	mockUpdateProject.mockResolvedValue({ id: "p1" });
	mockResolveAccess.mockResolvedValue({
		source: "owner",
		permissions: [],
		organizationId: null,
	});
});

describe("updateProject — syncAttachments feature gate", () => {
	it("refuses to switch the flag on while the feature is off", async () => {
		await expect(call({ syncAttachments: true })).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		expect(mockUpdateProject).not.toHaveBeenCalled();
	});

	it('refuses a non-enabling flag value the same way (only the literal "true" enables)', async () => {
		vi.stubEnv(FLAG, "1");
		await expect(call({ syncAttachments: true })).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
	});

	it("still lets a caller clear the flag while the feature is off", async () => {
		await call({ syncAttachments: false });
		expect(mockUpdateProject.mock.calls[0][2]).toMatchObject({
			syncAttachments: false,
		});
	});

	it("writes the flag once the feature is enabled", async () => {
		vi.stubEnv(FLAG, "true");
		await call({ syncAttachments: true });
		expect(mockUpdateProject.mock.calls[0][2]).toMatchObject({
			syncAttachments: true,
		});
	});

	it("leaves an unrelated update alone while the feature is off", async () => {
		await call({ name: "Renamed" });
		expect(mockUpdateProject.mock.calls[0][2]).not.toHaveProperty(
			"syncAttachments",
		);
	});

	it("keeps forcing the flag off on PM disconnect, which never comes from the input", async () => {
		await call({ projectManagementMcpConfigId: null });
		expect(mockUpdateProject.mock.calls[0][2].syncAttachments).toBe(false);
	});

	it("lets a disconnect carrying syncAttachments:true through, because the disconnect forces it off anyway", async () => {
		await call({
			projectManagementMcpConfigId: null,
			syncAttachments: true,
		});
		expect(mockUpdateProject.mock.calls[0][2].syncAttachments).toBe(false);
	});

	it("lets an archive carrying syncAttachments:true through for the same reason", async () => {
		await call({ status: "ARCHIVED", syncAttachments: true });
		expect(mockUpdateProject.mock.calls[0][2].syncAttachments).toBe(false);
	});

	it("rejects an unauthorized caller on permissions, not on the feature gate", async () => {
		mockResolveAccess.mockResolvedValue({
			source: "org-role",
			permissions: ["PROJECT_UPDATE"],
			organizationId: null,
		});
		await expect(call({ syncAttachments: true })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});
});
