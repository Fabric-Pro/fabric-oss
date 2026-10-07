/**
 * Bulk background work never runs on a member's own ChatGPT plan, even with
 * "include background jobs" on (Fizzy #2770); other background jobs, and
 * calls with no job type, keep the phase-1 rule.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	isFeatureEnabled: async () => true,
	getActiveChatGptPlanOrgUse: async () => ({
		includeBackgroundJobs: true,
		credentialStatus: "ACTIVE",
	}),
}));
vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
	OWN_PLAN_BACKGROUND_DENYLIST,
	resolveOwnChatGptPlan,
} from "../lib/chatgpt-plan/routing";

const background = { userId: "user_1", organizationId: "org_a" };

beforeEach(() => {
	vi.clearAllMocks();
});

describe("own-plan background denylist", () => {
	it.each([...OWN_PLAN_BACKGROUND_DENYLIST])(
		"keeps %s off the member's own plan",
		async (jobType) => {
			await expect(
				resolveOwnChatGptPlan({ ...background, jobType }),
			).resolves.toBe("ownDisabled");
		},
	);

	it.each([
		"scheduled-report",
		"daily-brief",
		"publishing-suggestion",
	] as const)(
		"still runs %s on the plan the member included",
		async (jobType) => {
			await expect(
				resolveOwnChatGptPlan({ ...background, jobType }),
			).resolves.toBe("own");
		},
	);

	it("keeps the phase-1 rule for a background call with no job type", async () => {
		await expect(resolveOwnChatGptPlan(background)).resolves.toBe("own");
	});

	it("never blocks the member's own interactive work", async () => {
		await expect(
			resolveOwnChatGptPlan({
				...background,
				planEligible: true,
				jobType: "meeting-transcript-sync",
			}),
		).resolves.toBe("own");
	});

	// The review point: changing what bulk work is kept off members' plans
	// must be a deliberate, reviewed edit.
	it("is exactly the reviewed list", () => {
		expect(OWN_PLAN_BACKGROUND_DENYLIST).toEqual([
			"meeting-transcript-sync",
			"parlume-meeting-notes",
			"newsletter-curation",
			"security-scan",
			"slack-channel-monitor",
			"image-generation",
			"transcription",
		]);
	});
});
