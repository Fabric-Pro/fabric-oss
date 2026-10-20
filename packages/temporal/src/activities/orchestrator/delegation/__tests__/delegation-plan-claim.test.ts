/**
 * A run a person started (a story automation their move fired, a Weave
 * execution) hands its delegated system agent a token that carries the plan
 * claim, so the agent's model calls may use that person's ChatGPT plan too
 * (Fizzy #2770). The claim follows the run's header, which the client
 * interceptor stamps from the start input — this pins the whole chain from
 * the input a starter writes to the claim the agent receives.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	issueAIToken: vi.fn(),
	sendMessageSecure: vi.fn(),
}));

vi.mock("@temporalio/activity", () => ({
	Context: {
		current: () => ({
			heartbeat: () => undefined,
			info: { startToCloseTimeoutMs: 0 },
		}),
	},
}));
vi.mock("@repo/agent-core", () => ({
	A2AClient: class {
		healthCheck = async () => true;
	},
	SecureA2AClient: class {
		sendMessageSecure = mocks.sendMessageSecure;
	},
}));
vi.mock("@repo/ai", () => ({
	DEFAULT_BASE_URLS: {},
	GATEWAY_PROVIDERS: [],
	getAIModelWithMetadata: vi.fn(async () => ({
		metadata: { provider: "OPENAI", modelString: "gpt" },
		trackUsage: () => undefined,
	})),
}));
vi.mock("@repo/ai-token", () => ({ issueAIToken: mocks.issueAIToken }));
vi.mock("@repo/utils/agent-endpoint", () => ({
	agentEndpointRefusal: () => null,
	fetchAgentEndpoint: vi.fn(),
}));
vi.mock("../../utils/partykit-publisher", () => ({
	publishToolStart: vi.fn(async () => undefined),
	publishToolComplete: vi.fn(async () => undefined),
}));
vi.mock("../resolve-endpoint", () => ({
	resolveAgentEndpoint: vi.fn(async () => ({
		agentId: "agent-1",
		name: "spec-writer",
		deploymentUrl: "https://agents.example.com",
		protocol: "a2a",
		skills: [],
		supportsStreaming: false,
		isExternal: false,
	})),
}));

import {
	AiInteractiveActivityInboundInterceptor,
	makeAiInteractiveClientInterceptor,
} from "../../../../lib/ai-interactive-interceptor";
import { delegateToAgent } from "../delegate-to-agent";

/** The headers the client interceptor stamps for a start with these args. */
async function startHeaders(args: unknown[]): Promise<Record<string, unknown>> {
	let headers: Record<string, unknown> = {};
	await makeAiInteractiveClientInterceptor().start?.(
		{ headers: {}, options: { args } } as never,
		(async (input: { headers: Record<string, unknown> }) => {
			headers = input.headers;
			return "run-1";
		}) as never,
	);
	return headers;
}

/** Runs the delegation as an activity of a run started with `startArgs`. */
async function delegateInRunStartedWith(startArgs: Record<string, unknown>) {
	const headers = await startHeaders([startArgs]);
	await new AiInteractiveActivityInboundInterceptor().execute(
		{ headers, args: [] } as never,
		(() =>
			delegateToAgent({
				agentId: "agent-1",
				message: "Run the triage skill",
				userId: "user-1",
				organizationId: "org-1",
			})) as never,
	);
	return mocks.issueAIToken.mock.calls[0]?.[0] as
		| { planEligible?: boolean; userId: string; jobType?: string }
		| undefined;
}

/** The orchestrator input `fireColumnAutomations` starts. */
const STORY_AUTOMATION_START = {
	executionId: "orch-1",
	executionMode: "balanced",
	userId: "user-1",
	organizationId: "org-1",
	message: "Run the triage skill",
	projectId: "project-1",
	userStoryId: "story-1",
};

beforeEach(() => {
	mocks.issueAIToken.mockReset();
	mocks.issueAIToken.mockResolvedValue("token");
	mocks.sendMessageSecure.mockReset();
	// The claim is decided before the send; stop there.
	mocks.sendMessageSecure.mockRejectedValue(new Error("stop after token"));
});

describe("the delegated agent's token in a person-started run", () => {
	it("carries the plan claim when the starter marked the run plan-eligible", async () => {
		const options = await delegateInRunStartedWith({
			...STORY_AUTOMATION_START,
			planEligible: true,
		});
		expect(options).toMatchObject({ userId: "user-1", planEligible: true });
	});

	it("carries none when the starter did not", async () => {
		const options = await delegateInRunStartedWith(STORY_AUTOMATION_START);
		expect(options).toMatchObject({
			userId: "user-1",
			planEligible: false,
		});
	});
});

