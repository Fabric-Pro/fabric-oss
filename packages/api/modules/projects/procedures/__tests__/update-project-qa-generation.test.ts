/**
 * QA test-case generation settings write-through.
 *
 * Guards the exact bug review caught: the two settings were added to the zod
 * input and to updateProject()'s type, but the handler's updateProject() call
 * dropped them — so the API accepted the fields, toasted success, and never
 * persisted anything (and the audit log recorded a change that never happened).
 * These tests call the real handler and assert the fields reach updateProject.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUpdateProject = vi.fn();
const mockGetProject = vi.fn();

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
	resolveEffectiveProjectPermissions: vi.fn(),
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

const ctx = { user: { id: "user-1" }, session: { id: "s" } };

beforeEach(() => {
	vi.clearAllMocks();
	mockGetProject.mockResolvedValue({
		id: "proj-1",
		userId: "user-1",
		organizationId: null,
	});
	mockUpdateProject.mockResolvedValue({ id: "proj-1" });
});

describe("updateProjectProcedure — QA generation settings write-through", () => {
	it("persists generateManualTestCases when provided", async () => {
		const handler = await loadHandler();
		await handler({
			input: {
				id: "proj-1",
				organizationId: null,
				generateManualTestCases: false,
			},
			context: ctx,
		});
		const dataArg = mockUpdateProject.mock.calls[0][2];
		expect(dataArg.generateManualTestCases).toBe(false);
	});

	it("persists applyTddApproach when provided", async () => {
		const handler = await loadHandler();
		await handler({
			input: {
				id: "proj-1",
				organizationId: null,
				applyTddApproach: true,
			},
			context: ctx,
		});
		const dataArg = mockUpdateProject.mock.calls[0][2];
		expect(dataArg.applyTddApproach).toBe(true);
	});

	it("does not write either field when absent (no accidental default clobber)", async () => {
		const handler = await loadHandler();
		await handler({
			input: { id: "proj-1", organizationId: null, name: "Renamed" },
			context: ctx,
		});
		const dataArg = mockUpdateProject.mock.calls[0][2];
		expect("generateManualTestCases" in dataArg).toBe(false);
		expect("applyTddApproach" in dataArg).toBe(false);
	});
});
