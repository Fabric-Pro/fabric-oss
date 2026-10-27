import { AiUsageLimitExceededError } from "@repo/payments/lib/ai-usage-limit-error";
import { RetryError } from "ai";
import { beforeEach, expect, it, vi } from "vitest";

const stubs = vi.hoisted(() => ({
	getAgentDeploymentById: vi.fn(),
	generateText: vi.fn(),
	modelContext: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {},
	hasProjectAccess: vi.fn(),
	isProjectReadOnly: vi.fn(),
	resolveWorkflowIntegrationForProvider: vi.fn(),
	getAgentDeploymentById: stubs.getAgentDeploymentById,
	getBuiltInToolConfig: () => undefined,
	extractEnabledBuiltInToolKeys: () => [],
	mapBuiltInKeysToFabricToolIds: () => [],
}));
vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: async (_options: unknown, context: unknown) => {
		stubs.modelContext(context);
		return {
			model: {},
			metadata: { provider: "example", modelString: "example-model" },
		};
	},
	getCurrentDateContext: () => "Example date context",
}));
vi.mock("ai", async (importOriginal) => ({
	...(await importOriginal<typeof import("ai")>()),
	generateText: stubs.generateText,
}));
vi.mock("@repo/integrations", () => ({ channelRegistry: {} }));
vi.mock("@repo/integrations/slack", () => ({ sendSlackMessage: vi.fn() }));
vi.mock("@repo/utils", () => ({ decryptApiKey: vi.fn() }));
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));
vi.mock("../../agentic-loop/step-cache-breakpoint", () => ({
	makeToolLoopPrepareStep: () => undefined,
}));

import { invokeAgent } from "../index";

const INPUT = {
	agentId: "agent1",
	message: "Please help",
	context: { source: "SLACK_MENTION" },
	userId: "u1",
	organizationId: "org1",
};
const LIMIT = new AiUsageLimitExceededError({
	message:
		"AI usage limit exceeded: limit_abc (TOKENS, DAILY) — used 120000 of 100000",
	limitId: "limit_abc",
	dimension: "TOKENS",
	window: "DAILY",
	used: 120000n,
	max: 100000n,
	manageLimitsUrl: "/settings/ai/limits",
});

beforeEach(() => {
	vi.clearAllMocks();
	stubs.getAgentDeploymentById.mockResolvedValue({
		instance: { name: "Example agent", toolConnections: {}, template: {} },
	});
});

it.each([
	["direct", LIMIT],
	[
		"SDK-wrapped",
		new RetryError({
			message: "Failed after attempts",
			reason: "errorNotRetryable",
			errors: [new Error("transient"), LIMIT],
		}),
	],
])(
	"reports a %s usage-limit refusal as serializable data",
	async (_kind, error) => {
		stubs.generateText.mockRejectedValue(error);
		const result = await invokeAgent(INPUT);
		expect(stubs.generateText).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({
			success: false,
			response: "",
			error: error.message,
			usageLimit: {
				message: LIMIT.message,
				limitId: "limit_abc",
				dimension: "TOKENS",
				window: "DAILY",
				used: "120000",
				max: "100000",
				manageLimitsUrl: "/settings/ai/limits",
			},
		});
		expect(() => JSON.stringify(result)).not.toThrow();
	},
);

it("does not classify a plain model error as a usage-limit refusal", async () => {
	stubs.generateText.mockRejectedValue(new Error("Example provider failure"));
	const result = await invokeAgent(INPUT);
	expect(stubs.generateText).toHaveBeenCalledTimes(1);
	expect(result).toMatchObject({
		success: false,
		error: "Example provider failure",
	});
	expect(result).not.toHaveProperty("usageLimit");
	expect(stubs.modelContext).toHaveBeenCalledWith({
		userId: INPUT.userId,
		organizationId: INPUT.organizationId,
	});
	expect(stubs.modelContext.mock.calls[0][0].callPurpose).toBeUndefined();
});

it("does not classify a missing deployment as a usage-limit refusal", async () => {
	stubs.getAgentDeploymentById.mockResolvedValue(null);
	const result = await invokeAgent(INPUT);
	expect(result).toMatchObject({
		success: false,
		error: "Agent deployment agent1 not found or access denied",
	});
	expect(result).not.toHaveProperty("usageLimit");
	expect(stubs.generateText).not.toHaveBeenCalled();
});
