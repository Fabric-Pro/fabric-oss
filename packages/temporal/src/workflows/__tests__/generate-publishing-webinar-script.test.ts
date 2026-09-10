import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Pins the two properties the brief called out as deliberate for this
 * workflow (Fizzy #1988, Phase 2D-1) that no discovery guard sees: the
 * failure marker's own 30s proxy, separate from generation's 480s one, and
 * that a marker rejection still resolves rather than throwing. Everything
 * else about this workflow's shape — registration, the AI retry policy, the
 * failure-mapping call — is covered by the guards it was added to; this file
 * exists only for what those cannot see.
 */

const activityStubs = vi.hoisted(() => ({
	generateWebinarScriptActivity: vi.fn(),
	markWebinarScriptFailedActivity: vi.fn(),
}));

const proxyActivities = vi.hoisted(() =>
	vi.fn((_options: Record<string, unknown>) => activityStubs),
);

const log = vi.hoisted(() => ({
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
}));

vi.mock("@temporalio/workflow", () => ({ proxyActivities, log }));

import { generatePublishingWebinarScriptWorkflow } from "../generate-publishing-webinar-script";

const INPUT = {
	draftId: "d1",
	topicId: "topic_1",
	projectId: "p1",
	organizationId: "org1",
	actorUserId: "u1",
	guidance: null,
};

beforeEach(() => {
	activityStubs.generateWebinarScriptActivity.mockReset();
	activityStubs.markWebinarScriptFailedActivity.mockReset();
	activityStubs.markWebinarScriptFailedActivity.mockResolvedValue(undefined);
});

describe("generatePublishingWebinarScriptWorkflow", () => {
	it("gives the failure marker its OWN short-timeout proxy", () => {
		// Two `proxyActivities` bags, not one. A failure marker inheriting the
		// 480s generation timeout leaves a failing run sitting on GENERATING
		// for another eight minutes, holding the partial unique index against
		// every retry — exactly the state this workflow exists to avoid.
		const bags = proxyActivities.mock.calls.map((call) => call[0]);
		expect(bags).toHaveLength(2);

		const generation = bags[0];
		expect(generation.startToCloseTimeout).toBe("480s");
		expect(generation.heartbeatTimeout).toBe("2 minutes");
		expect(generation.retry).toMatchObject({ maximumAttempts: 3 });

		const marker = bags[1];
		expect(marker.startToCloseTimeout).toBe("30s");
		expect(marker.heartbeatTimeout).toBeUndefined();
	});

	it("still does not throw when the failure marker ITSELF fails", async () => {
		// Nobody awaits this workflow, so throwing here would be invisible and
		// would record the failure twice.
		activityStubs.generateWebinarScriptActivity.mockRejectedValue(
			new Error("provider timed out"),
		);
		activityStubs.markWebinarScriptFailedActivity.mockRejectedValue(
			new Error("database unreachable"),
		);

		const result = await generatePublishingWebinarScriptWorkflow(INPUT);

		expect(result).toEqual({ status: "FAILED", seededWorkingDraft: false });
	});
});
