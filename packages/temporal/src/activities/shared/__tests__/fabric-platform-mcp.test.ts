/**
 * The in-app agent's view of Fabric MCP.
 *
 * The gateway is the only registry of the workflow and frame tools; this
 * module turns its tool list into AI SDK tools for a chat turn. What is pinned
 * here is what could go wrong between the two: a tool outside the allowlist
 * reaching the model, a write that needs the person's yes reaching the gateway
 * without it, the draft a person confirms not being the gateway's own dry run,
 * and a gateway that is down taxing every turn.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	createMcpClient: vi.fn(),
	listTools: vi.fn(),
	callTool: vi.fn(),
	closeClient: vi.fn(),
	guardToolWriteForReadOnly: vi.fn(),
}));

vi.mock("@repo/mcp", () => ({
	createMcpClient: mocks.createMcpClient,
}));
vi.mock("@repo/agent-core/backend", () => ({
	closeMcpClientSafe: mocks.closeClient,
}));
vi.mock("@repo/utils", () => ({
	getBaseUrl: () => "https://app.example.com",
}));
vi.mock("../read-only-gate", () => ({
	guardToolWriteForReadOnly: mocks.guardToolWriteForReadOnly,
}));

import {
	FABRIC_CHAT_TOOL_DEFINITIONS,
	FABRIC_GATEWAY_TOOL_DEFINITIONS,
} from "../../../lib/fabric-gateway-tools";
import { confirmationMeta } from "../../../lib/fabric-tool-definition";
import { withApprovedAgentTool } from "../agent-tool-runtime";
import {
	loadFabricPlatformTools,
	resetFabricPlatformMcpCache,
	unwrapGatewayResult,
} from "../fabric-platform-mcp";

/** A grant as the worker holds it: opaque, signed by someone else, with an expiry inside. */
function grantExpiringIn(seconds: number): string {
	const body = JSON.stringify({
		p: { purpose: "fabric-agent-acting-grant" },
		exp: Math.floor(Date.now() / 1000) + seconds,
	});
	return `${Buffer.from(body).toString("base64url")}.signature`;
}

const ACTOR = {
	userId: "user-1",
	organizationId: "org-1",
	actingGrant: grantExpiringIn(3_600),
	projectId: "project-1",
	conversationId: "conversation-1",
	sourceRunType: "direct-chat",
	sourceRunId: "run-1",
};

/** A tool as the gateway lists it: Fabric's own definition, with the `_meta` it serves. */
const GATEWAY_TOOLS = [
	...FABRIC_GATEWAY_TOOL_DEFINITIONS.map((tool) => ({
		name: tool.name,
		description: tool.description,
		inputSchema: tool.inputSchema,
		annotations: tool.annotations,
		_meta: confirmationMeta(tool),
	})),
	{
		name: "linear__list_issues",
		description: "Lists issues.",
		inputSchema: { type: "object", properties: {} },
		annotations: { readOnlyHint: true },
	},
];

