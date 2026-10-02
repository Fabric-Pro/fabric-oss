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
 *
 * Boundaries mocked: the AI SDK (the `streamText` request is captured and a
 * minimal empty stream returned), model resolution, the database, built-in /
 * advisor / skill tool factories and the shared agent-tool runtime.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DirectChatWorkflowInput } from "../../../types";

const state = vi.hoisted(() => ({
	streamText: undefined as undefined | ((req: unknown) => unknown),
	captured: undefined as unknown,
	provider: "OPENAI",
	modelString: "gpt-test",
	builtInTools: {} as Record<string, unknown>,
	skills: [] as Array<{ slug: string }>,
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
	getAIModelWithMetadata: async () => ({
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
	}),
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
	getWorkflowById: vi.fn(),
	listWorkflows: vi.fn(),
	loadProjectDatabricksKnowledgeBinding: vi.fn(),
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
	loadAgentDatabricksBindings: vi.fn(),
	mergeDatabricksBindings: vi.fn(),
}));
vi.mock("../../shared/read-only-gate", () => ({
	guardToolWriteForReadOnly: vi.fn(),
}));

import { executeDirectChatActivity } from "../ai-execution";
import { DIRECT_CHAT_IDENTITY } from "../prompt-cache";

type Captured = {
	instructions: unknown;
	messages: Array<{ role: string; content: unknown }>;
};

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
