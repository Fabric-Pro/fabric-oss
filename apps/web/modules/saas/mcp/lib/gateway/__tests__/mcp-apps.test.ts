import { describe, expect, it } from "vitest";
import {
	attachFabricMcpAppMeta,
	buildFabricVisualizePayload,
	executeWithDurableEnvelope,
	FABRIC_BRAND,
	FABRIC_MARK_DATA_URI,
	FABRIC_MCP_APP_RESOURCES,
	FABRIC_TOOL_UI_RESOURCE_MAP,
	isDurableMcpToolRequest,
	isStatelessMcpRequest,
	readFabricMcpAppResource,
} from "../mcp-apps";

describe("MCP Apps, Stateless MCP & Durable Tool Execution", () => {
	it("exposes built-in ui://fabric/* MCP App resources with text/html;profile=mcp-app mimeType and Fabric + OpenAI widget CSP metadata", () => {
		expect(FABRIC_MCP_APP_RESOURCES.length).toBeGreaterThanOrEqual(5);
		for (const resource of FABRIC_MCP_APP_RESOURCES) {
			expect(resource.uri.startsWith("ui://fabric/")).toBe(true);
			expect(resource.mimeType).toBe("text/html;profile=mcp-app");
			expect(resource._meta?.ui?.csp).toBeDefined();
			expect(resource._meta?.["openai/widgetCSP"]).toBeDefined();
			expect(resource._meta?.["openai/widgetDomain"]).toBe(
				"https://fabric.pro",
			);
		}
		expect(FABRIC_TOOL_UI_RESOURCE_MAP.fabric_get_project).toBe(
			"ui://fabric/project-dashboard",
		);
		expect(FABRIC_TOOL_UI_RESOURCE_MAP.fabric_list_features).toBe(
			"ui://fabric/agent-delegation",
		);
		expect(FABRIC_TOOL_UI_RESOURCE_MAP.fabric_execute_workflow).toBe(
			"ui://fabric/workflow-visualizer",
		);
		expect(FABRIC_TOOL_UI_RESOURCE_MAP.fabric_query_workspace).toBe(
			"ui://fabric/genie-insights",
		);
		expect(FABRIC_TOOL_UI_RESOURCE_MAP.fabric_visualize).toBe(
			"ui://fabric/visualize",
		);
	});

	it("renders self-contained Fabric UI Kit MCP App HTML with SHA-256 CSP script hash, Fabric brand tokens, and JSON-RPC postMessage bridge", () => {
		for (const resource of FABRIC_MCP_APP_RESOURCES) {
			const res = readFabricMcpAppResource(resource.uri);
			expect(res).not.toBeNull();
			expect(res?.contents).toHaveLength(1);
			const html = res?.contents[0]?.text ?? "";
			expect(res?.contents[0]?.mimeType).toBe(
				"text/html;profile=mcp-app",
			);
			expect(html).toContain('meta http-equiv="Content-Security-Policy"');
			expect(html).toContain("script-src 'sha256-");
			expect(html).toContain('meta name="ui-kit"');
			expect(html).toContain(FABRIC_BRAND.accent.light);
			expect(html).toContain(FABRIC_BRAND.accent.dark);
			expect(html).toContain(FABRIC_MARK_DATA_URI);
			expect(html).toContain("ui/initialize");
			expect(html).toContain("tools/call");
			expect(html).toContain("fabricagents://action/new-chat");
		}

		expect(readFabricMcpAppResource("ui://unknown/app")).toBeNull();
	});

	it("validates A2UI v0.9.1 documents for ui://fabric/visualize using the Fabric A2UI catalog", () => {
		const payload = buildFabricVisualizePayload({
			title: "Databricks vs Snowflake Lakehouse Comparison",
			document: [
				{
					version: "v0.9",
					createSurface: {
						surfaceId: "main",
						catalogId:
							"https://agents.fabric.pro/a2ui/v0.9/fabric_catalog.json",
					},
				},
				{
					version: "v0.9",
					updateComponents: {
						surfaceId: "main",
						components: [
							{
								id: "root",
								component: "Column",
								children: ["h1", "stat1"],
							},
							{
								id: "h1",
								component: "Text",
								variant: "h2",
								text: "Lakehouse Throughput",
							},
							{
								id: "stat1",
								component: "Stat",
								label: "Latency Reduction",
								value: "3.4x",
							},
						],
					},
				},
			],
			sources: ["https://fabric.pro/docs"],
		});

		expect(payload.title).toBe(
			"Databricks vs Snowflake Lakehouse Comparison",
		);
		expect(payload.surfaces).toHaveLength(1);
		expect(payload.surfaces[0]?.surfaceId).toBe("main");
		expect(payload.textSummary).toContain("Lakehouse Throughput");
		expect(payload.textSummary).toContain("3.4x");
	});

	it("detects stateless MCP requests from X-Mcp-Stateless header or stateless query parameter", () => {
		const reqHeader = new Request(
			"https://app.example.com/api/mcp-gateway",
			{
				method: "POST",
				headers: { "X-Mcp-Stateless": "true" },
			},
		);
		expect(isStatelessMcpRequest(reqHeader)).toBe(true);

		const reqQuery = new Request(
			"https://app.example.com/api/mcp-gateway?stateless=1",
			{ method: "POST" },
		);
		expect(isStatelessMcpRequest(reqQuery)).toBe(true);

		const reqNormal = new Request(
			"https://app.example.com/api/mcp-gateway",
			{
				method: "POST",
			},
		);
		expect(isStatelessMcpRequest(reqNormal)).toBe(false);
	});

	it("detects durable tool requests and wraps tool results in a deterministic Temporal durable execution envelope", async () => {
		const reqDurable = new Request(
			"https://app.example.com/api/mcp-gateway",
			{
				method: "POST",
				headers: { "X-Mcp-Durable": "true" },
			},
		);
		expect(isDurableMcpToolRequest(reqDurable)).toBe(true);
		expect(
			isDurableMcpToolRequest(null, { _meta: { durable: true } }),
		).toBe(true);
		expect(isDurableMcpToolRequest(null, {}, { _durable: true })).toBe(
			true,
		);

		const result = await executeWithDurableEnvelope({
			toolName: "fabric_get_project",
			toolArgs: { projectId: "proj_123" },
			organizationId: "org_example_1",
			userId: "user_1",
			idempotencyKey: "idem_abc123",
			execute: async () => ({
				content: [{ type: "text", text: '{"id":"proj_123"}' }],
			}),
		});

		expect(result.isError).toBeUndefined();
		expect(result._meta?.durableExecution).toMatchObject({
			durable: true,
			engine: "temporal",
			workflowId:
				"mcp-durable-org_example_1-fabric_get_project-idem_abc123",
			taskQueue: "fabric-mcp-durable-tools",
			idempotencyKey: "idem_abc123",
			organizationId: "org_example_1",
			status: "COMPLETED",
		});
		expect(result._meta?.ui).toEqual({
			resourceUri: "ui://fabric/project-dashboard",
		});
		expect(result._meta?.["ui/resourceUri"]).toBe(
			"ui://fabric/project-dashboard",
		);
	});

	it("maps projects, artifacts/frames/workspaces, and assigned tickets/features to rich MCP App views and attaches UI metadata on non-durable calls", () => {
		// Projects & Artifacts
		expect(FABRIC_TOOL_UI_RESOURCE_MAP.fabric_list_projects).toBe(
			"ui://fabric/project-dashboard",
		);
		expect(FABRIC_TOOL_UI_RESOURCE_MAP.fabric_list_frames).toBe(
			"ui://fabric/project-dashboard",
		);
		expect(FABRIC_TOOL_UI_RESOURCE_MAP.fabric_get_frame).toBe(
			"ui://fabric/project-dashboard",
		);
		expect(FABRIC_TOOL_UI_RESOURCE_MAP.fabric_list_workspaces).toBe(
			"ui://fabric/project-dashboard",
		);
		expect(FABRIC_TOOL_UI_RESOURCE_MAP.fabric_get_workspace).toBe(
			"ui://fabric/project-dashboard",
		);
		expect(FABRIC_TOOL_UI_RESOURCE_MAP.fabric_list_artifacts).toBe(
			"ui://fabric/project-dashboard",
		);
		expect(FABRIC_TOOL_UI_RESOURCE_MAP.fabric_get_artifact).toBe(
			"ui://fabric/project-dashboard",
		);

		// Tickets / Features / Assigned Backlog
		expect(FABRIC_TOOL_UI_RESOURCE_MAP.fabric_list_features).toBe(
			"ui://fabric/agent-delegation",
		);
		expect(FABRIC_TOOL_UI_RESOURCE_MAP.fabric_get_feature).toBe(
			"ui://fabric/agent-delegation",
		);
		expect(
			FABRIC_TOOL_UI_RESOURCE_MAP.fabric_list_project_pm_assigned_items,
		).toBe("ui://fabric/agent-delegation");
		expect(FABRIC_TOOL_UI_RESOURCE_MAP.fabric_list_tickets).toBe(
			"ui://fabric/agent-delegation",
		);

		// Standard (non-durable) tool calls receive _meta.ui.resourceUri
		const attached = attachFabricMcpAppMeta("fabric_list_frames", {
			content: [{ type: "text", text: '{"frames":[]}' }],
		});
		expect(attached._meta?.ui).toEqual({
			resourceUri: "ui://fabric/project-dashboard",
		});
		expect(attached._meta?.["ui/resourceUri"]).toBe(
			"ui://fabric/project-dashboard",
		);

		// Verify project-dashboard view renders both Projects and Artifacts & Workspaces cards
		const projectDashboardHtml =
			readFabricMcpAppResource("ui://fabric/project-dashboard")
				?.contents[0]?.text ?? "";
		expect(projectDashboardHtml).toContain("FABRIC ARTIFACTS & WORKSPACES");
		expect(projectDashboardHtml).toContain("Open Artifact in Portal");
		expect(projectDashboardHtml).toContain("My Assigned Tickets");

		// Verify agent-delegation view renders Tickets & Backlog card with Desktop/Remote delegation actions
		const delegationHtml =
			readFabricMcpAppResource("ui://fabric/agent-delegation")
				?.contents[0]?.text ?? "";
		expect(delegationHtml).toContain("FABRIC TICKETS & BACKLOG");
		expect(delegationHtml).toContain("Tickets Assigned to You");
		expect(delegationHtml).toContain("Start Ticket in Fabric Desktop");
		expect(delegationHtml).toContain("Delegate Ticket to Remote Server");
	});
});
