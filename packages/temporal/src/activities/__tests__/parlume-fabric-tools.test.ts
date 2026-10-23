/**
 * Fabric MCP's tools inside a Parlume meeting.
 *
 * The Fabric Agent in a meeting is offered the same Fabric tools as the chat,
 * and Parlume's own action gate, not the gateway's confirmation card, decides
 * what any of them may do there: a read runs, a change is refused in a
 * read-only meeting, and in an actions meeting it runs at once, once, and is
 * recorded with who asked for it. These tests run the real gateway client and
 * the real gate against a fake gateway, so the pieces that have to agree (the
 * source a tool is registered under and the source its approval is recorded
 * under) are checked together.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	createMcpClient: vi.fn(),
	listTools: vi.fn(),
	callTool: vi.fn(),
	closeClient: vi.fn(),
	guardToolWriteForReadOnly: vi.fn(),
	state: {
		session: {} as Record<string, unknown>,
		action: undefined as Record<string, unknown> | undefined,
	},
}));

vi.mock("@repo/mcp", () => ({ createMcpClient: mocks.createMcpClient }));
vi.mock("@repo/agent-core/backend", () => ({
	closeMcpClientSafe: mocks.closeClient,
}));
vi.mock("@repo/utils", () => ({ getBaseUrl: () => "https://app.example.com" }));
vi.mock("../shared/read-only-gate", () => ({
	guardToolWriteForReadOnly: mocks.guardToolWriteForReadOnly,
}));
vi.mock("../parlume-voice", () => ({
	readParlumeVoiceState: vi.fn(async () => ({
		current: true,
		muted: false,
		chatAvailable: true,
	})),
}));
vi.mock("@repo/database", async (original) => {
	const actual = await original<typeof import("@repo/database")>();
	const matches = (
		row: Record<string, unknown>,
		where: Record<string, unknown>,
	) =>
		Object.entries(where).every(([key, expected]) => {
			const actual = row[key];
			if (
				typeof expected === "object" &&
				expected !== null &&
				!(expected instanceof Date)
			) {
				if ("in" in expected && Array.isArray(expected.in)) {
					return expected.in.includes(actual);
				}
				if ("gt" in expected && expected.gt instanceof Date) {
					return actual instanceof Date && actual > expected.gt;
				}
				if ("not" in expected) {
					return actual !== expected.not;
				}
				return false;
			}
			return actual instanceof Date && expected instanceof Date
				? actual.getTime() === expected.getTime()
				: actual === expected;
		});
	const session = {
		findFirst: vi.fn(
			async ({ where }: { where: Record<string, unknown> }) =>
				matches(mocks.state.session, where)
					? structuredClone(mocks.state.session)
					: null,
		),
		updateMany: vi.fn(
			async ({
				where,
				data,
			}: {
				where: Record<string, unknown>;
				data: Record<string, unknown>;
			}) => {
				if (!matches(mocks.state.session, where)) {
					return { count: 0 };
				}
				Object.assign(mocks.state.session, data);
				return { count: 1 };
			},
		),
	};
	const action = {
		createMany: vi.fn(
			async ({ data }: { data: Record<string, unknown> }) => {
				if (mocks.state.action) {
					return { count: 0 };
				}
				mocks.state.action = structuredClone(data);
				return { count: 1 };
			},
		),
		findUnique: vi.fn(async () =>
			mocks.state.action ? structuredClone(mocks.state.action) : null,
		),
		update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
			if (mocks.state.action) {
				Object.assign(mocks.state.action, structuredClone(data));
			}
			return structuredClone(mocks.state.action);
		}),
	};
	const delegates = { parlumeMeetingSession: session, parlumeAction: action };
	return {
		...actual,
		db: {
			...delegates,
			$transaction: (run: (tx: typeof delegates) => Promise<unknown>) =>
				run(delegates),
		},
		hasProjectAccess: vi.fn(async () => true),
		canEditProject: vi.fn(async () => true),
		recordAuditTx: vi.fn(),
	};
});

import { classifyReadOnlyToolAccess } from "@repo/utils/read-only-mode";
import { FABRIC_CHAT_TOOL_DEFINITIONS } from "../../lib/fabric-gateway-tools";
import { FABRIC_PORTAL_TOOL_NAMES } from "../../lib/fabric-portal-tools";
import { confirmationMeta, toolAccess } from "../../lib/fabric-tool-definition";
import { fabricToolSources } from "../direct-chat/fabric-turn-tools";
import {
	createParlumeToolRuntime,
	type ParlumeActionContext,
} from "../parlume-actions";
import {
	prepareAgentTools,
	withAgentToolRuntime,
} from "../shared/agent-tool-runtime";
import {
	loadFabricPlatformTools,
	resetFabricPlatformMcpCache,
} from "../shared/fabric-platform-mcp";

function grantExpiringIn(seconds: number): string {
	const body = JSON.stringify({
		p: { purpose: "fabric-agent-acting-grant" },
		exp: Math.floor(Date.now() / 1000) + seconds,
	});
	return `${Buffer.from(body).toString("base64url")}.signature`;
}

const ACTOR = {
	userId: "user",
	organizationId: "org",
	actingGrant: grantExpiringIn(3_600),
	projectId: "project",
	sourceRunType: "direct-chat",
	sourceRunId: "parlume-turn",
};

/** Portal tools as the gateway lists them: reads say so, changes say nothing. */
const PORTAL_READS: readonly string[] = [
	"fabric_get_feature",
	"fabric_list_features",
	"fabric_search_project_knowledge",
	"fabric_instruction_checks",
	"fabric_query_workspace",
];
const PORTAL_LISTING = FABRIC_PORTAL_TOOL_NAMES.map((name) => ({
	name,
	description: `The ${name} tool.`,
	inputSchema: {
		type: "object",
		properties: { projectId: { type: "string" } },
	},
	annotations: PORTAL_READS.includes(name)
		? { readOnlyHint: true }
		: undefined,
}));

