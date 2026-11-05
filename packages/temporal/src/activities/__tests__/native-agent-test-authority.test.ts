import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	row: vi.fn(),
	admission: vi.fn(),
	source: vi.fn(),
	scope: vi.fn(),
	executePermission: vi.fn(),
	deployment: vi.fn(),
	fetch: vi.fn(),
	memory: vi.fn(),
	build: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: { agentDeploymentExecution: { findFirst: m.row } },
	readAgentExecutionAdmission: m.admission,
	canExecuteOrganizationAgents: m.executePermission,
	getAgentDeploymentById: m.deployment,
	getProjectAccessContext: vi.fn(),
	isProjectSoftDeleted: vi.fn(),
	filterWorkspaceIdsForTenant: vi.fn(),
	appendTemplateMessage: vi.fn(),
	getTemplateConversationMessages: vi.fn(),
	updateExecutionStatus: vi.fn(),
	loadAgentMemoryContext: m.memory,
}));
vi.mock("../../lib/agent-test-access", () => ({
	loadAgentTestScope: m.scope,
	assertAgentTestSourceScope: m.source,
}));
vi.mock("@temporalio/activity", () => ({
	Context: {
		current: () => ({
			info: {
				workflowType: "nativeDeploymentExecutionWorkflow",
				workflowExecution: {
					workflowId: "example-native",
					runId: "example-run",
				},
			},
			cancellationSignal: new AbortController().signal,
		}),
	},
	heartbeat: vi.fn(),
}));
vi.mock("../agent-execution-core", () => ({
	buildAgentExecutionContext: m.build,
	buildKnowledgeContextPrompt: vi.fn(),
	buildUserInputContext: vi.fn(),
	executeAgentTurn: vi.fn(),
	extractBuiltInToolNames: vi.fn(() => []),
	extractMcpConfigIds: vi.fn(() => []),
	fetchKnowledgeSources: m.fetch,
}));

import {
	fetchKnowledge,
	loadDeploymentConfiguration,
} from "../deployment-execution";
import {
	assertFrozenAgentTestWorkspaceSelection,
	assertNativeAgentTestBoundary,
	withNativeAgentTestBoundary,
} from "../shared/native-agent-test-authority";

