/**
 * `resolveMultiAgentPicks`: the agents of a multi-agent message, resolved on
 * the server from the ids the browser sent.
 *
 *   - a template instance needs AGENT_TEMPLATE_READ and must belong to the
 *     active organization; it runs with its instructions, MCP servers,
 *     knowledge bases and project, and its OAuth integrations as the
 *     caller's active connections of those providers;
 *   - a registered agent needs AGENT_READ, must be active, and must pass the
 *     registered-agent access check;
 *   - a model must be one the caller's providers serve here; a ChatGPT plan
 *     model must be on the plan that serves the caller;
 *   - the first pick the caller cannot use refuses the whole message.
 */
import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	authorize: vi.fn(),
	access: vi.fn(),
	models: vi.fn(),
	instance: vi.fn(),
	registered: vi.fn(),
	integrations: vi.fn(),
}));

vi.mock("@repo/api/orpc/procedures", () => ({
	authorizeInputOrganization: m.authorize,
	Permissions: {
		AGENT_READ: "agent:read",
		AGENT_TEMPLATE_READ: "agent-template:read",
	},
}));
vi.mock("@repo/api/modules/agents/lib/registered-agent-access", () => ({
	checkRegisteredAgentAccess: m.access,
}));
vi.mock("@repo/api/modules/ai-config/lib/available-models", () => ({
	listAvailableModels: m.models,
}));
vi.mock("@repo/database", () => ({
	db: { agentTemplateInstance: { findUnique: m.instance } },
	getRegisteredAgentByAgentId: m.registered,
	listWorkflowIntegrations: m.integrations,
}));

const { resolveMultiAgentPicks } = await import(
	"@saas/agents/runtime/multi-agent-agents"
);

const caller = { userId: "user-1", organizationId: "org-1" };

const instance = {
	id: "instance-1",
	organizationId: "org-1",
	name: "Researcher",
	description: "Finds sources.",
	template: { instructions: "Research carefully." },
	customInstructions: null,
	toolConnections: {
		GITHUB: { enabled: true },
		"mcp:mcp-agent": { enabled: true },
		"project-context": { enabled: true, projectId: "project-agent" },
	},
	workspaceIds: ["workspace-agent"],
	mcpServerConfigurations: [],
	_count: { mcpServerConfigurations: 0 },
};

