/**
 * Runs the real `executeDirectChatActivity` up to its `streamText` call and
 * asserts on the request it actually builds, rather than on the source text.
 *
 * Covers the call-site wiring that the pure builders' tests cannot see:
 *   - `callerHasPersona = Boolean(input.systemPrompt?.trim())` decides whether
 *     the Advisor identity is included, on the legacy string shape AND on both
 *     prompt-cache shapes (adjacent system blocks, and the rolling-history
 *     shape that moves the variable context into a terminal system message).
 *   - The web search guidelines name the tool that is really registered
 *     (`webSearch` or `fabric_web_search`) and vanish when tools are off.
 *   - `list_skills` is named in the capabilities block only when the skill
 *     tools were registered.
 *   - Company context (Fizzy #2719): only a turn the Advisor opted in, for a
 *     person the access resolver lets through to an organization with ready
 *     sources, gets the search tool and the line naming the organization;
 *     every other turn's tools and prompt are exactly what they were.
 *
 * Boundaries mocked: the AI SDK (the `streamText` request is captured and a
 * minimal empty stream returned), model resolution, the database, built-in /
 * advisor / skill tool factories, the company context access resolver and
 * search, and the shared agent-tool runtime.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DirectChatWorkflowInput } from "../../../types";

const state = vi.hoisted(() => ({
	streamText: undefined as undefined | ((req: unknown) => unknown),
	captured: undefined as unknown,
	modelContext: undefined as unknown,
	provider: "OPENAI",
	modelString: "gpt-test",
	builtInTools: {} as Record<string, unknown>,
	skills: [] as Array<{ slug: string }>,
	companyContextAccess: null as null | {
		organizationId: string;
		organizationName: string;
		readySourceCount: number;
	},
	resolveCompanyContextAccess: vi.fn(),
}));

vi.mock("@repo/agent-core/backend", () => ({
	closeMcpClientSafe: vi.fn(),
	getMcpClient: vi.fn(),
}));
vi.mock("@repo/ai", () => ({
	convertToModelMessages: async (
		messages: Array<{
			role: string;
			parts: Array<{ text: string }>;
		}>,
	) =>
		messages.map((m) => ({
			role: m.role,
			content: m.parts.map((p) => p.text).join(""),
		})),
	enhancePromptWithFabric: async () => ({ fabricUsed: false }),
	getAIModelWithMetadata: async (_options: unknown, context: unknown) => {
		state.modelContext = context;
		return {
			model: { id: "test-model" },
			metadata: {
				provider: state.provider,
				modelString: state.modelString,
				canonicalName: state.modelString,
				contextWindow: 200_000,
				selectionSource: "test",
			},
			trackUsage: vi.fn(),
			recordAggregateUsage: vi.fn(),
		};
	},
	getCurrentDateContext: () => "Today is October 2, 2026.",
	isStepCount: (n: number) => n,
	selectAggregateUsageForLogging: () => undefined,
	streamText: (request: unknown) => {
		state.captured = request;
		return {
			stream: (async function* () {})(),
			usage: Promise.resolve(undefined),
			steps: Promise.resolve([]),
		};
	},
	tool: (definition: unknown) => definition,
}));
vi.mock("@repo/ai/capabilities", () => ({
	DEFAULT_MODEL_CAPABILITIES: {},
	getModelCapabilities: () => ({}),
}));
vi.mock("@repo/ai/limits", () => ({ classifyLimitError: () => ({}) }));
vi.mock("@repo/ai/skills", () => ({
	buildSkillsSystemBlock: () => "",
	createSkillTools: () => ({
		list_skills: {},
		load_skill: {},
		read_skill_file: {},
	}),
	listAvailableSkills: async () => state.skills,
}));
vi.mock("@repo/database", () => ({
	ensureSensitiveOperationAuthority: vi.fn(),
	getDefaultRagSettings: () => ({ similarityThreshold: 0.5 }),
	getProjectRagSettings: vi.fn(),
	getWorkflowById: vi.fn(),
	listWorkflows: vi.fn(),
	loadProjectDatabricksKnowledgeBinding: async () => null,
}));
vi.mock("../../../lib/company-context-chat-access", () => ({
	resolveCompanyContextChatAccess: state.resolveCompanyContextAccess,
}));
vi.mock("../../../lib/company-context-search", () => ({
	searchCompanyContext: vi.fn(),
}));
vi.mock("../../shared/project-context-block", () => ({
	buildProjectContextBlock: async () => null,
}));
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));
vi.mock("../built-in-tools", () => ({
	createBuiltInTools: async () => state.builtInTools,
}));
vi.mock("../advisor-tools", () => ({
	createAdvisorTools: () => ({ list_recent_sessions: {} }),
}));
vi.mock("../../orchestrator/utils", () => ({ jsonSchemaToZod: vi.fn() }));
vi.mock("../../orchestrator/execution/authority-gate", () => ({
	classifyToolAccessLevel: vi.fn(),
	resolveProviderKey: vi.fn(),
}));
vi.mock("../../shared/agent-tool-runtime", () => ({
	agentToolAbortSignal: () => undefined,
	hasExactAgentToolApproval: vi.fn(),
	observeAgentText: vi.fn(),
	prepareAgentTools: async () => undefined,
	requiredAgentTool: () => undefined,
}));
vi.mock("../../shared/confirmed-workflow", () => ({
	executeApprovedWorkflow: vi.fn(),
}));
vi.mock("../../shared/databricks-knowledge", () => ({
	buildDatabricksKnowledgeToolDefinition: vi.fn(),
	databricksKnowledgeToolName: vi.fn(),
	executeDatabricksKnowledgeSearchSafe: vi.fn(),
	loadAgentDatabricksBindings: async () => [],
	mergeDatabricksBindings: () => [],
}));
vi.mock("../../shared/read-only-gate", () => ({
	guardToolWriteForReadOnly: vi.fn(),
}));

import { executeDirectChatActivity } from "../ai-execution";
import { DIRECT_CHAT_IDENTITY } from "../prompt-cache";

type Captured = {
	instructions: unknown;
	messages: Array<{ role: string; content: unknown }>;
	tools?: Record<string, unknown>;
};

/** The tools the model was given this turn, by name. */
function toolNames(): string[] {
	return Object.keys((state.captured as Captured).tools ?? {}).sort();
}

