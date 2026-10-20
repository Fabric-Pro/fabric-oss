/**
 * The Direct engine's unbacked-completion check.
 *
 * Runs the real `executeDirectChatActivity` (same boundaries mocked as
 * `voice-turn-wiring.test.ts`) with a model that answers "Done ... ran once"
 * and calls no tool. The judge (`checkCompletionClaimActivity`) is stubbed:
 * its own behaviour is pinned in `check-completion-claim.test.ts`. Direct's
 * stream route only appends, so a claim is corrected beneath the reply, in
 * the text the user sees and the history later turns read.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DirectChatWorkflowInput } from "../../../types";

const FALSE_CLAIM =
	"Done — I previously set up the weekly status page. Also ran once immediately.";

const state = vi.hoisted(() => ({
	reply: "",
	check: vi.fn(),
}));

vi.mock("../../orchestrator/execution/check-completion-claim", () => ({
	checkCompletionClaimActivity: state.check,
}));
vi.mock("@repo/agent-core/backend", () => ({
	closeMcpClientSafe: vi.fn(),
	getMcpClient: vi.fn(),
}));
vi.mock("@repo/ai", () => ({
	convertToModelMessages: async (
		messages: Array<{ role: string; parts: Array<{ text: string }> }>,
	) =>
		messages.map((m) => ({
			role: m.role,
			content: m.parts.map((p) => p.text).join(""),
		})),
	enhancePromptWithFabric: async () => ({ fabricUsed: false }),
	getAIModelWithMetadata: async () => ({
		model: { id: "test-model" },
		metadata: {
			provider: "VERCEL_GATEWAY",
			modelString: "openai/gpt-6-luna",
			canonicalName: "openai/gpt-6-luna",
			contextWindow: 200_000,
			selectionSource: "test",
		},
		trackUsage: vi.fn(),
		recordAggregateUsage: vi.fn(),
	}),
	getCurrentDateContext: () => "Today is October 16, 2026.",
	isStepCount: (n: number) => n,
	selectAggregateUsageForLogging: () => undefined,
	streamText: () => ({
		stream: (async function* () {
			yield { type: "text-delta", text: state.reply };
		})(),
		usage: Promise.resolve({
			inputTokens: 900,
			outputTokens: 40,
			totalTokens: 940,
		}),
		steps: Promise.resolve([]),
	}),
	tool: (definition: unknown) => definition,
}));
vi.mock("@repo/ai/capabilities", () => ({
	DEFAULT_MODEL_CAPABILITIES: {},
	getModelCapabilities: () => ({}),
}));
vi.mock("@repo/ai/limits", () => ({ classifyLimitError: () => ({}) }));
vi.mock("@repo/ai/skills", () => ({
	buildSkillsSystemBlock: () => "",
	createSkillTools: () => ({}),
	listAvailableSkills: async () => [],
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
	resolveCompanyContextChatAccess: async () => null,
}));
vi.mock("../../../lib/company-context-search", () => ({
	searchCompanyContext: vi.fn(),
}));
vi.mock("../../shared/project-context-block", () => ({
	buildProjectContextBlock: async () => null,
}));
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));
vi.mock("../built-in-tools", () => ({ createBuiltInTools: async () => ({}) }));
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
import {
	UNBACKED_CLAIM_NOTICE,
	withUnbackedClaimNotice,
} from "../completion-claim-notice";

const REQUEST =
	"Every Monday, publish a status page here. Run it once now too.";

async function runTurn(overrides: Partial<DirectChatWorkflowInput> = {}) {
	return executeDirectChatActivity(
		{
			executionId: "exec-1",
			message: REQUEST,
			history: [],
			userId: "user-1",
			organizationId: "org-1",
			projectId: "project-1",
			reasoningMode: "balanced",
			...overrides,
		} as DirectChatWorkflowInput,
		[],
		"",
		"",
	);
}

beforeEach(() => {
	state.reply = FALSE_CLAIM;
	state.check.mockReset();
	state.check.mockResolvedValue({
		unbackedClaim: true,
		correction: "unused on Direct",
		judgedBy: "decision",
		usage: { inputTokens: 300, outputTokens: 1 },
	});
});

describe("direct chat: a reply claiming an action with no tool call", () => {
	it("ends with the notice that nothing was done", async () => {
		const result = await runTurn();

		expect(result.responseText).toBe(
			`${FALSE_CLAIM}\n\n${UNBACKED_CLAIM_NOTICE}`,
		);
		expect(state.check).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				organizationId: "org-1",
				projectId: "project-1",
				userRequest: REQUEST,
				reply: FALSE_CLAIM,
			}),
		);
	});

	it("is left as it is when the judge finds no claim", async () => {
		state.check.mockResolvedValue({
			unbackedClaim: false,
			judgedBy: "decision",
			usage: { inputTokens: 300, outputTokens: 1 },
		});

		const result = await runTurn();

		expect(result.responseText).toBe(FALSE_CLAIM);
	});

	it("is not checked on a spoken turn, where the notice would be read aloud", async () => {
		const result = await runTurn({ featureKey: "parlume" });

		expect(result.responseText).toBe(FALSE_CLAIM);
		expect(state.check).not.toHaveBeenCalled();
	});

	it("is not checked when tools were switched off for the turn", async () => {
		const result = await runTurn({ forceDisableTools: true });

		expect(result.responseText).toBe(FALSE_CLAIM);
		expect(state.check).not.toHaveBeenCalled();
	});
});

describe("withUnbackedClaimNotice", () => {
	const base = {
		reply: FALSE_CLAIM,
		userRequest: REQUEST,
		toolCallCount: 0,
		toolsEnabled: true,
		voiceTurn: false,
		userId: "user-1",
	};

	it("does not ask about a reply whose turn called a tool", async () => {
		await expect(
			withUnbackedClaimNotice({ ...base, toolCallCount: 1 }),
		).resolves.toBe(FALSE_CLAIM);
		expect(state.check).not.toHaveBeenCalled();
	});

	it("keeps the reply, and the turn, when the check cannot run", async () => {
		state.check.mockRejectedValue(new Error("judge unavailable"));

		await expect(withUnbackedClaimNotice(base)).resolves.toBe(FALSE_CLAIM);
	});

	it("does not ask about an empty reply", async () => {
		await expect(
			withUnbackedClaimNotice({ ...base, reply: " " }),
		).resolves.toBe(" ");
		expect(state.check).not.toHaveBeenCalled();
	});
});