const GATEWAY_TOOLS = [
	...FABRIC_CHAT_TOOL_DEFINITIONS.map((tool) => ({
		name: tool.name,
		description: tool.description,
		inputSchema: tool.inputSchema,
		annotations: tool.annotations,
		_meta: confirmationMeta(tool),
	})),
	...PORTAL_LISTING,
];

const context: ParlumeActionContext = {
	turnId: "request",
	sessionId: "session",
	projectId: "project",
	organizationId: "org",
	userId: "user",
	speakerId: "speaker-a",
	speakerName: "Alex",
	requestText: "what is on the roadmap",
	agentRevision: "revision",
	voiceGeneration: 3,
	toolsReadOnly: false,
};

const WORKFLOW = {
	preset: {
		name: "Weekly summary",
		cron: "0 9 * * 1",
		prompt: "Summarise the week",
	},
};

type AgentTool = {
	execute: (
		args: Record<string, unknown>,
		options?: unknown,
	) => Promise<unknown>;
};

function gatewayAnswers(data: unknown) {
	return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

async function turnTools(runtime = createParlumeToolRuntime(context)) {
	const platform = await loadFabricPlatformTools(ACTOR, {
		portal: { offer: true },
	});
	if (!platform) {
		throw new Error("expected Fabric tools to load");
	}
	const tools = { ...platform.tools };
	const sources = fabricToolSources(platform);
	await withAgentToolRuntime(runtime, () =>
		prepareAgentTools(tools, sources),
	);
	return { platform, tools: tools as Record<string, AgentTool>, sources };
}

function gatewayCalls(name: string) {
	return mocks.callTool.mock.calls.filter(
		([call]) => (call as { name: string }).name === name,
	);
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
	mocks.callTool.mockResolvedValue(
		gatewayAnswers({ success: true, workflows: [] }),
	);
	mocks.guardToolWriteForReadOnly.mockResolvedValue(null);
	mocks.state.action = undefined;
	mocks.state.session = {
		id: "session",
		projectId: "project",
		organizationId: "org",
		userId: "user",
		status: "ACTIVE",
		voiceGeneration: 3,
		toolsReadOnly: false,
		activeTurnId: "confirm",
	};
});

