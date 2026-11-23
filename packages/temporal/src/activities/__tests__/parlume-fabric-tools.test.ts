/**
 * Fabric MCP's tools inside a Parlume meeting.
 *
 * The Fabric Agent in a meeting is offered the same Fabric tools as the chat,
 * and Parlume's own action gate, not the gateway's confirmation card, decides
 * what any of them may do there: a project read runs, a project change is
 * refused in a read-only meeting, and in an actions meeting it is proposed
 * once, with who asked for it, for a member to confirm. A tool above project
 * read (workflows, frames and pages, and the tools that answer for the person
 * rather than the project) is refused in every meeting, read or change, since
 * a meeting answer uses only what every project member can read. These tests
 * run the real gateway client and
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
		chatAvailable: true,
	})),
	postParlumeProposal: vi.fn(async () => ({ sent: true, tag: "P3" })),
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
	const delegates = {
		parlumeMeetingSession: session,
		parlumeAction: action,
		project: { findUnique: vi.fn(async () => ({ name: "Example" })) },
	};
	return {
		...actual,
		db: {
			...delegates,
			$transaction: (run: (tx: typeof delegates) => Promise<unknown>) =>
				run(delegates),
		},
		buildParlumeActionUrl: vi.fn(
			async ({ actionId }: { actionId: string }) =>
				`https://app.example.com/app/example-org/projects/project/parlume/actions/${actionId}`,
		),
		hasProjectAccess: vi.fn(async () => true),
		canEditProject: vi.fn(async () => true),
		recordAuditTx: vi.fn(),
	};
});

import { classifyReadOnlyToolAccess } from "@repo/utils/read-only-mode";
import { FABRIC_CHAT_TOOL_DEFINITIONS } from "../../lib/fabric-gateway-tools";
import {
	FABRIC_MEETING_WITHHELD_TOOL_NAMES,
	FABRIC_PORTAL_EXCLUDED_TOOL_NAMES,
	FABRIC_PORTAL_PROJECT_TOOL_NAMES,
	FABRIC_PORTAL_TOOL_NAMES,
	isFabricPortalProjectTool,
} from "../../lib/fabric-portal-tools";
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
/** What a meeting turn is offered: never the inviter's own workspaces. */
const offeredInMeeting = (name: string) =>
	!FABRIC_MEETING_WITHHELD_TOOL_NAMES.includes(name);
const MEETING_PORTAL_READS = PORTAL_READS.filter(offeredInMeeting);
const MEETING_EXCLUDED_WRITES = FABRIC_CHAT_TOOL_DEFINITIONS.filter(
	(tool) =>
		toolAccess(tool) === "WRITE" &&
		FABRIC_PORTAL_EXCLUDED_TOOL_NAMES.includes(tool.name),
).map((tool) => tool.name);
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

	it.each(MEETING_EXCLUDED_WRITES)(
		"never offers the meeting-excluded Fabric change %s",
		async (name) => {
			const { tools } = await turnTools(
				createParlumeToolRuntime({ ...context, toolsReadOnly: true }),
			);

			expect(tools[name]).toBeUndefined();
		},
	);
});

/**
 * Above project read: workflows, frames and pages, and the tools that answer
 * for the person rather than the project. Even an actions meeting, the more
 * permissive mode, neither runs nor proposes them.
 */
const ABOVE_PROJECT_READ = [
	"fabric_list_workflows",
	"fabric_get_workflow",
	"fabric_list_frames",
	...FABRIC_CHAT_TOOL_DEFINITIONS.filter(
		(tool) =>
			toolAccess(tool) === "WRITE" &&
			!MEETING_EXCLUDED_WRITES.includes(tool.name),
	).map((tool) => tool.name),
	...FABRIC_PORTAL_TOOL_NAMES.filter(
		(name) => !isFabricPortalProjectTool(name) && offeredInMeeting(name),
	),
];

describe("Fabric tools above project read in a meeting", () => {
	it.each(ABOVE_PROJECT_READ)(
		"refuses %s without reaching the gateway or proposing",
		async (name) => {
			const { tools } = await turnTools();

			const result = await tools[name].execute({
				workflowId: "wf-1",
				...WORKFLOW,
			});

			expect(result).toMatchObject({
				error: expect.stringContaining("every project member can read"),
			});
			expect(gatewayCalls(name)).toHaveLength(0);
			expect(mocks.state.action).toBeUndefined();
		},
	);
});

describe("Fabric portal tools in a read-only meeting", () => {
	beforeEach(() => {
		mocks.state.session.toolsReadOnly = true;
	});
	const readOnly = () =>
		createParlumeToolRuntime({ ...context, toolsReadOnly: true });

	it.each(MEETING_PORTAL_READS)("runs the read %s", async (name) => {
		const { tools } = await turnTools(readOnly());

		await tools[name].execute({});

		expect(gatewayCalls(name)).toHaveLength(1);
		expect(mocks.state.action).toBeUndefined();
	});

	it.each(
		FABRIC_PORTAL_PROJECT_TOOL_NAMES.filter(
			(name) => !PORTAL_READS.includes(name) && offeredInMeeting(name),
		),
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
		await tools.fabric_search_project_knowledge.execute({});

		expect(gatewayCalls("fabric_get_feature")).toHaveLength(1);
		expect(gatewayCalls("fabric_search_project_knowledge")).toHaveLength(1);
		expect(mocks.state.action).toBeUndefined();
	});

	it("never offers the inviter's own workspaces", async () => {
		const { tools } = await turnTools();

		for (const name of FABRIC_MEETING_WITHHELD_TOOL_NAMES) {
			expect(tools).not.toHaveProperty(name);
		}
	});

	it("proposes a portal change once, exactly as asked, records who asked, and makes no change", async () => {
		const { tools } = await turnTools();
		const update = tools.fabric_update_feature_status;
		const change = { featureId: "feature-1", status: "IN_REVIEW" };

		const result = await update.execute(change, { toolCallId: "call-1" });
		await update.execute(change, { toolCallId: "call-2" });

		expect(result).toMatchObject({ proposed: true, changed: false });
		expect(gatewayCalls("fabric_update_feature_status")).toHaveLength(0);
		expect(mocks.state.action).toMatchObject({
			speakerId: "speaker-a",
			toolConfigId: "fabric-platform",
			toolOriginalName: "fabric_update_feature_status",
			arguments: change,
			status: "PROPOSED",
			chatTag: "P3",
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
