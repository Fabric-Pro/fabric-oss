import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildInstanceAgentConfig } from "../../components/FabricChat/shared/agent-selection";
import { useDirectStream } from "../useDirectStream";
import { useMultiAgentStream } from "../useMultiAgentStream";

const h = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { agentTemplates: { instances: { get: h.get } } },
}));
vi.mock("@saas/payments/lib/ai-usage-limit-toast", () => ({
	isAiUsageLimitExceededPayload: () => false,
	useShowAiUsageLimitToast: () => vi.fn(),
}));
vi.mock("../../lib/cancel-telemetry", () => ({ emitCancelEvent: vi.fn() }));

const instance = {
	id: "example-agent",
	organizationId: "example-org",
	template: { instructions: "Use project context." },
	toolConnections: {
		"project-context": { enabled: true, projectId: "example-project" },
		"web-search": { enabled: false },
		GITHUB: { enabled: true },
	},
	workspaceIds: [],
};
const tools = [
	"project_rag_query",
	"fabric_list_meeting_transcripts",
	"fabric_list_project_features",
	"fabric_get_project_feature",
	"fabric_list_project_documents",
	"fabric_get_project_document",
	"fabric_list_project_sources",
	"fabric_get_project_source",
];
let bodies: Record<string, unknown>[];
beforeEach(() => {
	bodies = [];
	h.get.mockReset().mockResolvedValue({ instance });
	vi.spyOn(global, "fetch").mockImplementation(async (_input, init) => {
		bodies.push(JSON.parse(String(init?.body)));
		return {
			ok: true,
			body: { getReader: () => ({ read: async () => ({ done: true }) }) },
		} as Response;
	});
});
afterEach(() => vi.restoreAllMocks());