describe("Fabric tools in a read-only meeting", () => {
	beforeEach(() => {
		mocks.state.session.toolsReadOnly = true;
	});

	it("runs a Fabric read", async () => {
		const { tools } = await turnTools(
			createParlumeToolRuntime({ ...context, toolsReadOnly: true }),
		);

		await tools.fabric_list_workflows.execute({});

		expect(gatewayCalls("fabric_list_workflows")).toHaveLength(1);
	});

	it.each(
		FABRIC_CHAT_TOOL_DEFINITIONS.filter(
			(tool) => toolAccess(tool) === "WRITE",
		).map((tool) => tool.name),
	)(
		"refuses the Fabric change %s without reaching the gateway or proposing",
		async (name) => {
			const { tools } = await turnTools(
				createParlumeToolRuntime({ ...context, toolsReadOnly: true }),
			);

			const result = await tools[name].execute({
				workflowId: "wf-1",
				...WORKFLOW,
			});

			expect(result).toMatchObject({
				error: expect.stringContaining("read-only"),
			});
			expect(gatewayCalls(name)).toHaveLength(0);
			expect(mocks.state.action).toBeUndefined();
		},
	);
});

describe("Fabric tools in an actions meeting", () => {
	it("runs a Fabric change at once, once, exactly as asked, without Fabric's own confirmation card", async () => {
		const { tools } = await turnTools();

		const result = await tools.fabric_create_workflow.execute(WORKFLOW, {
			toolCallId: "call-1",
		});
		await tools.fabric_create_workflow.execute(WORKFLOW, {
			toolCallId: "call-2",
		});

		expect(result).not.toHaveProperty("requiresConfirmation");
		expect(gatewayCalls("fabric_create_workflow")).toHaveLength(1);
		expect(gatewayCalls("fabric_create_workflow")[0]?.[0]).toEqual(
			expect.objectContaining({
				name: "fabric_create_workflow",
				arguments: WORKFLOW,
			}),
		);
		expect(mocks.state.action).toMatchObject({
			speakerId: "speaker-a",
			toolConfigId: "fabric-platform",
			toolOriginalName: "fabric_create_workflow",
			arguments: WORKFLOW,
			status: "COMPLETED",
		});
	});

	it("runs a Fabric read without a record", async () => {
		const { tools } = await turnTools();

		await tools.fabric_get_workflow.execute({ workflowId: "wf-1" });

		expect(gatewayCalls("fabric_get_workflow")).toHaveLength(1);
		expect(mocks.state.action).toBeUndefined();
	});

	it("keeps a Fabric tool inside the meeting's own project", async () => {
		const { tools } = await turnTools();

		const read = await tools.fabric_list_frames.execute({
			surface: "artifact",
			projectId: "another-project",
		});
		const change = await tools.fabric_create_frame.execute({
			title: "Plan",
			projectId: "another-project",
		});

		expect(read).toMatchObject({
			error: expect.stringContaining("own project"),
		});
		expect(change).toMatchObject({
			error: expect.stringContaining("own project"),
		});
		expect(mocks.callTool).not.toHaveBeenCalled();
		expect(mocks.state.action).toBeUndefined();
	});
});

describe("Fabric portal tools in a read-only meeting", () => {
	beforeEach(() => {
		mocks.state.session.toolsReadOnly = true;
	});
	const readOnly = () =>
		createParlumeToolRuntime({ ...context, toolsReadOnly: true });

	it.each(PORTAL_READS)("runs the read %s", async (name) => {
		const { tools } = await turnTools(readOnly());

		await tools[name].execute({});

		expect(gatewayCalls(name)).toHaveLength(1);
		expect(mocks.state.action).toBeUndefined();
	});

	it.each(
		FABRIC_PORTAL_TOOL_NAMES.filter((name) => !PORTAL_READS.includes(name)),
	)(
		"refuses the portal change %s without reaching the gateway",
		async (name) => {
			const { tools } = await turnTools(readOnly());

			const result = await tools[name].execute({ title: "x" });

			expect(result).toMatchObject({
				error: expect.stringContaining("read-only"),
			});
			expect(gatewayCalls(name)).toHaveLength(0);
			expect(mocks.state.action).toBeUndefined();
		},
	);

	it("reads a lookup its listing marks as a read, whatever its name looks like", async () => {
		expect(classifyReadOnlyToolAccess("fabric_instruction_checks")).toBe(
			"WRITE",
		);
		const { tools } = await turnTools(readOnly());

		await tools.fabric_instruction_checks.execute({});

		expect(gatewayCalls("fabric_instruction_checks")).toHaveLength(1);
	});
});