function contentOf(entry: unknown): string {
	if (typeof entry === "string") {
		return entry;
	}
	if (Array.isArray(entry)) {
		return entry.map(contentOf).join("\n");
	}
	if (entry && typeof entry === "object" && "content" in entry) {
		return contentOf((entry as { content: unknown }).content);
	}
	return "";
}

/** Everything the model is told as system text, whichever shape carries it. */
function systemText(): string {
	const request = state.captured as Captured;
	return [
		contentOf(request.instructions),
		...request.messages
			.filter((message) => message.role === "system")
			.map(contentOf),
	].join("\n");
}

async function runTurn(overrides: Partial<DirectChatWorkflowInput> = {}) {
	state.captured = undefined;
	await executeDirectChatActivity(
		{
			executionId: "exec-1",
			message: "Hello",
			history: [],
			userId: "user-1",
			organizationId: "org-1",
			reasoningMode: "balanced",
			...overrides,
		} as DirectChatWorkflowInput,
		[],
		"",
		"",
	);
	expect(state.captured).toBeDefined();
	return systemText();
}

const PERSONA = "You are Fabric Agent, the workspace's drawer assistant.";

beforeEach(() => {
	state.provider = "OPENAI";
	state.modelString = "gpt-test";
	state.builtInTools = {};
	state.skills = [];
	state.companyContextAccess = null;
	state.resolveCompanyContextAccess.mockReset();
	state.resolveCompanyContextAccess.mockImplementation(
		async () => state.companyContextAccess,
	);
});