describe("agent Project Context propagation", () => {
	it("projects the enabled project and tools without treating built-ins as OAuth providers", () => {
		expect(buildInstanceAgentConfig(instance)).toMatchObject({
			boundProjectId: "example-project",
			enabledFabricToolIds: tools,
			enabledIntegrationProviders: ["GITHUB"],
		});
		expect(
			buildInstanceAgentConfig({
				...instance,
				toolConnections: {
					"project-context": {
						enabled: false,
						projectId: "example-project",
					},
				},
			}),
		).toMatchObject({ boundProjectId: null, enabledFabricToolIds: [] });
	});
	it("ignores malformed connection entries without losing the configured project", () => {
		expect(
			buildInstanceAgentConfig({
				...instance,
				toolConnections: {
					...instance.toolConnections,
					"example-unused": null,
				},
			}),
		).toMatchObject({
			boundProjectId: "example-project",
			enabledFabricToolIds: tools,
		});
	});

	it("waits for the live instance before a Direct request, including a restored id-only selection", async () => {
		let finish!: (value: { instance: typeof instance }) => void;
		h.get.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const { result } = renderHook(() =>
			useDirectStream({
				organizationId: "example-org",
				instanceId: "example-agent",
				enabledFabricToolIds: ["fabric_web_search"],
			}),
		);
		let sending!: Promise<string | null>;
		act(() => {
			sending = result.current.sendMessage("Describe this project");
		});
		await waitFor(() =>
			expect(h.get).toHaveBeenCalledWith({ id: "example-agent" }),
		);
		expect(bodies).toEqual([]);
		await act(async () => {
			finish({ instance });
			await sending;
		});
		expect(bodies[0]).toMatchObject({
			projectId: "example-project",
			enabledFabricToolIds: tools,
			instanceId: "example-agent",
		});
	});
	it.each(["example-attached-project", null])(
		"keeps explicit Direct project selection %s ahead of the agent default",
		async (projectId) => {
			const { result } = renderHook(() =>
				useDirectStream({
					organizationId: "example-org",
					instanceId: "example-agent",
					projectId,
				}),
			);
			await act(async () => {
				await result.current.sendMessage("Describe this project");
			});
			expect(bodies[0].projectId).toBe(projectId);
		},
	);
	it("rehydrates legacy per-agent requests from the live instance", async () => {
		const { result } = renderHook(() =>
			useMultiAgentStream({ organizationId: "example-org" }),
		);
		await act(async () => {
			result.current.sendToAgents(
				"Describe this project",
				[
					{
						agentId: "template-instance:example-agent",
						name: "Example Agent",
					},
				],
				[],
			);
		});
		await waitFor(() => expect(bodies).toHaveLength(1));
		expect(bodies[0]).toMatchObject({
			projectId: "example-project",
			enabledFabricToolIds: tools,
			instanceId: "example-agent",
		});
	});
	it("does not dispatch an instance from another tenant", async () => {
		h.get.mockResolvedValue({
			instance: { ...instance, organizationId: "example-other-org" },
		});
		const { result } = renderHook(() =>
			useDirectStream({
				organizationId: "example-org",
				instanceId: "example-agent",
			}),
		);
		await act(async () => {
			await result.current.sendMessage("Describe this project");
		});
		expect(bodies).toEqual([]);
		expect(result.current.messages.at(-1)?.streamStatus).toBe("error");
	});
	it("keeps separate agent project bindings in a multi-agent turn", async () => {
		h.get.mockImplementation(async ({ id }: { id: string }) => ({
			instance: {
				...instance,
				id,
				toolConnections: {
					"project-context": {
						enabled: true,
						projectId: `${id}-project`,
					},
				},
			},
		}));
		const { result } = renderHook(() =>
			useMultiAgentStream({ organizationId: "example-org" }),
		);
		await act(async () => {
			result.current.sendToAgents(
				"Describe your projects",
				["example-one", "example-two"].map((id) => ({
					agentId: `template-instance:${id}`,
					instanceId: id,
					name: id,
				})),
				[],
			);
		});
		await waitFor(() => expect(bodies).toHaveLength(2));
		expect(bodies.map((body) => [body.instanceId, body.projectId])).toEqual(
			[
				["example-one", "example-one-project"],
				["example-two", "example-two-project"],
			],
		);
	});
	it("does not dispatch after stopping while instance resolution is pending", async () => {
		let finish!: (value: { instance: typeof instance }) => void;
		h.get.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const { result } = renderHook(() =>
			useDirectStream({
				organizationId: "example-org",
				instanceId: "example-agent",
			}),
		);
		let sending!: Promise<string | null>;
		act(() => {
			sending = result.current.sendMessage("Describe this project");
		});
		await waitFor(() => expect(h.get).toHaveBeenCalled());
		act(() => result.current.stop());
		await act(async () => {
			finish({ instance });
			await sending;
		});
		expect(bodies).toEqual([]);
	});
	it("resolves changed bindings and disabled capabilities instead of trusting a saved snapshot", async () => {
		h.get.mockResolvedValue({
			instance: {
				...instance,
				toolConnections: {
					"project-context": {
						enabled: false,
						projectId: "example-project",
					},
				},
			},
		});
		const { result } = renderHook(() =>
			useMultiAgentStream({ organizationId: "example-org" }),
		);
		await act(async () => {
			result.current.sendToAgents(
				"Describe this project",
				[
					{
						agentId: "template-instance:example-agent",
						name: "Example Agent",
						instanceId: "example-agent",
						boundProjectId: "example-old-project",
						enabledFabricToolIds: tools,
					},
				],
				[],
			);
		});
		await waitFor(() => expect(bodies).toHaveLength(1));
		expect(bodies[0]).toMatchObject({
			projectId: null,
			enabledFabricToolIds: [],
		});
	});
	it("normalizes enabled relational, key and legacy MCP bindings without OAuth pollution", () => {
		const config = buildInstanceAgentConfig({
			...instance,
			toolConnections: {
				"mcp:example-key": { enabled: true },
				"legacy-mcp": { enabled: true, connectionId: "example-legacy" },
				"mcp:example-off": { enabled: false },
				"explicit-mcp": {
					enabled: true,
					mcpConfigId: "example-explicit",
				},
			},
			mcpServerConfigurations: [
				{ mcpConfigId: "example-relation", isEnabled: true },
				{ mcpConfigId: "example-disabled", isEnabled: false },
			],
		});
		expect(config.enabledMcpConfigIds).toEqual([
			"example-key",
			"example-legacy",
			"example-explicit",
			"example-relation",
		]);
		expect(config.enabledIntegrationProviders).toEqual([]);
	});
	it("dispatches live MCP bindings in Direct while instance UI rehydration is pending", async () => {
		h.get.mockResolvedValue({
			instance: {
				...instance,
				mcpServerConfigurations: [{ mcpConfigId: "example-relation" }],
				toolConnections: {
					"mcp:example-key": { enabled: true },
					"legacy-mcp": {
						enabled: true,
						connectionId: "example-legacy",
					},
				},
			},
		});
		const { result } = renderHook(() =>
			useDirectStream({
				organizationId: "example-org",
				instanceId: "example-agent",
				enabledMcpConfigIds: ["example-relation"],
			}),
		);
		await act(async () => {
			await result.current.sendMessage("Use my tools");
		});
		expect(bodies[0].enabledMcpConfigIds).toEqual([
			"example-key",
			"example-legacy",
			"example-relation",
		]);
	});
	it("preserves relation and legacy MCP bindings when replacing a saved legacy agent snapshot", async () => {
		h.get.mockResolvedValue({
			instance: {
				...instance,
				mcpServerConfigurations: [{ mcpConfigId: "example-relation" }],
				toolConnections: {
					"mcp:example-key": { enabled: true },
					"legacy-mcp": {
						enabled: true,
						connectionId: "example-legacy",
					},
				},
			},
		});
		const { result } = renderHook(() =>
			useMultiAgentStream({ organizationId: "example-org" }),
		);
		await act(async () => {
			result.current.sendToAgents(
				"Use my tools",
				[
					{
						agentId: "template-instance:example-agent",
						name: "Example Agent",
						enabledMcpConfigIds: ["example-relation"],
					},
				],
				[],
			);
		});
		await waitFor(() => expect(bodies).toHaveLength(1));
		expect(bodies[0].enabledMcpConfigIds).toEqual([
			"example-key",
			"example-legacy",
			"example-relation",
		]);
	});
	it.each([{}, undefined])(
		"inherits dedicated caller MCP bindings for configuration %s",
		async (toolConnections) => {
			h.get.mockResolvedValue({
				instance: { ...instance, toolConnections },
			});
			const { result } = renderHook(() =>
				useDirectStream({
					organizationId: "example-org",
					instanceId: "example-agent",
					enabledMcpConfigIds: ["example-sidebar-mcp"],
				}),
			);
			await act(async () => {
				await result.current.sendMessage("Use my tools");
			});
			expect(bodies[0].enabledMcpConfigIds).toEqual([
				"example-sidebar-mcp",
			]);
		},
	);
	it("inherits account MCP preferences for an unconfigured dedicated instance", async () => {
		h.get.mockResolvedValue({
			instance: { ...instance, toolConnections: {} },
		});
		const { result } = renderHook(() =>
			useDirectStream({
				organizationId: "example-org",
				instanceId: "example-agent",
				enabledMcpConfigIds: null,
			}),
		);
		await act(async () => {
			await result.current.sendMessage("Use my tools");
		});
		expect(bodies[0].enabledMcpConfigIds).toBeNull();
	});
	it.each([
		{ toolConnections: { "mcp:example-disabled": { enabled: false } } },
		{
			toolConnections: {},
			mcpServerConfigurations: [],
			_count: { mcpServerConfigurations: 1 },
		},
	])(
		"keeps explicitly disabled dedicated MCP bindings authoritative: %s",
		async (configuration) => {
			h.get.mockResolvedValue({
				instance: { ...instance, ...configuration },
			});
			const { result } = renderHook(() =>
				useDirectStream({
					organizationId: "example-org",
					instanceId: "example-agent",
					enabledMcpConfigIds: ["example-sidebar-mcp"],
				}),
			);
			await act(async () => {
				await result.current.sendMessage("Use my tools");
			});
			expect(bodies[0].enabledMcpConfigIds).toEqual([]);
		},
	);
	it("restricts an unconfigured selected instance instead of inheriting the dedicated caller scope", async () => {
		h.get.mockResolvedValue({
			instance: { ...instance, toolConnections: {} },
		});
		const { result } = renderHook(() =>
			useDirectStream({
				organizationId: "example-org",
				instanceId: "example-agent",
				enabledMcpConfigIds: ["example-sidebar-mcp"],
				restrictInstanceMcpScope: true,
			}),
		);
		await act(async () => {
			await result.current.sendMessage("Use my tools");
		});
		expect(bodies[0].enabledMcpConfigIds).toEqual([]);
	});
	it("leaves built-in capabilities unspecified for an empty configuration", () => {
		expect(
			buildInstanceAgentConfig({ ...instance, toolConnections: {} })
				.enabledFabricToolIds,
		).toBeUndefined();
	});
	it("inherits Direct caller tools including workspace retrieval for an unconfigured instance", async () => {
		h.get.mockResolvedValue({
			instance: {
				...instance,
				toolConnections: {},
				workspaceIds: ["example-workspace"],
			},
		});
		const callerTools = [
			"workspace_rag_query",
			"workspace_rag_summarize",
			"fabric_web_search",
		];
		const { result } = renderHook(() =>
			useDirectStream({
				organizationId: "example-org",
				instanceId: "example-agent",
				workspaceIds: ["example-workspace"],
				enabledFabricToolIds: callerTools,
			}),
		);
		await act(async () => {
			await result.current.sendMessage("Read my workspace");
		});
		expect(bodies[0]).toMatchObject({
			enabledFabricToolIds: callerTools,
			workspaceIds: ["example-workspace"],
		});
	});
	it.each([null, ["workspace_rag_query", "workspace_rag_summarize"]])(
		"inherits legacy caller Fabric scope %s for an unconfigured instance",
		async (enabledFabricToolIds) => {
			h.get.mockResolvedValue({
				instance: {
					...instance,
					toolConnections: {},
					workspaceIds: ["example-workspace"],
				},
			});
			const { result } = renderHook(() =>
				useMultiAgentStream({ organizationId: "example-org" }),
			);
			await act(async () => {
				result.current.sendToAgents(
					"Read my workspace",
					[
						{
							agentId: "template-instance:example-agent",
							name: "Example Agent",
							enabledMcpConfigIds: null,
						},
					],
					[],
					{ enabledFabricToolIds },
				);
			});
			await waitFor(() => expect(bodies).toHaveLength(1));
			expect(bodies[0].enabledFabricToolIds).toEqual(
				enabledFabricToolIds,
			);
			expect(bodies[0].workspaceIds).toEqual(["example-workspace"]);
		},
	);
	it("keeps an explicitly disabled built-in capability ahead of inherited caller tools", async () => {
		h.get.mockResolvedValue({
			instance: {
				...instance,
				toolConnections: { "project-context": { enabled: false } },
			},
		});
		const { result } = renderHook(() =>
			useDirectStream({
				organizationId: "example-org",
				instanceId: "example-agent",
				enabledFabricToolIds: ["fabric_web_search"],
			}),
		);
		await act(async () => {
			await result.current.sendMessage("Describe this project");
		});
		expect(bodies[0].enabledFabricToolIds).toEqual([]);
	});
});
