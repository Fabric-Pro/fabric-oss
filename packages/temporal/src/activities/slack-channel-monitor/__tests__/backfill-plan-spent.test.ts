/**
 * A backfill that runs out of ChatGPT plan must not skip threads (Fizzy #2770).
 *
 * The per-thread analysis gives a thread's claim back when every plan is
 * spent. The backfill used to swallow that like any other per-thread failure,
 * page on, and mark the backfill complete with the newest ts — so every
 * thread the spent plan refused was skipped for good. It now stops at the
 * refusal, reports where the page it was on started, and leaves the backfill
 * incomplete; the workflow resumes it from there after the reset.
 */

import { SubscriptionPlanExhaustedError } from "@repo/agent-types/chatgpt-plan-fetch";
import { beforeEach, describe, expect, it, vi } from "vitest";

const jobMocks = vi.hoisted(() => ({
	jobEnsure: vi.fn(),
	jobStep: vi.fn(),
	jobComplete: vi.fn(),
	jobFail: vi.fn(),
	jobHeartbeat: vi.fn(),
}));

vi.mock("../../lib/job-progress", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual, ...jobMocks };
});

vi.mock("@repo/integrations/slack", () => ({
	getSlackCredentials: vi.fn(async () => ({ accessToken: "xoxb-test" })),
}));

const dbMocks = vi.hoisted(() => ({
	markSlackChannelBackfillComplete: vi.fn(),
	recordSlackChannelFailure: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual, ...dbMocks };
});

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const analyze = vi.hoisted(() => vi.fn());
vi.mock("../analyze-slack-thread", () => ({
	analyzeSlackThreadActivity: analyze,
}));

const heartbeat = vi.hoisted(() => vi.fn());
vi.mock("@temporalio/activity", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		Context: {
			current: () => ({
				info: { heartbeatDetails: undefined },
				heartbeat,
			}),
		},
		heartbeat: vi.fn(),
	};
});

import { backfillSlackChannelActivity } from "../backfill-slack-channel";

const INPUT = {
	projectId: "proj-1",
	linkedChannelId: "chan-1",
	slackTeamId: "T1",
	channelId: "C1",
	channelDisplayName: "general",
	userId: "user-1",
	organizationId: "org-1",
	oldestTs: "1700000000.000000",
};

const root = (ts: string) => ({ ts, text: `message ${ts}` });

// Newest first, as conversations.history returns them.
const PAGES: Record<string, unknown> = {
	first: {
		ok: true,
		messages: [root("1700000300.000000"), root("1700000200.000000")],
		has_more: true,
		response_metadata: { next_cursor: "c2" },
	},
	c2: {
		ok: true,
		messages: [root("1700000150.000000"), root("1700000100.000000")],
		has_more: false,
	},
};

const requests: URLSearchParams[] = [];

beforeEach(() => {
	vi.clearAllMocks();
	requests.length = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url: string, init: { body: string }) => {
			const body = new URLSearchParams(init.body);
			requests.push(body);
			return {
				ok: true,
				status: 200,
				json: async () => PAGES[body.get("cursor") ?? "first"],
			};
		}),
	);
});

const RESET_AT = new Date("2026-10-12T14:05:00.000Z");

function spentOn(threadRootTs: string) {
	analyze.mockImplementation(async (input: { threadRootTs: string }) => {
		if (input.threadRootTs === threadRootTs) {
			throw new SubscriptionPlanExhaustedError(
				"Every ChatGPT plan is spent.",
				RESET_AT,
			);
		}
		return { success: true };
	});
}

async function failureOf(promise: Promise<unknown>) {
	try {
		await promise;
	} catch (error) {
		return error as {
			type?: string;
			nonRetryable?: boolean;
			details?: unknown[];
		};
	}
	throw new Error("expected the backfill to fail");
}

describe("backfillSlackChannelActivity on a spent ChatGPT plan", () => {
	it("stops at the refusal and leaves the backfill incomplete", async () => {
		spentOn("1700000100.000000");

		const failure = await failureOf(
			backfillSlackChannelActivity(INPUT as never),
		);

		// The plan's own type, so the workflow waits for the reset.
		expect(failure.type).toBe("SubscriptionPlanExhaustedError");
		expect(failure.nonRetryable).toBe(true);
		expect(dbMocks.markSlackChannelBackfillComplete).not.toHaveBeenCalled();
		// A wait, not a broken channel.
		expect(dbMocks.recordSlackChannelFailure).not.toHaveBeenCalled();
	});

	it("shows the Job Hub row as waiting for the reset, and the resumed run reopens it", async () => {
		spentOn("1700000100.000000");

		await failureOf(backfillSlackChannelActivity(INPUT as never));

		expect(jobMocks.jobFail).toHaveBeenCalledTimes(1);
		expect(jobMocks.jobFail).toHaveBeenCalledWith(
			"2026-10-12T14:05:00.000Z",
			{ sourceId: "chan-1", errorClass: "ChatGptPlanWait" },
		);
		expect(jobMocks.jobEnsure).toHaveBeenCalledWith(
			expect.objectContaining({
				reopenFailedWithClass: expect.arrayContaining([
					"ChatGptPlanWait",
				]),
			}),
		);
	});

	it("reports the start of the page it was on, with the earlier pages' progress", async () => {
		spentOn("1700000100.000000");

		const failure = await failureOf(
			backfillSlackChannelActivity(INPUT as never),
		);

		expect(failure.details?.[0]).toEqual({
			cursor: "c2",
			oldest: "1700000000.000000",
			maxTs: "1700000300.000000",
			rootsScanned: 2,
			rootsClaimed: 2,
			proposalsCreated: 0,
			rootsSkippedAlreadySeen: 0,
			rootsSkippedFiltered: 0,
		});
	});

	it("resumes from that progress and completes with the newest ts", async () => {
		spentOn("1700000100.000000");
		const failure = await failureOf(
			backfillSlackChannelActivity(INPUT as never),
		);

		analyze.mockReset();
		analyze.mockResolvedValue({ success: true });
		requests.length = 0;

		const result = await backfillSlackChannelActivity({
			...INPUT,
			resumeFrom: failure.details?.[0],
		} as never);

		// Only the page it stopped on is fetched again, by its cursor.
		expect(requests).toHaveLength(1);
		expect(requests[0]?.get("cursor")).toBe("c2");
		expect(requests[0]?.get("oldest")).toBeNull();
		expect(analyze.mock.calls.map(([input]) => input.threadRootTs)).toEqual(
			["1700000150.000000", "1700000100.000000"],
		);
		expect(result).toMatchObject({ rootsScanned: 4, completed: true });
		expect(dbMocks.markSlackChannelBackfillComplete).toHaveBeenCalledWith(
			"chan-1",
			"1700000300.000000",
		);
	});

	it("still swallows any other per-thread failure", async () => {
		analyze.mockImplementation(async (input: { threadRootTs: string }) => {
			if (input.threadRootTs === "1700000100.000000") {
				throw new Error("model returned garbage");
			}
			return { success: true };
		});

		await expect(
			backfillSlackChannelActivity(INPUT as never),
		).resolves.toMatchObject({ rootsScanned: 4 });
		expect(dbMocks.markSlackChannelBackfillComplete).toHaveBeenCalled();
	});
});