describe("direct chat identity wiring", () => {
	// Legacy string shape: any provider that is not a prompt-cache target.
	describe("legacy string shape", () => {
		it("includes the Advisor identity when the caller sends no system prompt", async () => {
			const text = await runTurn({ systemPrompt: undefined });
			expect(typeof (state.captured as Captured).instructions).toBe(
				"string",
			);
			expect(text).toContain(DIRECT_CHAT_IDENTITY);
		});

		it("includes the Advisor identity for a whitespace-only system prompt", async () => {
			const text = await runTurn({ systemPrompt: "  \n\t " });
			expect(text).toContain(DIRECT_CHAT_IDENTITY);
		});

		it("omits the Advisor identity when the caller brings a persona", async () => {
			const text = await runTurn({ systemPrompt: PERSONA });
			expect(text).toContain(PERSONA);
			expect(text).not.toContain(DIRECT_CHAT_IDENTITY);
		});
	});

	// Prompt-cache shapes: ANTHROPIC_DIRECT is a cache target.
	describe.each([
		["adjacent system blocks", "claude-sonnet-4-5", Array.isArray],
		[
			"rolling-history terminal system message",
			"claude-opus-5",
			(instructions: unknown) => !Array.isArray(instructions),
		],
	])("prompt-cache shape: %s", (_name, modelString, shapeIsExpected) => {
		beforeEach(() => {
			state.provider = "ANTHROPIC_DIRECT";
			state.modelString = modelString;
		});

		it("includes the Advisor identity when the caller sends no system prompt", async () => {
			const text = await runTurn({ systemPrompt: undefined });
			expect(
				shapeIsExpected((state.captured as Captured).instructions),
			).toBe(true);
			expect(text).toContain(DIRECT_CHAT_IDENTITY);
		});

		it("includes the Advisor identity for a whitespace-only system prompt", async () => {
			const text = await runTurn({ systemPrompt: " \n " });
			expect(text).toContain(DIRECT_CHAT_IDENTITY);
		});

		it("omits the Advisor identity when the caller brings a persona", async () => {
			const text = await runTurn({ systemPrompt: PERSONA });
			expect(text).toContain(PERSONA);
			expect(text).not.toContain(DIRECT_CHAT_IDENTITY);
		});
	});
});

describe("direct chat web search and skills wiring", () => {
	it("names fabric_web_search, not webSearch, when that is the registered tool", async () => {
		state.builtInTools = { fabric_web_search: {} };
		const text = await runTurn();
		expect(text).toContain("WEB SEARCH GUIDELINES:");
		expect(text).toContain("- Use fabric_web_search for questions");
		expect(text).not.toContain("webSearch");
	});

	it("names webSearch when the default tool is registered", async () => {
		state.builtInTools = { webSearch: {} };
		const text = await runTurn();
		expect(text).toContain("- Use webSearch for questions");
		expect(text).not.toContain("fabric_web_search");
	});

	it("has no web search guidelines when tools are disabled for the turn", async () => {
		state.builtInTools = { webSearch: {} };
		const text = await runTurn({ forceDisableTools: true });
		expect(text).not.toContain("WEB SEARCH GUIDELINES:");
		expect(text).not.toContain("webSearch");
	});

	it("has no web search guidelines when no web search tool is registered", async () => {
		state.builtInTools = {};
		const text = await runTurn();
		expect(text).not.toContain("WEB SEARCH GUIDELINES:");
	});

	it("names list_skills only when the skill tools are registered", async () => {
		state.skills = [{ slug: "example-skill" }];
		expect(await runTurn()).toContain(
			"plus list_workflows and list_skills, and base",
		);

		state.skills = [];
		const withoutSkills = await runTurn();
		expect(withoutSkills).toContain("plus list_workflows, and base");
		expect(withoutSkills).not.toContain("list_skills");
	});

	it("names list_skills nowhere when tools are disabled for the turn", async () => {
		state.skills = [{ slug: "example-skill" }];
		const text = await runTurn({ forceDisableTools: true });
		expect(text).not.toContain("list_skills");
	});
});

