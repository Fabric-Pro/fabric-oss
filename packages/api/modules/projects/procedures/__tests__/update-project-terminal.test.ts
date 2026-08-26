import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUpdateProject = vi.fn();
const mockGetProject = vi.fn();
const mockSeed = vi.fn();

vi.mock("@repo/database", () => ({
	db: { project: { findUnique: (...a: unknown[]) => mockGetProject(...a) } },
	updateProject: (...a: unknown[]) => mockUpdateProject(...a),
	getProjectById: (...a: unknown[]) => mockGetProject(...a),
	seedTerminalStatusesIfEmpty: (...a: unknown[]) => mockSeed(...a),
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
		projectManagementMcpServerId: "azure-devops",
	});
	mockUpdateProject.mockResolvedValue({ id: "proj-1" });
});

describe("updateProjectProcedure — terminal status fields", () => {
	it("nulls lastAdoStatePollAt when pmTerminalStatuses changes", async () => {
		// Current list differs from the input → diff triggers the re-snapshot.
		mockGetProject.mockResolvedValue({
			id: "proj-1",
			userId: "user-1",
			organizationId: null,
			projectManagementMcpServerId: "azure-devops",
			pmTerminalStatuses: ["Removed"],
		});
		const handler = await loadHandler();
		await handler({
			input: {
				id: "proj-1",
				organizationId: null,
				pmTerminalStatuses: ["Closed", "Done"],
			},
			context: { user: { id: "user-1" }, session: { id: "s" } },
		});
		const dataArg = mockUpdateProject.mock.calls[0][2];
		expect(dataArg.pmTerminalStatuses).toEqual(["Closed", "Done"]);
		expect(dataArg.lastAdoStatePollAt).toBeNull();
	});

	it("does NOT null lastAdoStatePollAt when the list is unchanged", async () => {
		// Current list equals the input (order-insensitive) → no re-snapshot,
		// but the normalized value is still written.
		mockGetProject.mockResolvedValue({
			id: "proj-1",
			userId: "user-1",
			organizationId: null,
			projectManagementMcpServerId: "azure-devops",
			pmTerminalStatuses: ["Done", "Closed"],
		});
		const handler = await loadHandler();
		await handler({
			input: {
				id: "proj-1",
				organizationId: null,
				pmTerminalStatuses: ["Closed", "Done"],
			},
			context: { user: { id: "user-1" }, session: { id: "s" } },
		});
		const dataArg = mockUpdateProject.mock.calls[0][2];
		expect(dataArg.pmTerminalStatuses).toEqual(["Closed", "Done"]);
		expect("lastAdoStatePollAt" in dataArg).toBe(false);
	});

	it("passes pmAutoCloseEnabled through without nulling the poll timestamp", async () => {
		const handler = await loadHandler();
		await handler({
			input: {
				id: "proj-1",
				organizationId: null,
				pmAutoCloseEnabled: true,
			},
			context: { user: { id: "user-1" }, session: { id: "s" } },
		});
		const dataArg = mockUpdateProject.mock.calls[0][2];
		expect(dataArg.pmAutoCloseEnabled).toBe(true);
		expect("lastAdoStatePollAt" in dataArg).toBe(false);
	});

	it("passes clarifyingQuestionFrequency through when provided", async () => {
		const handler = await loadHandler();
		await handler({
			input: {
				id: "proj-1",
				organizationId: null,
				clarifyingQuestionFrequency: "THOROUGH",
			},
			context: { user: { id: "user-1" }, session: { id: "s" } },
		});
		const dataArg = mockUpdateProject.mock.calls[0][2];
		expect(dataArg.clarifyingQuestionFrequency).toBe("THOROUGH");
	});

	it("omits clarifyingQuestionFrequency from the update when not provided", async () => {
		const handler = await loadHandler();
		await handler({
			input: {
				id: "proj-1",
				organizationId: null,
				name: "Renamed",
			},
			context: { user: { id: "user-1" }, session: { id: "s" } },
		});
		const dataArg = mockUpdateProject.mock.calls[0][2];
		expect("clarifyingQuestionFrequency" in dataArg).toBe(false);
	});

	it("passes qaStrategyLevel through when provided", async () => {
		const handler = await loadHandler();
		await handler({
			input: {
				id: "proj-1",
				organizationId: null,
				qaStrategyLevel: "STRICT",
			},
			context: { user: { id: "user-1" }, session: { id: "s" } },
		});
		const dataArg = mockUpdateProject.mock.calls[0][2];
		expect(dataArg.qaStrategyLevel).toBe("STRICT");
	});

	it("omits qaStrategyLevel from the update when not provided", async () => {
		const handler = await loadHandler();
		await handler({
			input: {
				id: "proj-1",
				organizationId: null,
				name: "Renamed",
			},
			context: { user: { id: "user-1" }, session: { id: "s" } },
		});
		const dataArg = mockUpdateProject.mock.calls[0][2];
		expect("qaStrategyLevel" in dataArg).toBe(false);
	});
});
