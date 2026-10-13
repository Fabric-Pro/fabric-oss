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
		"living-document-refresh",
		"external-agent",
	] as const)(
		"still runs %s on the plan the member included",
		async (jobType) => {
			await expect(
				resolveOwnChatGptPlan({ ...background, jobType }),
			).resolves.toBe("own");
		},
	);

	// Work the member a call names never asked for runs on a shared account,
	// never on that member's window (2026-10-09). A topic scan someone clicks
	// runs under the project owner's name (Fizzy #2770).
	it.each([
		"fabric-mention",
		"public-api",
		"publishing-suggestion-manual",
	] as const)("keeps %s off the member's own plan", async (jobType) => {
		expect(OWN_PLAN_BACKGROUND_DENYLIST).toContain(jobType);
		await expect(
			resolveOwnChatGptPlan({ ...background, jobType }),
		).resolves.toBe("ownDisabled");
	});

	// Bulk runs a person clicks: one run can drain a personal window
	// (product decision, 2026-10-09).
	it.each([
		"security-scan",
		"batch-document-generation",
		"project-setup",
		"atlas-analysis",
	] as const)(
		"keeps the bulk run %s off the clicker's own plan",
		async (jobType) => {
			await expect(
				resolveOwnChatGptPlan({ ...background, jobType }),
			).resolves.toBe("ownDisabled");
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
			"batch-document-generation",
			"project-setup",
			"atlas-analysis",
			"slack-channel-monitor",
			"teams-channel-monitor",
			"image-generation",
			"transcription",
			"fabric-mention",
			"public-api",
			"publishing-suggestion-manual",
		]);
	});
});