// Fizzy #2770: an agent delegated inside a job resolves as that job, so its
// exchange may use the organization's shared plans for it.
describe("the delegated agent's token in a job's run", () => {
	it("carries the run's job, and no plan claim", async () => {
		const options = await delegateInRunStartedWith({
			...STORY_AUTOMATION_START,
			jobType: "project-setup",
		});
		expect(options).toMatchObject({
			userId: "user-1",
			planEligible: false,
			jobType: "project-setup",
		});
	});

	it("carries none for a run that is no job", async () => {
		const options = await delegateInRunStartedWith(STORY_AUTOMATION_START);
		expect(options?.jobType).toBeUndefined();
	});
});

describe("delegation usage metadata", () => {
	it("overwrites forged input usage metadata with the explicit origin and retains retrieval project", async () => {
		mocks.sendMessageSecure.mockClear();
		mocks.sendMessageSecure.mockResolvedValue({
			id: "task-example",
			status: "completed",
			artifacts: [],
		});
		await delegateToAgent({
			agentId: "agent-example",
			message: "hello",
			userId: "user-example",
			projectId: "retrieval-project",
			usageOrigin: {
				conversationId: "origin-conversation",
				frameId: "origin-frame",
				projectId: "origin-project",
				featureKey: "chat-agent",
			},
			context: {
				usage_conversation_id: "forged-conversation",
				usage_project_id: "forged-project",
				usage_frame_id: "forged-frame",
				usage_feature_key: "forged-feature",
			},
		});
		const call = mocks.sendMessageSecure.mock.calls[0];
		for (const metadata of [
			call[1].metadata,
			call[3].metadata.orchestratorContext,
		]) {
			expect(metadata).toMatchObject({
				project_id: "retrieval-project",
				usage_project_id: "origin-project",
				usage_conversation_id: "origin-conversation",
				usage_frame_id: "origin-frame",
				usage_feature_key: "chat-agent",
			});
		}
		expect(call[3].metadata).toMatchObject({
			usage_project_id: "origin-project",
			usage_conversation_id: "origin-conversation",
			usage_frame_id: "origin-frame",
			usage_feature_key: "chat-agent",
		});
	});

	it.each(["conversation-example", undefined])(
		"sends only the explicit usage conversation (%s)",
		async (usageConversationId) => {
			mocks.sendMessageSecure.mockClear();
			mocks.sendMessageSecure.mockResolvedValue({
				id: "task-example",
				status: "completed",
				artifacts: [],
			});
			await delegateToAgent({
				agentId: "agent-example",
				message: "hello",
				userId: "user-example",
				usageConversationId,
				context: {
					usage_conversation_id: "untrusted-example",
					thread_id: "thread-example",
				},
			});
			expect(
				mocks.sendMessageSecure.mock.calls[0][3].metadata
					.usage_conversation_id,
			).toBe(usageConversationId);
		},
	);
});

describe("delegated model selection", () => {
	it.each(["claude-haiku-4-5", undefined])(
		"pins system delegation (%s)",
		async (modelOverride) => {
			const { getAIModelWithMetadata } = await import("@repo/ai");
			vi.mocked(getAIModelWithMetadata).mockClear();
			await delegateToAgent({
				agentId: "example-agent",
				userId: "example-user",
				organizationId: "example-org",
				message: "hello",
				modelOverride,
			});
			const options = vi.mocked(getAIModelWithMetadata).mock
				.calls[0]?.[0];
			const token = mocks.issueAIToken.mock.calls[0]?.[0];
			if (modelOverride) {
				expect(options).toHaveProperty("modelOverride", modelOverride);
				expect(token).toHaveProperty("modelOverride", modelOverride);
			} else {
				expect(options).not.toHaveProperty("modelOverride");
				expect(token).not.toHaveProperty("modelOverride");
			}
		},
	);
	it("does not select or mint for external agents", async () => {
		const { resolveAgentEndpoint } = await import("../resolve-endpoint");
		const { getAIModelWithMetadata } = await import("@repo/ai");
		vi.mocked(resolveAgentEndpoint).mockResolvedValueOnce({
			agentId: "example-agent",
			name: "example-agent",
			deploymentUrl: "https://external.example.com",
			protocol: "a2a",
			skills: [],
			supportsStreaming: false,
			isExternal: true,
		});
		vi.mocked(getAIModelWithMetadata).mockClear();
		await delegateToAgent({
			agentId: "example-agent",
			userId: "example-user",
			message: "hello",
			modelOverride: "claude-haiku-4-5",
		});
		expect(getAIModelWithMetadata).not.toHaveBeenCalled();
		expect(mocks.issueAIToken).not.toHaveBeenCalled();
	});
});