function ok(data: unknown) {
	return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

type ExecutableTool = {
	description: string;
	inputSchema: { jsonSchema: Record<string, unknown> };
	execute: (
		args: Record<string, unknown>,
		options?: unknown,
	) => Promise<unknown>;
};

async function load() {
	const platform = await loadFabricPlatformTools(ACTOR);
	if (!platform) {
		throw new Error("expected Fabric tools to load");
	}
	return {
		platform,
		tool: (name: string) => platform.tools[name] as ExecutableTool,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	resetFabricPlatformMcpCache();
	process.env.AGENT_SERVICE_SECRET = "service-secret-for-tests";
	mocks.createMcpClient.mockResolvedValue({
		listTools: mocks.listTools,
		callTool: mocks.callTool,
	});
	mocks.listTools.mockResolvedValue({ tools: GATEWAY_TOOLS });
	mocks.callTool.mockResolvedValue(ok({ ok: true }));
	mocks.guardToolWriteForReadOnly.mockResolvedValue(null);
});

describe("which tools the model gets", () => {
	it("keeps the workflow, frame and page families on every turn and drops every other tool the gateway lists", async () => {
		const { platform } = await load();

		expect(Object.keys(platform.tools).sort()).toEqual(
			FABRIC_CHAT_TOOL_DEFINITIONS.map((tool) => tool.name).sort(),
		);
		expect(platform.tools.fabric_list_projects).toBeDefined();
		expect(platform.tools.linear__list_issues).toBeUndefined();
		expect(platform.tools.fabric_create_frame).toBeDefined();
		expect(platform.tools.fabric_page_data_set).toBeDefined();
	});

	it.each([
		"fabric_list_projects",
		"fabric_get_project",
		"fabric_list_project_instructions",
		"fabric_get_project_instruction",
		"fabric_get_project_instruction_bundle",
		"fabric_list_connected_servers",
		"fabric_list_page_tools",
		"fabric_get_project_pm_connection",
		"fabric_list_project_pm_members",
		"fabric_get_project_work_item_counts",
		"fabric_list_project_pm_assigned_items",
		"fabric_get_project_pm_item_snapshots",
	])("offers and executes %s using the canonical schema", async (name) => {
		const { platform, tool } = await load();
		const definition = FABRIC_CHAT_TOOL_DEFINITIONS.find(
			(entry) => entry.name === name,
		);
		expect(tool(name).inputSchema.jsonSchema).toMatchObject(
			definition?.inputSchema ?? {},
		);
		expect(platform.access[name]).toBe("READ");
		await tool(name).execute({ projectId: "project-1" });
		expect(mocks.callTool).toHaveBeenCalledWith(
			expect.objectContaining({
				name,
				arguments: { projectId: "project-1" },
			}),
		);
	});

	it("does not offer the model a tool only a page's script has a use for, though the gateway lists it", async () => {
		const { platform } = await load();

		expect(Object.keys(platform.tools)).not.toContain("fabric_page_ask");
		expect(Object.keys(platform.tools)).not.toContain(
			"fabric_page_read_connected",
		);
		expect(GATEWAY_TOOLS.map((tool) => tool.name)).toEqual(
			expect.arrayContaining(["fabric_page_ask"]),
		);
	});

	it("never shows the model dryRun: it is the wrapper's to send", async () => {
		const { tool } = await load();

		for (const name of [
			"fabric_create_workflow",
			"fabric_update_workflow",
		]) {
			const schema = tool(name).inputSchema.jsonSchema;
			expect(schema.properties).not.toHaveProperty("dryRun");
			expect(schema.additionalProperties).toBe(false);
		}
		expect(
			tool("fabric_update_workflow").inputSchema.jsonSchema.properties,
		).toHaveProperty("workflowId");
	});
});

describe("how it reaches the gateway", () => {
	it("opens one client on the gateway's URL, as the service credential acting for the user", async () => {
		const { tool } = await load();
		await tool("fabric_list_workflows").execute({});

		expect(mocks.createMcpClient).toHaveBeenCalledTimes(1);
		expect(mocks.createMcpClient).toHaveBeenCalledWith({
			serverUrl: "https://app.example.com/api/mcp-gateway",
			transport: "HTTP",
			headers: {
				"x-agent-service-token": "service-secret-for-tests",
				"x-fabric-acting-grant": ACTOR.actingGrant,
				"x-fabric-acting-user": "user-1",
				"x-fabric-acting-organization": "org-1",
				"x-fabric-project": "project-1",
				"x-fabric-conversation": "conversation-1",
				"x-fabric-source-run-type": "direct-chat",
				"x-fabric-source-run-id": "run-1",
			},
		});
	});

	it("loads nothing without the service secret", async () => {
		delete process.env.AGENT_SERVICE_SECRET;

		expect(await loadFabricPlatformTools(ACTOR)).toBeNull();
		expect(mocks.createMcpClient).not.toHaveBeenCalled();
	});

	it("remembers the tool list, and opens a client only when a tool runs", async () => {
		await load();
		const second = await load();

		expect(mocks.listTools).toHaveBeenCalledTimes(1);
		expect(mocks.createMcpClient).toHaveBeenCalledTimes(1);

		await second
			.tool("fabric_get_workflow")
			.execute({ workflowId: "wf-1" });
		expect(mocks.createMcpClient).toHaveBeenCalledTimes(2);
	});

	it("closes the client it opened, and none it did not", async () => {
		const first = await load();
		await first.platform.close();
		expect(mocks.closeClient).toHaveBeenCalledTimes(1);

		mocks.closeClient.mockClear();
		const cached = await load();
		await cached.platform.close();
		expect(mocks.closeClient).not.toHaveBeenCalled();
	});

	it("goes on without the tools when the gateway cannot be reached, and does not retry every turn", async () => {
		mocks.listTools.mockRejectedValue(new Error("connection refused"));

		expect(await loadFabricPlatformTools(ACTOR)).toBeNull();
		expect(await loadFabricPlatformTools(ACTOR)).toBeNull();

		expect(mocks.listTools).toHaveBeenCalledTimes(1);
	});
});

describe("results", () => {
	it("hands the model the JSON a tool returned, not the protocol envelope", async () => {
		mocks.callTool.mockResolvedValue(ok({ workflows: [{ id: "wf-1" }] }));
		const { tool } = await load();

		expect(await tool("fabric_list_workflows").execute({})).toEqual({
			workflows: [{ id: "wf-1" }],
		});
	});

	it("passes a refusal through as an error, keeping what it carried", () => {
		const refused = {
			isError: true,
			content: [
				{
					type: "text",
					text: JSON.stringify({
						error: "cannot be published",
						problems: ["a"],
					}),
				},
			],
		};

		expect(unwrapGatewayResult(refused)).toEqual({
			error: "cannot be published",
			problems: ["a"],
		});
		expect(
			unwrapGatewayResult({
				isError: true,
				content: [{ type: "text", text: "plain failure" }],
			}),
		).toEqual({ error: "plain failure" });
	});
});

describe("tools that need the person's yes", () => {
	it("does not call the gateway for a write without approval, and asks for a draft instead", async () => {
		mocks.callTool.mockResolvedValue(
			ok({
				draft: {
					kind: "workflow",
					name: "Weekly digest",
					problems: [],
				},
			}),
		);
		const { tool } = await load();
		const args = { preset: { name: "Weekly digest" } };

		const result = await tool("fabric_create_workflow").execute(args);

		expect(mocks.callTool).toHaveBeenCalledTimes(1);
		expect(mocks.callTool).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "fabric_create_workflow",
				arguments: { preset: { name: "Weekly digest" }, dryRun: true },
			}),
		);
		expect(result).toMatchObject({
			requiresConfirmation: true,
			toolName: "fabric_create_workflow",
			args,
			draft: { kind: "workflow", name: "Weekly digest" },
		});
	});

	it("never lets the model turn the dry run into the real call", async () => {
		const { tool } = await load();

		await tool("fabric_create_workflow").execute({
			preset: { name: "x" },
			dryRun: false,
		});

		const [{ arguments: sent }] = mocks.callTool.mock.calls[0];
		expect(sent.dryRun).toBe(true);
	});

	it("returns the gateway's refusal, not a confirmation, when the dry run is refused", async () => {
		mocks.callTool.mockResolvedValue({
			isError: true,
			content: [
				{
					type: "text",
					text: JSON.stringify({ error: "no permission" }),
				},
			],
		});
		const { tool } = await load();

		const result = await tool("fabric_create_workflow").execute({});

		expect(result).toEqual({ error: "no permission" });
	});

	it("describes the workflow an execute or publish would act on, from a read", async () => {
		mocks.callTool.mockResolvedValue(
			ok({
				id: "wf-1",
				name: "Weekly digest",
				description: "d",
				status: "PUBLISHED",
			}),
		);
		const { tool } = await load();

		const result = await tool("fabric_execute_workflow").execute({
			workflowId: "wf-1",
		});

		expect(mocks.callTool).toHaveBeenCalledTimes(1);
		expect(mocks.callTool).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "fabric_get_workflow",
				arguments: { workflowId: "wf-1" },
			}),
		);
		expect(result).toMatchObject({
			requiresConfirmation: true,
			toolName: "fabric_execute_workflow",
			args: { workflowId: "wf-1" },
			draft: {
				kind: "workflow-action",
				workflowId: "wf-1",
				workflowName: "Weekly digest",
			},
		});
	});

	it("runs the call the person approved, with exactly the arguments they were shown", async () => {
		mocks.callTool.mockResolvedValue(
			ok({ created: true, workflow: { id: "wf-9" } }),
		);
		const { platform } = await load();
		const args = { preset: { name: "Weekly digest" } };

		const result = await platform.runApproved(
			"fabric_create_workflow",
			args,
		);

		expect(result).toMatchObject({ created: true });
		expect(mocks.callTool).toHaveBeenCalledTimes(1);
		expect(mocks.callTool).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "fabric_create_workflow",
				arguments: args,
			}),
		);
	});

	it("passes a call carrying the person's exact approval, and only that call", async () => {
		const { tool } = await load();
		const approval = {
			userId: "user-1",
			organizationId: "org-1",
			configId: "fabric-platform",
			originalName: "fabric_publish_workflow",
			args: { workflowId: "wf-1" },
		};

		await withApprovedAgentTool(approval, () =>
			tool("fabric_publish_workflow").execute({ workflowId: "wf-1" }),
		);
		expect(mocks.callTool).toHaveBeenCalledTimes(1);

		mocks.callTool.mockClear();
		await withApprovedAgentTool(approval, () =>
			tool("fabric_publish_workflow").execute({ workflowId: "wf-2" }),
		);
		expect(mocks.callTool).not.toHaveBeenCalledWith(
			expect.objectContaining({
				name: "fabric_publish_workflow",
				arguments: { workflowId: "wf-2" },
			}),
		);
	});

	it("approving a created workflow also approves publishing and running that workflow, and no other", async () => {
		mocks.callTool.mockImplementation(async ({ name }: { name: string }) =>
			ok(
				name === "fabric_create_workflow"
					? { created: true, workflow: { id: "wf-new" } }
					: { done: name },
			),
		);
		const { platform, tool } = await load();
		await platform.runApproved("fabric_create_workflow", {
			preset: { name: "x" },
		});
		mocks.callTool.mockClear();

		await tool("fabric_publish_workflow").execute({ workflowId: "wf-new" });
		await tool("fabric_execute_workflow").execute({ workflowId: "wf-new" });
		expect(mocks.callTool.mock.calls.map(([call]) => call.name)).toEqual([
			"fabric_publish_workflow",
			"fabric_execute_workflow",
		]);

		mocks.callTool.mockClear();
		const other = await tool("fabric_publish_workflow").execute({
			workflowId: "wf-someone-elses",
		});
		expect(other).toMatchObject({ requiresConfirmation: true });
		expect(
			mocks.callTool.mock.calls.map(([call]) => call.name),
		).not.toContain("fabric_publish_workflow");
	});

	it("covers one publish and one run with no inputs, as the Orchestrator does, and asks for anything more", async () => {
		mocks.callTool.mockImplementation(async ({ name }: { name: string }) =>
			ok(
				name === "fabric_create_workflow"
					? { created: true, workflow: { id: "wf-new" } }
					: { done: name },
			),
		);
		const { platform, tool } = await load();
		await platform.runApproved("fabric_create_workflow", {
			preset: { name: "x" },
		});
		const ran = () =>
			mocks.callTool.mock.calls
				.map(([call]) => call)
				.filter(
					(call: { name: string }) =>
						call.name === "fabric_publish_workflow" ||
						call.name === "fabric_execute_workflow",
				);
		mocks.callTool.mockClear();

		const withInputs = await tool("fabric_execute_workflow").execute({
			workflowId: "wf-new",
			inputs: { x: 1 },
		});
		expect(withInputs).toMatchObject({ requiresConfirmation: true });
		expect(ran()).toEqual([]);

		await tool("fabric_execute_workflow").execute({
			workflowId: "wf-new",
			inputs: {},
		});
		await tool("fabric_publish_workflow").execute({ workflowId: "wf-new" });
		expect(ran().map((call: { name: string }) => call.name)).toEqual([
			"fabric_execute_workflow",
			"fabric_publish_workflow",
		]);

		mocks.callTool.mockClear();
		const secondRun = await tool("fabric_execute_workflow").execute({
			workflowId: "wf-new",
		});
		const secondPublish = await tool("fabric_publish_workflow").execute({
			workflowId: "wf-new",
		});
		expect(secondRun).toMatchObject({ requiresConfirmation: true });
		expect(secondPublish).toMatchObject({ requiresConfirmation: true });
		expect(ran()).toEqual([]);
	});

	it("keeps the run covered when the gateway refused the first try, and covers it once", async () => {
		let published = false;
		mocks.callTool.mockImplementation(
			async ({ name }: { name: string }) => {
				if (name === "fabric_create_workflow") {
					return ok({ created: true, workflow: { id: "wf-new" } });
				}
				if (name === "fabric_publish_workflow") {
					published = true;
					return ok({ published: true });
				}
				if (name === "fabric_execute_workflow" && !published) {
					return {
						isError: true,
						content: [
							{
								type: "text",
								text: JSON.stringify({
									error: "The workflow is not published",
								}),
							},
						],
					};
				}
				return ok({ done: name });
			},
		);
		const { platform, tool } = await load();
		await platform.runApproved("fabric_create_workflow", {
			preset: { name: "x" },
		});
		const runs = () =>
			mocks.callTool.mock.calls.filter(
				([call]) => call.name === "fabric_execute_workflow",
			).length;

		expect(
			await tool("fabric_execute_workflow").execute({
				workflowId: "wf-new",
			}),
		).toMatchObject({ error: "The workflow is not published" });
		await tool("fabric_publish_workflow").execute({ workflowId: "wf-new" });
		expect(
			await tool("fabric_execute_workflow").execute({
				workflowId: "wf-new",
			}),
		).toEqual({ done: "fabric_execute_workflow" });
		expect(runs()).toBe(2);

		expect(
			await tool("fabric_execute_workflow").execute({
				workflowId: "wf-new",
			}),
		).toMatchObject({ requiresConfirmation: true });
		expect(runs()).toBe(2);
	});

	it("refuses to run an action that needs no approval, or one the gateway does not offer, as an approved call", async () => {
		const { platform } = await load();

		expect(
			await platform.runApproved("fabric_list_workflows", {}),
		).toMatchObject({
			error: expect.stringContaining("not an action that needs approval"),
		});
		expect(
			await platform.runApproved("fabric_list_projects", {}),
		).toMatchObject({
			error: expect.stringContaining("not an action that needs approval"),
		});
		expect(mocks.callTool).not.toHaveBeenCalled();
	});

	it("does not run a write in a project in Read-only mode, approved or not", async () => {
		const blocked = { blocked: true, reason: "read-only" };
		mocks.guardToolWriteForReadOnly.mockResolvedValue(blocked);
		const { platform, tool } = await load();

		expect(await tool("fabric_create_workflow").execute({})).toBe(blocked);
		expect(
			await platform.runApproved("fabric_publish_workflow", {
				workflowId: "wf-1",
			}),
		).toBe(blocked);
		expect(mocks.callTool).not.toHaveBeenCalled();
		expect(mocks.guardToolWriteForReadOnly).toHaveBeenCalledWith(
			"project-1",
			"fabric_create_workflow",
			{ accessOverride: "WRITE" },
		);
	});

	it("does not ask the Read-only gate about a read", async () => {
		const { tool } = await load();

		await tool("fabric_list_workflows").execute({});

		expect(mocks.guardToolWriteForReadOnly).not.toHaveBeenCalled();
	});
});