const actor = { userId: "example-user", organizationId: "example-org" };
const source = {
	instanceId: "example-instance",
	configHash: "a".repeat(64),
	workspaceIds: ["example-workspace"],
	workspaceDocumentFilters: [
		{
			workspaceId: "example-workspace",
			documentIds: ["example-selected-document"],
		},
	],
	skillIds: [],
};
const authority = {
	testRunId: "example-test",
	origin: source,
	execution: source,
};
const boundary = { executionId: "example-execution", authority };
const admission = {
	dispatch: {
		instanceId: source.instanceId,
		workflowType: "nativeDeploymentExecutionWorkflow",
		testAuthority: authority,
	},
};
const metadata = {
	...actor,
	workflowId: "example-native",
	runId: "example-run",
	status: "RUNNING",
	metadata: {},
	deployment: { status: "ACTIVE", ...actor },
};
const configuration = {
	instance: {
		id: source.instanceId,
		name: "Example saved",
		description: null,
		customInstructions: { role: "Frozen instructions" },
		modelOverride: "example-model",
		modelConfig: null,
		toolConnections: { "example-frozen-tool": { enabled: true } },
		workspaceIds: source.workspaceIds,
	},
	template: {
		id: "example-template",
		name: "Example",
		slug: "example",
		displayName: "Example",
		description: "Example",
		instructions: "Frozen template",
		suggestedModel: null,
	},
	bindings: [
		{ id: "example-binding", mcpConfigId: "example-mcp", isEnabled: true },
	],
	integrations: [
		{
			id: "example-binding",
			integrationId: "example-integration",
			integrationType: "EXAMPLE",
			isEnabled: true,
			allowedResources: { ids: ["example-resource"] },
		},
	],
	memoryFiles: [
		{
			id: "example-memory",
			version: 3,
			contentHash: "example-content-hash",
			sourceSkillId: null,
		},
	],
};
beforeEach(() => {
	vi.resetAllMocks();
	m.executePermission.mockResolvedValue(true);
	m.row.mockResolvedValue(metadata);
	m.admission.mockReturnValue(admission);
	m.source.mockImplementation(async (_actor, scope) => scope);
	m.scope.mockResolvedValue({
		scope: source,
		instance: configuration.instance,
		configuration,
	});
	m.fetch.mockResolvedValue({
		chunks: [],
		totalChunks: 0,
		sourcesFetched: [],
	});
});
describe("frozen native test source boundary", () => {
	it("leaves ordinary native executions unchanged when no server policy exists", async () => {
		const run = vi.fn(async () => "example");
		await expect(withNativeAgentTestBoundary(actor, run)).resolves.toBe(
			"example",
		);
		expect(m.row).not.toHaveBeenCalled();
		expect(m.scope).not.toHaveBeenCalled();
	});
	it("binds the optional workflow marker to immutable native admission and exact current actor/workflow/run", async () => {
		await assertNativeAgentTestBoundary({
			...actor,
			nativeTestBoundary: boundary,
		});
		expect(m.row).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { executionId: boundary.executionId, ...actor },
			}),
		);
		expect(m.source).toHaveBeenCalledWith(actor, authority.origin);
		expect(m.source).toHaveBeenCalledWith(actor, authority.execution);
	});
	it("rejects a forged descriptor instead of treating workflow input as authority", async () => {
		await expect(
			assertNativeAgentTestBoundary({
				...actor,
				nativeTestBoundary: {
					...boundary,
					authority: { ...authority, testRunId: "example-forged" },
				},
			}),
		).rejects.toMatchObject({ type: "SAVED_AGENT_STEP_FORBIDDEN" });
		expect(m.scope).not.toHaveBeenCalled();
	});
	it("refuses a changed source configuration before any native configuration, retrieval or model can load", async () => {
		m.scope.mockResolvedValue({
			scope: { ...source, configHash: "b".repeat(64) },
			instance: configuration.instance,
			configuration,
		});
		await expect(
			loadDeploymentConfiguration({
				...actor,
				deploymentId: "example-deployment",
				nativeTestBoundary: boundary,
			}),
		).rejects.toMatchObject({ type: "SAVED_AGENT_STEP_FORBIDDEN" });
		expect(m.deployment).not.toHaveBeenCalled();
		expect(m.memory).not.toHaveBeenCalled();
		expect(m.fetch).not.toHaveBeenCalled();
		expect(m.build).not.toHaveBeenCalled();
	});
	it("constructs actual execution sources and tools from the very metadata snapshot whose hash matched", async () => {
		m.deployment.mockResolvedValue({
			instance: {
				...configuration.instance,
				workspaceIds: ["example-new-private-workspace"],
				toolConnections: { "example-new-tool": { enabled: true } },
			},
		});
		const loaded = await loadDeploymentConfiguration({
			...actor,
			deploymentId: "example-deployment",
			nativeTestBoundary: boundary,
		});
		expect(m.deployment).not.toHaveBeenCalled();
		expect(loaded).toMatchObject({
			workspaceIds: source.workspaceIds,
			workspaceDocumentFilters: source.workspaceDocumentFilters,
			mcpConfigIds: ["example-mcp"],
			toolConnections: configuration.instance.toolConnections,
			integrationConfigurations: [
				{
					integrationId: "example-integration",
					integrationType: "EXAMPLE",
					allowedResources: { ids: ["example-resource"] },
				},
			],
			frozenMemoryFiles: configuration.memoryFiles,
		});
	});
	it("never sends a broader recorded workspace/document selector to native retrieval", async () => {
		const context = {
			agentInstanceId: source.instanceId,
			systemPrompt: "Example",
			model: "example-model",
			tools: [],
			knowledgeSources: [],
			integrationConfigurations: [],
			workspaceIds: ["example-new-workspace"],
			workspaceDocumentFilters: [],
			mcpConfigIds: [],
			builtInToolNames: [],
			nativeTestBoundary: boundary,
		};
		await expect(
			fetchKnowledge({
				...actor,
				executionId: boundary.executionId,
				query: "Example",
				context,
			}),
		).rejects.toMatchObject({ type: "SAVED_AGENT_STEP_FORBIDDEN" });
		expect(m.fetch).not.toHaveBeenCalled();
	});
	it.each(["role", "source", "identity"])(
		"refuses current %s loss before a protected read",
		async (kind) => {
			if (kind === "role") {
				m.executePermission.mockResolvedValue(false);
			}
			if (kind === "source") {
				m.source.mockRejectedValue(new Error("Example source revoked"));
			}
			if (kind === "identity") {
				m.row.mockResolvedValue({
					...metadata,
					runId: "example-other-run",
				});
			}
			const read = vi.fn(async () => "Example private text");
			await expect(
				withNativeAgentTestBoundary(
					{ ...actor, nativeTestBoundary: boundary },
					read,
				),
			).rejects.toThrow();
			expect(read).not.toHaveBeenCalled();
		},
	);
	it("never interprets an omitted document filter as all documents when a frozen subset exists", () => {
		expect(() =>
			assertFrozenAgentTestWorkspaceSelection(authority, {
				workspaceIds: source.workspaceIds,
				workspaceDocumentFilters: [],
			}),
		).toThrow();
	});
});
