import { beforeEach, describe, expect, it, vi } from "vitest";

const stubs = vi.hoisted(() => ({
	loadFabricMentionContextActivity: vi.fn(),
	persistFabricMentionReplyActivity: vi.fn(),
	executeChild: vi.fn(),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@temporalio/workflow", () => ({
	proxyActivities: vi.fn(() => ({
		loadFabricMentionContextActivity:
			stubs.loadFabricMentionContextActivity,
		persistFabricMentionReplyActivity:
			stubs.persistFabricMentionReplyActivity,
	})),
	executeChild: stubs.executeChild,
	log: stubs.log,
}));

vi.mock("../direct-chat", () => ({ directChatWorkflow: vi.fn() }));

import { fabricMentionReplyWorkflow } from "../fabric-mention-reply";

const INPUT = {
	workflowId: "fabric-mention-reply-c1",
	targetType: "story" as const,
	targetId: "story_1",
	commentId: "c1",
	userId: "u1",
	organizationId: "org1",
};

const LIMIT_ERROR =
	"AI usage limit exceeded: limit_abc (TOKENS, DAILY) — used 120000 of 100000";

function persistedReply() {
	expect(stubs.persistFabricMentionReplyActivity).toHaveBeenCalledTimes(1);
	return stubs.persistFabricMentionReplyActivity.mock.calls[0][0] as {
		content: string;
		metadata: Record<string, unknown>;
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	stubs.loadFabricMentionContextActivity.mockResolvedValue({
		commentContent: "@fabric what is left?",
		projectId: "p1",
		projectName: "Example project",
		storyIdentifier: "F-1",
		storyTitle: "Example feature",
	});
	stubs.persistFabricMentionReplyActivity.mockResolvedValue({
		id: "reply_1",
	});
});

describe("fabricMentionReplyWorkflow failure replies", () => {
	it("posts a neutral reply for a usage-limit refusal and keeps the counters out of the comment", async () => {
		stubs.executeChild.mockResolvedValue({
			success: false,
			error: LIMIT_ERROR,
			usageLimit: {
				message: LIMIT_ERROR,
				limitId: "limit_abc",
				dimension: "TOKENS",
				window: "DAILY",
				used: "120000",
				max: "100000",
				manageLimitsUrl: "/settings/ai/limits",
			},
		});

		const result = await fabricMentionReplyWorkflow(INPUT);

		const reply = persistedReply();
		expect(reply.content).toBe(
			"I couldn't generate a reply: an AI usage limit was reached.",
		);
		expect(reply.metadata).toMatchObject({
			status: "failed",
			failureReason: "usage_limit",
		});
		expect(reply.metadata).not.toHaveProperty("error");
		const persisted = JSON.stringify(reply);
		expect(persisted).not.toContain("limit_abc");
		expect(persisted).not.toContain("120000");
		expect(result).toMatchObject({ success: false, error: LIMIT_ERROR });
		expect(stubs.log.warn).toHaveBeenCalledWith(
			"Fabric mention reply failed",
			expect.objectContaining({
				error: LIMIT_ERROR,
				usageLimit: expect.objectContaining({ limitId: "limit_abc" }),
			}),
		);
	});

	it("posts a neutral reply for a provider error and keeps its text out of the comment", async () => {
		stubs.executeChild.mockResolvedValue({
			success: false,
			error: "upstream 529: overloaded_error request_id=req_example",
		});

		await fabricMentionReplyWorkflow(INPUT);

		const reply = persistedReply();
		expect(reply.content).toBe(
			"I couldn't generate a reply: Fabric Agent ran into an error.",
		);
		expect(reply.metadata).toMatchObject({
			status: "failed",
			failureReason: "error",
		});
		expect(reply.metadata).not.toHaveProperty("error");
		expect(JSON.stringify(reply)).not.toContain("overloaded_error");
	});

	it("posts a neutral reply when the child succeeds with no text", async () => {
		stubs.executeChild.mockResolvedValue({
			success: true,
			responseText: "",
		});

		const result = await fabricMentionReplyWorkflow(INPUT);

		const reply = persistedReply();
		expect(reply.content).toBe(
			"I couldn't generate a reply: Fabric Agent ran into an error.",
		);
		expect(reply.metadata).toMatchObject({
			status: "failed",
			failureReason: "error",
		});
		expect(result).toMatchObject({
			success: false,
			error: "Fabric Agent did not return a response.",
		});
	});

	it("posts a neutral reply when the child workflow throws", async () => {
		stubs.executeChild.mockRejectedValue(
			new Error("Child workflow failed: internal detail"),
		);

		const result = await fabricMentionReplyWorkflow(INPUT);

		const reply = persistedReply();
		expect(reply.content).toBe(
			"I couldn't generate a reply: Fabric Agent ran into an error.",
		);
		expect(reply.metadata).toMatchObject({
			status: "failed",
			failureReason: "error",
		});
		expect(reply.metadata).not.toHaveProperty("error");
		expect(JSON.stringify(reply)).not.toContain("internal detail");
		expect(result).toMatchObject({
			success: false,
			error: "Child workflow failed: internal detail",
		});
		expect(stubs.log.error).toHaveBeenCalledWith(
			"Fabric mention reply failed",
			expect.objectContaining({
				error: "Child workflow failed: internal detail",
			}),
		);
	});

	it("posts the answer unchanged when the child succeeds", async () => {
		stubs.executeChild.mockResolvedValue({
			success: true,
			responseText: "Two tasks remain.",
		});

		await fabricMentionReplyWorkflow(INPUT);

		expect(persistedReply().content).toBe("Two tasks remain.");
	});
});
