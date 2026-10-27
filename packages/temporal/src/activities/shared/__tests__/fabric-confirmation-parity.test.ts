/**
 * Both chat engines ask the person about a Fabric tool the same way.
 *
 * Direct chat reads a tool's confirmation policy off the gateway's `_meta` and
 * holds the call back itself; the Orchestrator reads the same policy from the
 * shared definition and raises a one-shot grant. They used to disagree (Direct
 * asked for four workflow writes, the Orchestrator for seven). This drives the
 * real Direct loader and the real Orchestrator classification over the same
 * tools and the same arguments and requires one answer, then pins that answer
 * to the policy the definitions state so the two cannot be wrong together.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	createMcpClient: vi.fn(),
	listTools: vi.fn(),
	callTool: vi.fn(),
}));

vi.mock("@repo/mcp", () => ({ createMcpClient: mocks.createMcpClient }));
vi.mock("@repo/agent-core/backend", () => ({ closeMcpClientSafe: vi.fn() }));
vi.mock("@repo/utils", () => ({ getBaseUrl: () => "https://app.example.com" }));
vi.mock("../read-only-gate", () => ({
	guardToolWriteForReadOnly: vi.fn(async () => null),
}));

import {
	FABRIC_CHAT_TOOL_DEFINITIONS,
	FABRIC_GATEWAY_TOOL_DEFINITIONS,
} from "../../../lib/fabric-gateway-tools";
import {
	confirmationMeta,
	type FabricToolDefinition,
	toolAccess,
} from "../../../lib/fabric-tool-definition";
import {
	resolveCatalogApproval,
	resolveFabricCatalogRoute,
} from "../../orchestrator/execution/fabric-catalog-adapter";
import {
	loadFabricPlatformTools,
	resetFabricPlatformMcpCache,
} from "../fabric-platform-mcp";

function grant(): string {
	const body = JSON.stringify({
		p: { purpose: "fabric-agent-acting-grant" },
		exp: Math.floor(Date.now() / 1000) + 3_600,
	});
	return `${Buffer.from(body).toString("base64url")}.signature`;
}

const ARGUMENTS: ReadonlyArray<Record<string, unknown>> = [
	{},
	{ workflowId: "wf-1" },
	{ title: "Status", runtimeTools: [] },
	{ title: "Status", runtimeTools: ["fabric_list_workflows"] },
	{ workflowId: "wf-1", preset: { name: "x" }, dryRun: true },
];

type ExecutableTool = {
	execute: (args: Record<string, unknown>) => Promise<unknown>;
};

async function directAsks(
	name: string,
	args: Record<string, unknown>,
): Promise<boolean> {
	const platform = await loadFabricPlatformTools({
		userId: "user-1",
		organizationId: "org-1",
		actingGrant: grant(),
	});
	if (!platform) {
		throw new Error("expected Fabric tools to load");
	}
	const result = await (platform.tools[name] as ExecutableTool).execute(args);
	return (
		typeof result === "object" &&
		result !== null &&
		"requiresConfirmation" in result &&
		result.requiresConfirmation === true
	);
}

function orchestratorAsks(
	name: string,
	args: Record<string, unknown>,
): boolean {
	return resolveCatalogApproval(name, args) !== "none";
}

beforeEach(() => {
	vi.clearAllMocks();
	resetFabricPlatformMcpCache();
	process.env.AGENT_SERVICE_SECRET = "service-secret-for-tests";
	mocks.createMcpClient.mockResolvedValue({
		listTools: mocks.listTools,
		callTool: mocks.callTool,
	});
	mocks.listTools.mockResolvedValue({
		tools: FABRIC_GATEWAY_TOOL_DEFINITIONS.map((tool) => ({
			name: tool.name,
			description: tool.description,
			inputSchema: tool.inputSchema,
			annotations: tool.annotations,
			_meta: confirmationMeta(tool),
		})),
	});
	mocks.callTool.mockResolvedValue({
		content: [{ type: "text", text: JSON.stringify({ draft: {} }) }],
	});
});

describe("Direct chat and the Orchestrator ask about a Fabric tool the same way", () => {
	for (const tool of FABRIC_CHAT_TOOL_DEFINITIONS) {
		it(`${tool.name}: the same answer for every call`, async () => {
			for (const args of ARGUMENTS) {
				const direct = await directAsks(tool.name, args);
				const orchestrator = orchestratorAsks(tool.name, args);

				expect(
					{ args, direct },
					`Direct and the Orchestrator disagree about ${tool.name}`,
				).toEqual({ args, direct: orchestrator });
			}
		});
	}

	it("asks for every call of a workflow write, of a share, of a version restore and of a delete of a page's data or files, and for no read", async () => {
		const ALWAYS_ASKING_FRAME_TOOLS = [
			"fabric_share_frame",
			"fabric_restore_frame_version",
			"fabric_page_data_delete",
			"fabric_page_file_delete",
		];
		for (const tool of FABRIC_CHAT_TOOL_DEFINITIONS) {
			const asksEveryCall =
				(tool.name.endsWith("_workflow") &&
					toolAccess(tool) === "WRITE") ||
				ALWAYS_ASKING_FRAME_TOOLS.includes(tool.name);
			const asks = await directAsks(tool.name, { workflowId: "wf-1" });

			expect(asks, tool.name).toBe(asksEveryCall);
			expect(
				orchestratorAsks(tool.name, { workflowId: "wf-1" }),
				tool.name,
			).toBe(asksEveryCall);
		}
	});

	it("offers neither engine a tool only a page's script has a use for", async () => {
		const platform = await loadFabricPlatformTools({
			userId: "user-1",
			organizationId: "org-1",
			actingGrant: grant(),
		});

		const gatewayTools: readonly FabricToolDefinition[] =
			FABRIC_GATEWAY_TOOL_DEFINITIONS;
		for (const tool of gatewayTools.filter(
			(candidate) => candidate.pageOnly === true,
		)) {
			expect(platform?.tools[tool.name], tool.name).toBeUndefined();
			expect(
				resolveFabricCatalogRoute(tool.name),
				tool.name,
			).toBeUndefined();
		}
		expect(platform?.tools.fabric_page_data_set).toBeDefined();
	});

	it.each([
		"fabric_create_frame",
		"fabric_update_frame",
		"fabric_edit_frame_block",
		"fabric_duplicate_frame",
	])(
		"asks about %s only when the call gives the page tools",
		async (name) => {
			for (const [args, asks] of [
				[{ title: "Status" }, false],
				[{ title: "Status", runtimeTools: [] }, false],
				[
					{
						title: "Status",
						runtimeTools: ["fabric_list_workflows"],
					},
					true,
				],
			] as const) {
				expect(await directAsks(name, args), name).toBe(asks);
				expect(orchestratorAsks(name, args), name).toBe(asks);
			}
		},
	);

	it("asks nothing about a draft, in either engine, because it writes nothing", async () => {
		const args = {
			workflowId: "wf-1",
			preset: { name: "x" },
			dryRun: true,
		};

		expect(await directAsks("fabric_update_workflow", args)).toBe(false);
		expect(orchestratorAsks("fabric_update_workflow", args)).toBe(false);
	});
});
