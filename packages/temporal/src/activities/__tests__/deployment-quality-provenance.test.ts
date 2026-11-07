import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	lookup: vi.fn(),
	scope: vi.fn(),
	admission: vi.fn(),
	deployment: vi.fn(),
	info: vi.fn(),
	execute: vi.fn(),
	memory: vi.fn(),
	build: vi.fn(),
}));
vi.mock("@temporalio/activity", () => ({
	Context: { current: () => ({ info: m.info() }) },
}));
vi.mock("@repo/database", () => ({
	db: { runQualityAssessment: { findFirst: m.lookup } },
	readAgentExecutionAdmission: m.admission,
	getAgentDeploymentById: m.deployment,
	canExecuteOrganizationAgents: m.execute,
	filterWorkspaceIdsForTenant: async () => ({ allowed: [], dropped: [] }),
	getProjectAccessContext: vi.fn(),
	isProjectSoftDeleted: vi.fn(),
	appendTemplateMessage: vi.fn(),
	getTemplateConversationMessages: vi.fn(),
	loadAgentMemoryContext: m.memory,
	updateExecutionStatus: vi.fn(),
}));
vi.mock("../../lib/agent-test-access", () => ({ loadAgentTestScope: m.scope }));
vi.mock("../shared/native-agent-test-authority", () => ({
	withNativeAgentTestBoundary: async (
		_params: unknown,
		fn: (snapshot?: unknown) => unknown,
	) => fn(),
	assertFrozenAgentTestWorkspaceSelection: vi.fn(),
}));
vi.mock("../agent-execution-core", () => ({
	buildAgentExecutionContext: m.build,
	buildKnowledgeContextPrompt: vi.fn(),
	buildUserInputContext: vi.fn(),
	executeAgentTurn: vi.fn(),
	extractBuiltInToolNames: vi.fn(),
	extractMcpConfigIds: vi.fn(),
	fetchKnowledgeSources: vi.fn(),
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
	nativeAgentConfigurationFingerprint,
	nativeConfigurationFromSavedSnapshot,
} from "../../lib/native-agent-configuration";
import {
	buildExecutionContext,
	loadDeploymentConfiguration,
} from "../deployment-execution";

const params = {
	deploymentId: "example-deployment",
	userId: "example-user",
	organizationId: "example-org",
};
const template = {
	id: "example-template",
	name: "Example",
	slug: "example",
	displayName: "Example",
	description: "Example",
	instructions: "Configuration B",
	suggestedModel: null,
};
const instance = {
	id: "example-instance",
	...params,
	name: "Example",
	organizationId: params.organizationId,
	description: null,
	customInstructions: null,
	modelOverride: null,
	modelConfig: null,
	executionMode: "single_turn",
	goal: null,
	maxIterations: 10,
	successCriteria: null,
	workspaceIds: [],
	toolConnections: {},
	integrationConfigurations: [],
	mcpServerConfigurations: [],
	template,
};
const snapshot = {
	instance,
	scope: {
		instanceId: instance.id,
		configHash: "b".repeat(64),
		workspaceIds: [],
		workspaceDocumentFilters: [],
		skillIds: [],
	},
	configuration: {
		instance,
		template,
		bindings: [],
		integrations: [],
		memoryFiles: [],
	},
};
beforeEach(() => {
	vi.resetAllMocks();
	m.execute.mockResolvedValue(true);
	m.info.mockReturnValue({
		workflowType: "nativeDeploymentExecutionWorkflow",
		workflowExecution: {
			workflowId: "example-workflow",
			runId: "example-run",
		},
	});
	m.lookup.mockResolvedValue({
		id: "example-assessment",
		policy: { instanceId: instance.id },
		agentExecution: { metadata: {} },
		sourceScopeJson: {
			kind: "AGENT",
			scope: { instanceId: instance.id, configHash: "a".repeat(64) },
		},
	});
	m.admission.mockReturnValue({
		dispatch: {
			instanceId: instance.id,
			workflowType: "nativeDeploymentExecutionWorkflow",
		},
	});
	m.scope.mockResolvedValue(snapshot);
	m.memory.mockResolvedValue({
		agentsMd: "Live memory",
		mcpJson: null,
		skills: [],
		knowledge: [],
		recentConversations: [],
	});
	m.build.mockReturnValue({
		systemPrompt: "Example",
		tools: [],
		integrationConfigurations: [],
		workspaceIds: [],
		workspaceDocumentFilters: [],
		knowledgeSources: [],
		mcpConfigIds: [],
		builtInToolNames: [],
	});
	m.deployment.mockResolvedValue({
		...params,
		id: params.deploymentId,
		instance,
	});
});
it("stamps the exact ordinary configuration without reloading or freezing memory", async () => {
	const config = await loadDeploymentConfiguration(params);
	expect(config?.template.instructions).toBe("Configuration B");
	expect(config?.qualityConfiguration).toEqual({
		version: 1,
		assessmentId: "example-assessment",
		configHash: nativeAgentConfigurationFingerprint(config!, instance),
	});
	expect(m.scope).not.toHaveBeenCalled();
	expect(m.deployment).toHaveBeenCalledTimes(1);
	expect(config).not.toHaveProperty("nativeTestBoundary");
	expect(config).not.toHaveProperty("frozenMemoryFiles");
	expect(m.lookup.mock.calls[0][0].where).toMatchObject({
		userId: params.userId,
		organizationId: params.organizationId,
		nativeWorkflowId: "example-workflow",
		nativeRunId: "example-run",
		agentExecution: {
			deploymentId: params.deploymentId,
			workflowId: "example-workflow",
			runId: "example-run",
		},
	});
});
it("preserves non-opted-in native business loading without a marker", async () => {
	m.lookup.mockResolvedValue(null);
	const config = await loadDeploymentConfiguration(params);
	expect(config?.instance.id).toBe(instance.id);
	expect(config).not.toHaveProperty("qualityConfiguration");
	expect(m.scope).not.toHaveBeenCalled();
});
it.each(["lookup", "identity"])(
	"cannot fail native business because optional quality %s is unavailable",
	async (kind) => {
		if (kind === "lookup") {
			m.lookup.mockRejectedValue(
				new Error("Optional lookup unavailable"),
			);
		}
		if (kind === "identity") {
			m.admission.mockReturnValue({
				dispatch: { instanceId: "example-other-instance" },
			});
		}
		const config = await loadDeploymentConfiguration(params);
		expect(config?.instance.id).toBe(instance.id);
		expect(config).not.toHaveProperty("qualityConfiguration");
		expect(m.deployment).toHaveBeenCalledTimes(1);
	},
);
it("does not opt legacy activity histories into a new quality lookup", async () => {
	m.info.mockReturnValue({ workflowType: "deploymentExecutionWorkflow" });
	const config = await loadDeploymentConfiguration(params);
	expect(config).not.toHaveProperty("qualityConfiguration");
	expect(m.lookup).not.toHaveBeenCalled();
});

it("retains native execution permission checks when optional quality exists", async () => {
	m.execute.mockResolvedValue(false);
	expect(await loadDeploymentConfiguration(params)).toBeNull();
});

it("keeps identical business configuration and enabled connection membership regardless of checks or terminal status", async () => {
	const boundInstance = {
		...instance,
		integrationConfigurations: [
			{
				integrationId: "example-enabled",
				integrationType: "github",
				allowedResources: ["one"],
			},
			{
				integrationId: "example-disabled-returned",
				integrationType: "custom",
				allowedResources: ["two"],
				isEnabled: false,
			},
		],
		mcpServerConfigurations: [
			{ mcpConfigId: "example-enabled" },
			{ mcpConfigId: "example-disabled-returned", isEnabled: false },
		],
	};
	m.deployment.mockResolvedValue({
		...params,
		id: params.deploymentId,
		instance: boundInstance,
	});
	const enabled = await loadDeploymentConfiguration(params);
	const row = await m.lookup.mock.results[0].value;
	m.lookup.mockResolvedValue({ ...row, status: "COMPLETED" });
	const terminal = await loadDeploymentConfiguration(params);
	m.lookup.mockResolvedValue(null);
	const ordinary = await loadDeploymentConfiguration(params);
	const { qualityConfiguration: _a, ...enabledBusiness } = enabled!;
	const { qualityConfiguration: _b, ...terminalBusiness } = terminal!;
	expect(enabledBusiness).toEqual(ordinary);
	expect(terminalBusiness).toEqual(ordinary);
	expect(enabled?.mcpConfigIds).toEqual([
		"example-enabled",
		"example-disabled-returned",
	]);
	expect(enabled?.integrationConfigurations).toHaveLength(2);
	expect(terminal?.qualityConfiguration).toEqual(
		enabled?.qualityConfiguration,
	);
});
it("matches the real deployment getter's enabled-only source projection without freezing adaptive memory", async () => {
	const bindings = [
		{ isEnabled: true, mcpConfigId: "example-enabled" },
		{ isEnabled: false, mcpConfigId: "example-disabled" },
	];
	const integrations = [
		{
			isEnabled: true,
			integrationId: "example-enabled",
			integrationType: "github",
			allowedResources: ["one"],
		},
		{
			isEnabled: false,
			integrationId: "example-disabled",
			integrationType: "github",
			allowedResources: ["two"],
		},
	];
	m.deployment.mockResolvedValue({
		...params,
		id: params.deploymentId,
		instance: {
			...instance,
			mcpServerConfigurations: [{ mcpConfigId: "example-enabled" }],
			integrationConfigurations: [integrations[0]],
		},
	});
	const config = await loadDeploymentConfiguration(params);
	const selected = {
		...snapshot,
		configuration: {
			...snapshot.configuration,
			bindings,
			integrations,
			memoryFiles: [
				{
					id: "example-memory",
					version: 1,
					contentHash: "c".repeat(64),
				},
			],
		},
	};
	expect(
		nativeAgentConfigurationFingerprint(
			nativeConfigurationFromSavedSnapshot(selected),
			selected.configuration.instance,
		),
	).toBe(config?.qualityConfiguration?.configHash);
	const changedMemory = {
		...selected,
		configuration: {
			...selected.configuration,
			memoryFiles: [
				{
					id: "example-memory",
					version: 2,
					contentHash: "d".repeat(64),
				},
			],
		},
	};
	expect(
		nativeAgentConfigurationFingerprint(
			nativeConfigurationFromSavedSnapshot(changedMemory),
			changedMemory.configuration.instance,
		),
	).toBe(config?.qualityConfiguration?.configHash);
	await buildExecutionContext({
		config: config!,
		input: {},
		userId: params.userId,
		organizationId: params.organizationId,
	});
	expect(m.memory.mock.calls[0][1]).toBeUndefined();
	expect(config).not.toHaveProperty("frozenMemoryFiles");
});
it("retains the loaded fingerprint when the current configuration later changes back", async () => {
	const config = await loadDeploymentConfiguration(params);
	const loadedHash = config?.qualityConfiguration?.configHash;
	m.deployment.mockResolvedValue({
		...params,
		id: params.deploymentId,
		instance: {
			...instance,
			template: { ...template, instructions: "Configuration A" },
		},
	});
	expect(loadedHash).toBe(
		nativeAgentConfigurationFingerprint(config!, instance),
	);
	expect(loadedHash).not.toBe(
		(await loadDeploymentConfiguration(params))?.qualityConfiguration
			?.configHash,
	);
});

it("fingerprints goal settings, model, instructions and trusted source/tool/project selection", async () => {
	const config = (await loadDeploymentConfiguration(params))!;
	const baseline = nativeAgentConfigurationFingerprint(config, instance);
	const candidates = [
		nativeAgentConfigurationFingerprint(
			{
				...config,
				template: {
					...config.template,
					instructions: "Different instructions",
				},
			},
			instance,
		),
		nativeAgentConfigurationFingerprint(
			{
				...config,
				instance: {
					...config.instance,
					modelOverride: "example-other-model",
				},
			},
			instance,
		),
		nativeAgentConfigurationFingerprint(
			{ ...config, workspaceIds: ["example-workspace"] },
			instance,
		),
		nativeAgentConfigurationFingerprint(
			{
				...config,
				workspaceDocumentFilters: [
					{
						workspaceId: "example-workspace",
						documentIds: ["example-document"],
					},
				],
			},
			instance,
		),
		nativeAgentConfigurationFingerprint(
			{ ...config, mcpConfigIds: ["example-tool"] },
			instance,
		),
		nativeAgentConfigurationFingerprint(
			{
				...config,
				toolConnections: {
					"project-context": { projectId: "example-other-project" },
				},
			},
			instance,
		),
		nativeAgentConfigurationFingerprint(config, {
			...instance,
			executionMode: "goal_oriented",
		}),
		nativeAgentConfigurationFingerprint(config, {
			...instance,
			goal: "Different saved goal",
		}),
		nativeAgentConfigurationFingerprint(config, {
			...instance,
			maxIterations: 20,
		}),
		nativeAgentConfigurationFingerprint(config, {
			...instance,
			successCriteria: {
				type: "explicit",
				description: "Expected evidence",
			},
		}),
	];
	for (const candidate of candidates) expect(candidate).not.toBe(baseline);
});
it("preserves ordinary business loading when fingerprint proof exceeds its limits", async () => {
	let deep: unknown = "value";
	for (let i = 0; i < 40; i++) deep = { nested: deep };
	m.deployment.mockResolvedValue({
		...params,
		id: params.deploymentId,
		instance: { ...instance, successCriteria: deep },
	});
	const config = await loadDeploymentConfiguration(params);
	expect(config?.instance.id).toBe(instance.id);
	expect(config).not.toHaveProperty("qualityConfiguration");
	expect(config).not.toHaveProperty("frozenMemoryFiles");
});