describe("Fabric portal tools in an actions meeting", () => {
	it("runs a portal read without a record", async () => {
		const { tools } = await turnTools();

		await tools.fabric_get_feature.execute({ featureId: "feature-1" });
		await tools.fabric_query_workspace.execute({});

		expect(gatewayCalls("fabric_get_feature")).toHaveLength(1);
		expect(gatewayCalls("fabric_query_workspace")).toHaveLength(1);
		expect(mocks.state.action).toBeUndefined();
	});

	it("runs a portal change at once, once, and records who asked", async () => {
		const { tools } = await turnTools();

		await tools.fabric_update_feature_status.execute({
			featureId: "feature-1",
			status: "IN_REVIEW",
		});
		await tools.fabric_update_feature_status.execute({
			featureId: "feature-1",
			status: "IN_REVIEW",
		});

		expect(gatewayCalls("fabric_update_feature_status")).toHaveLength(1);
		expect(mocks.state.action).toMatchObject({
			speakerId: "speaker-a",
			toolConfigId: "fabric-platform",
			toolOriginalName: "fabric_update_feature_status",
		});
	});

	it.each([
		["a project argument", { title: "x", projectId: "another-project" }],
		[
			"a nested project",
			{ title: "x", preset: { projectId: "another-project" } },
		],
		[
			"a project deep in a list",
			{ title: "x", items: [{ meta: { projectId: "another-project" } }] },
		],
	])(
		"refuses a portal change that names another project in %s",
		async (_name, args) => {
			const { tools } = await turnTools();

			const result = await tools.fabric_create_document.execute(args);

			expect(result).toMatchObject({
				error: expect.stringContaining("own project"),
			});
			expect(mocks.callTool).not.toHaveBeenCalled();
			expect(mocks.state.action).toBeUndefined();
		},
	);

	it("refuses a portal read that names another project", async () => {
		const { tools } = await turnTools();

		const result = await tools.fabric_list_features.execute({
			projectId: "another-project",
		});

		expect(result).toMatchObject({
			error: expect.stringContaining("own project"),
		});
		expect(mocks.callTool).not.toHaveBeenCalled();
	});

	it("lets a call that names the meeting's own project through", async () => {
		const { tools } = await turnTools();

		await tools.fabric_list_features.execute({ projectId: "project" });

		expect(gatewayCalls("fabric_list_features")).toHaveLength(1);
	});
});

describe("how a Fabric tool is classified in a meeting", () => {
	it("never lets a name pass as a read for a tool whose definition changes things", () => {
		const misclassified = FABRIC_CHAT_TOOL_DEFINITIONS.filter(
			(tool) =>
				toolAccess(tool) === "WRITE" &&
				classifyReadOnlyToolAccess(tool.name) === "READ",
		).map((tool) => tool.name);

		expect(misclassified).toEqual([]);
	});

	it("registers every tool of the turn under the source Fabric's approval is recorded under", async () => {
		const platform = await loadFabricPlatformTools(ACTOR);
		if (!platform) {
			throw new Error("expected Fabric tools to load");
		}

		const sources = fabricToolSources(platform);

		expect(Object.keys(sources).sort()).toEqual(
			Object.keys(platform.tools).sort(),
		);
		expect(sources.fabric_create_workflow).toEqual({
			configId: "fabric-platform",
			originalName: "fabric_create_workflow",
			access: "WRITE",
		});
		expect(sources.fabric_list_workflows).toMatchObject({ access: "READ" });
		expect(fabricToolSources(null)).toEqual({});
	});
});