/** Grant the caller these permissions; refuse the others as the procedure does. */
function grant(...permissions: string[]) {
	m.authorize.mockImplementation(async (permission: string) => {
		if (!permissions.includes(permission)) {
			throw new ORPCError("FORBIDDEN");
		}
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	grant("agent:read", "agent-template:read");
	m.models.mockResolvedValue({
		models: [
			{
				canonicalName: "alpha",
				displayName: "Alpha",
				vendor: "Example",
				description: "A model.",
			},
		],
		chatgptPlan: {
			models: [{ canonicalName: "gamma", displayName: "Gamma" }],
		},
	});
	m.instance.mockResolvedValue(instance);
	m.registered.mockResolvedValue({
		displayName: "Reviewer",
		description: "Reviews.",
		status: "ACTIVE",
	});
	m.access.mockResolvedValue({ allowed: true });
	m.integrations.mockResolvedValue([
		{ id: "integration-github", provider: "GITHUB", isActive: true },
		{ id: "integration-old", provider: "GITHUB", isActive: false },
		{ id: "integration-slack", provider: "SLACK", isActive: true },
	]);
});

describe("resolveMultiAgentPicks", () => {
	it("resolves an instance, a registered agent, a model and a plan model in order", async () => {
		const result = await resolveMultiAgentPicks(caller, [
			"template-instance:instance-1",
			"reviewer-agent",
			"model:alpha",
			"plan-model:gamma",
		]);

		expect(result).toEqual({
			kind: "resolved",
			agents: [
				{
					agentId: "template-instance:instance-1",
					name: "Researcher",
					profile: expect.objectContaining({
						instructions: "Research carefully.",
						enabledMcpConfigIds: ["mcp-agent"],
						workspaceIds: ["workspace-agent"],
						instanceId: "instance-1",
						boundProjectId: "project-agent",
						enabledIntegrationIds: ["integration-github"],
					}),
				},
				{
					agentId: "reviewer-agent",
					name: "Reviewer",
					profile: {
						agentId: "reviewer-agent",
						name: "Reviewer",
						description: "Reviews.",
					},
				},
				{
					agentId: "model:alpha",
					name: "Alpha",
					vendor: "Example",
					profile: expect.objectContaining({
						modelOverride: "alpha",
					}),
				},
				{
					agentId: "plan-model:gamma",
					name: "Gamma",
					vendor: "OpenAI",
					profile: expect.objectContaining({
						modelOverride: "chatgpt-plan:gamma",
					}),
				},
			],
		});
		expect(m.instance).toHaveBeenCalledWith(
			expect.objectContaining({ where: { id: "instance-1" } }),
		);
	});

	it("refuses an instance without AGENT_TEMPLATE_READ, and never reads it", async () => {
		grant("agent:read");

		await expect(
			resolveMultiAgentPicks(caller, [
				"model:alpha",
				"template-instance:instance-1",
			]),
		).resolves.toEqual({
			kind: "refused",
			agentId: "template-instance:instance-1",
			message: expect.any(String),
		});
		expect(m.instance).not.toHaveBeenCalled();
	});

	it("refuses a registered agent without AGENT_READ", async () => {
		grant("agent-template:read");

		await expect(
			resolveMultiAgentPicks(caller, ["reviewer-agent"]),
		).resolves.toMatchObject({
			kind: "refused",
			agentId: "reviewer-agent",
		});
		expect(m.registered).not.toHaveBeenCalled();
	});

	it("refuses an instance of another organization", async () => {
		m.instance.mockResolvedValue({ ...instance, organizationId: "org-2" });

		await expect(
			resolveMultiAgentPicks(caller, ["template-instance:instance-1"]),
		).resolves.toMatchObject({
			kind: "refused",
			agentId: "template-instance:instance-1",
		});
	});

	it("refuses a registered agent that is inactive, or that the caller cannot access", async () => {
		m.registered.mockResolvedValueOnce({
			displayName: "Reviewer",
			status: "INACTIVE",
		});
		await expect(
			resolveMultiAgentPicks(caller, ["reviewer-agent"]),
		).resolves.toMatchObject({ kind: "refused" });

		m.access.mockResolvedValueOnce({ allowed: false });
		await expect(
			resolveMultiAgentPicks(caller, ["reviewer-agent"]),
		).resolves.toMatchObject({ kind: "refused" });
		expect(m.access).toHaveBeenCalledWith(
			expect.objectContaining({ status: "ACTIVE" }),
			"user-1",
			"org-1",
		);
	});

	it("refuses a model the caller's providers do not serve, and a plan model not on the plan", async () => {
		await expect(
			resolveMultiAgentPicks(caller, ["model:unknown"]),
		).resolves.toMatchObject({ kind: "refused", agentId: "model:unknown" });
		await expect(
			resolveMultiAgentPicks(caller, ["plan-model:alpha"]),
		).resolves.toMatchObject({
			kind: "refused",
			agentId: "plan-model:alpha",
		});
	});

	it("checks each permission once per message and lists integrations only when an agent names providers", async () => {
		await resolveMultiAgentPicks(caller, ["model:alpha", "reviewer-agent"]);
		expect(m.integrations).not.toHaveBeenCalled();

		m.authorize.mockClear();
		await resolveMultiAgentPicks(caller, [
			"template-instance:instance-1",
			"template-instance:instance-1",
		]);
		expect(m.authorize).toHaveBeenCalledTimes(1);
		expect(m.integrations).toHaveBeenCalledTimes(1);
	});

	it("lets an error other than a refused permission through", async () => {
		m.authorize.mockRejectedValue(new Error("database unavailable"));

		await expect(
			resolveMultiAgentPicks(caller, ["reviewer-agent"]),
		).rejects.toThrow("database unavailable");
	});
});