describe("a call the caller has already authorized", () => {
	it("runs a tool that needs confirmation without asking again, with exactly the arguments given", async () => {
		const { platform } = await load();
		const args = { workflowId: "wf-1" };

		const result = await platform.callAuthorized(
			"fabric_publish_workflow",
			args,
		);

		expect(result).toEqual({ ok: true });
		expect(mocks.callTool).toHaveBeenCalledTimes(1);
		expect(mocks.callTool).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "fabric_publish_workflow",
				arguments: args,
			}),
		);
	});

	it("runs a read as it is", async () => {
		const { platform } = await load();

		await platform.callAuthorized("fabric_list_workflows", {});

		expect(mocks.callTool).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "fabric_list_workflows",
				arguments: {},
			}),
		);
	});

	it("passes a dry run's draft through for the caller to show", async () => {
		mocks.callTool.mockResolvedValue(
			ok({ draft: { name: "Weekly digest" } }),
		);
		const { platform } = await load();

		const result = await platform.callAuthorized("fabric_create_workflow", {
			preset: { name: "Weekly digest" },
			dryRun: true,
		});

		expect(result).toEqual({ draft: { name: "Weekly digest" } });
	});

	it("is limited to the same allowlist as the model's tools", async () => {
		const { platform } = await load();

		expect(
			await platform.callAuthorized("fabric_create_project", {}),
		).toMatchObject({ error: expect.stringContaining("not available") });
		expect(
			await platform.callAuthorized("linear__list_issues", {}),
		).toMatchObject({ error: expect.stringContaining("not available") });
		expect(mocks.callTool).not.toHaveBeenCalled();
	});

	it("still refuses a write in a project in Read-only mode", async () => {
		const blocked = { blocked: true, reason: "read-only" };
		mocks.guardToolWriteForReadOnly.mockResolvedValue(blocked);
		const { platform } = await load();

		expect(
			await platform.callAuthorized("fabric_publish_workflow", {
				workflowId: "wf-1",
			}),
		).toBe(blocked);
		expect(mocks.callTool).not.toHaveBeenCalled();
	});

	it("acts for the user the loader was given, in the context it was given", async () => {
		const { platform } = await load();

		await platform.callAuthorized("fabric_list_workflows", {});

		expect(mocks.createMcpClient).toHaveBeenCalledWith(
			expect.objectContaining({
				headers: expect.objectContaining({
					"x-fabric-acting-user": "user-1",
					"x-fabric-acting-organization": "org-1",
					"x-fabric-project": "project-1",
					"x-fabric-conversation": "conversation-1",
					"x-fabric-source-run-type": "direct-chat",
					"x-fabric-source-run-id": "run-1",
				}),
			}),
		);
	});
});