describe("direct chat company context wiring", () => {
	const TOOL = "search_company_context";
	const ACCESS = {
		organizationId: "org-1",
		organizationName: "Example Org",
		readySourceCount: 2,
	};
	const HINT = 'This chat works for the organization "Example Org".';

	/** The same turn without the Advisor opt-in: what every turn got before. */
	async function baselineTurn(
		overrides: Partial<DirectChatWorkflowInput> = {},
	) {
		const text = await runTurn(overrides);
		return { text, tools: toolNames() };
	}

	it("offers the search and names the organization to an opted-in member, even with an empty explicit tool list", async () => {
		state.companyContextAccess = ACCESS;

		const text = await runTurn({
			companyContextAdvisor: true,
			enabledFabricToolIds: [],
		});

		expect(toolNames()).toContain(TOOL);
		expect(text).toContain(HINT);
		expect(text).toContain(`can be searched with ${TOOL}`);
		// One line, straight after the Advisor tools' line.
		expect(text).toMatch(
			/Never use workspace document tools for that\.\n- This chat works for the organization "Example Org"\.[^\n]*\n\nDIAGRAMS:/,
		);
		expect(state.resolveCompanyContextAccess).toHaveBeenCalledTimes(1);
		expect(state.resolveCompanyContextAccess).toHaveBeenCalledWith({
			userId: "user-1",
			requestOrganizationId: "org-1",
			projectId: undefined,
		});
	});

	it("offers both to a custom agent chosen in the Advisor, beside its own persona", async () => {
		state.companyContextAccess = ACCESS;

		const text = await runTurn({
			companyContextAdvisor: true,
			instanceId: "instance-1",
			systemPrompt: PERSONA,
			enabledFabricToolIds: [],
		});

		expect(toolNames()).toContain(TOOL);
		expect(text).toContain(PERSONA);
		expect(text).toContain(HINT);
	});

	it("asks about the chat's project, so its organization decides", async () => {
		state.companyContextAccess = ACCESS;

		await runTurn({ companyContextAdvisor: true, projectId: "project-1" });

		expect(state.resolveCompanyContextAccess).toHaveBeenCalledWith({
			userId: "user-1",
			requestOrganizationId: "org-1",
			projectId: "project-1",
		});
	});

	// A project guest, or a member whose organization has the feature off:
	// the resolver lets neither through.
	it.each([
		[
			"a project guest in the host organization",
			{ projectId: "project-1" },
		],
		["an organization with the feature off", {}],
	])("leaves the turn exactly as it was for %s", async (_label, chat) => {
		const before = await baselineTurn(chat);
		state.companyContextAccess = null;

		const text = await runTurn({ ...chat, companyContextAdvisor: true });

		expect(state.resolveCompanyContextAccess).toHaveBeenCalledTimes(1);
		expect(toolNames()).toEqual(before.tools);
		expect(toolNames()).not.toContain(TOOL);
		expect(text).toBe(before.text);
		expect(text).not.toContain("Example Org");
		// The bytes every turn had before company context existed.
		expect(text).toContain(
			"Never use workspace document tools for that.\n\nDIAGRAMS:",
		);
	});

	it("treats an organization with no ready sources as nothing", async () => {
		const before = await baselineTurn();
		state.companyContextAccess = { ...ACCESS, readySourceCount: 0 };

		const text = await runTurn({ companyContextAdvisor: true });

		expect(toolNames()).toEqual(before.tools);
		expect(text).toBe(before.text);
	});

	// Callers that start the same activity without the Advisor's opt-in.
	it.each([
		[
			"a project comment reply",
			{
				projectId: "project-1",
				systemPrompt:
					"You are Fabric Agent replying inside a project comment thread.",
			},
		],
		[
			"the meeting agent",
			{
				featureKey: "parlume",
				usageConversationId: "session-1",
				systemPrompt: PERSONA,
			},
		],
	] as const)(
		"neither offers the search nor names the organization for %s, even for a member",
		async (_label, chat) => {
			state.companyContextAccess = ACCESS;

			const text = await runTurn(
				chat as Partial<DirectChatWorkflowInput>,
			);

			expect(state.resolveCompanyContextAccess).not.toHaveBeenCalled();
			expect(toolNames()).not.toContain(TOOL);
			expect(text).not.toContain("Example Org");
			expect(text).not.toContain(TOOL);
		},
	);

	it("drops both with the tools on the degraded retry, without asking", async () => {
		state.companyContextAccess = ACCESS;

		const text = await runTurn({
			companyContextAdvisor: true,
			forceDisableTools: true,
		});

		expect(state.resolveCompanyContextAccess).not.toHaveBeenCalled();
		expect((state.captured as Captured).tools).toBeUndefined();
		expect(text).not.toContain("Example Org");
		expect(text).not.toContain(TOOL);
	});
});

// Fizzy #2939: only a turn its starter marked plan-eligible may resolve the
// member's own ChatGPT plan. Mention replies, meetings and every other
// starter leave the field unset, and the activity then leaves it unset too:
// outside a run a person started that resolves the organization's provider,
// and inside one the run's marker decides (getAIModelWithMetadata).
describe("direct chat ChatGPT plan eligibility", () => {
	it("does not mark a turn nobody marked eligible", async () => {
		await runTurn();
		expect(
			(state.modelContext as { planEligible?: boolean }).planEligible,
		).toBeUndefined();
	});

	it("lets a turn the Advisor stream marked eligible resolve the plan", async () => {
		await runTurn({ planEligible: true });
		expect(state.modelContext).toMatchObject({ planEligible: true });
	});
});