describe("every workflow write asks, and a frame write asks only when it gives the page tools", () => {
	it.each([
		"fabric_create_workflow",
		"fabric_update_workflow",
		"fabric_publish_workflow",
		"fabric_unpublish_workflow",
		"fabric_pause_workflow",
		"fabric_resume_workflow",
		"fabric_execute_workflow",
	])("%s does not reach the gateway without approval", async (name) => {
		mocks.callTool.mockResolvedValue(ok({ draft: { name: "Draft" } }));
		const { tool } = await load();

		const result = await tool(name).execute({ workflowId: "wf-1" });

		expect(result).toMatchObject({
			requiresConfirmation: true,
			toolName: name,
		});
		const writes = mocks.callTool.mock.calls
			.map(([call]) => call)
			.filter(
				(call) => call.name === name && call.arguments.dryRun !== true,
			);
		expect(writes).toEqual([]);
	});

	it.each(["fabric_create_frame", "fabric_update_frame"])(
		"%s asks when the call sets runtimeTools, and says what it would run",
		async (name) => {
			const { tool } = await load();
			const args = {
				title: "Status",
				runtimeTools: ["fabric_list_workflows"],
			};

			const result = await tool(name).execute(args);

			expect(result).toMatchObject({
				requiresConfirmation: true,
				toolName: name,
				args,
			});
			expect(mocks.callTool).not.toHaveBeenCalled();
		},
	);

	it.each(["fabric_create_frame", "fabric_update_frame"])(
		"%s does not ask when the page is given no tools",
		async (name) => {
			const { tool } = await load();

			for (const args of [
				{ title: "Status" },
				{ title: "Status", runtimeTools: [] },
			]) {
				mocks.callTool.mockClear();
				const result = await tool(name).execute(args);

				expect(result).toEqual({ ok: true });
				expect(mocks.callTool).toHaveBeenCalledWith(
					expect.objectContaining({ name, arguments: args }),
				);
			}
		},
	);

	it.each([
		"fabric_create_slideshow",
		"fabric_get_frame",
		"fabric_list_frame_versions",
		"fabric_page_data_set",
		"fabric_page_comment_add",
	])("%s asks nothing", async (name) => {
		const { tool } = await load();

		await tool(name).execute({ frameId: "frame-1", title: "Deck" });

		expect(mocks.callTool).toHaveBeenCalledWith(
			expect.objectContaining({ name }),
		);
	});

	it.each(["fabric_share_frame", "fabric_restore_frame_version"])(
		"%s asks for every call, and says what it would do",
		async (name) => {
			const { tool } = await load();
			const args = { frameId: "frame-1" };

			const result = await tool(name).execute(args);

			expect(result).toMatchObject({
				requiresConfirmation: true,
				toolName: name,
				args,
			});
			expect(mocks.callTool).not.toHaveBeenCalled();
		},
	);

	it("asks about a fork only when the call gives it page tools", async () => {
		const { tool } = await load();

		expect(
			await tool("fabric_duplicate_frame").execute({
				frameId: "frame-1",
			}),
		).toEqual({ ok: true });
		mocks.callTool.mockClear();

		const asked = await tool("fabric_duplicate_frame").execute({
			frameId: "frame-1",
			runtimeTools: ["fabric_list_frames"],
		});

		expect(asked).toMatchObject({ requiresConfirmation: true });
		expect(mocks.callTool).not.toHaveBeenCalled();
	});

	it("takes a policy it does not understand to mean every call", async () => {
		mocks.listTools.mockResolvedValue({
			tools: [
				{
					name: "fabric_get_frame",
					description: "x",
					inputSchema: { type: "object", properties: {} },
					annotations: { readOnlyHint: true },
					_meta: { "fabric/confirm": { someNewShape: 1 } },
				},
			],
		});
		const { tool } = await load();

		expect(await tool("fabric_get_frame").execute({})).toMatchObject({
			requiresConfirmation: true,
		});
		expect(mocks.callTool).not.toHaveBeenCalled();
	});
});

describe("a grant that has run out", () => {
	it("answers a tool call with a message to send again, without calling the gateway", async () => {
		const expired = await loadFabricPlatformTools({
			...ACTOR,
			actingGrant: grantExpiringIn(-10),
		});
		const tool = expired?.tools.fabric_list_workflows as {
			execute: (args: Record<string, unknown>) => Promise<unknown>;
		};

		const result = await tool.execute({});

		expect(result).toMatchObject({
			error: expect.stringContaining("send their message again"),
		});
		expect(mocks.callTool).not.toHaveBeenCalled();
	});

	it("says the same when the gateway refuses the grant", async () => {
		mocks.callTool.mockRejectedValue(
			new Error(
				"Streamable HTTP error: Error POSTing to endpoint (HTTP 401)",
			),
		);
		const { tool } = await load();

		expect(await tool("fabric_list_workflows").execute({})).toMatchObject({
			error: expect.stringContaining("send their message again"),
		});
	});
});
