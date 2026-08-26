import type { GithubItem } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";

// heartbeat() throws outside an activity context; the worker provides the real
// one. Mock it (matches the daily-brief activity test convention).
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));

const generateObject = vi.fn();
vi.mock("@repo/ai", () => ({
	generateObject: (...a: unknown[]) => generateObject(...a),
	getAIModelWithMetadata: vi.fn().mockResolvedValue({
		model: {},
		metadata: { taskType: "SIMPLE" },
		trackUsage: vi.fn(),
	}),
	getCurrentDateContext: vi.fn().mockReturnValue("Today is 2026-06-12."),
	logModelUsageAsync: vi.fn(),
}));

const mockIsCurrentOrgMember = vi.fn();
// curate only needs these two runtime exports from @repo/database (GithubItem /
// NewsletterContent are type-only and erased). A minimal explicit mock is more
// deterministic than importActual + spread.
vi.mock("@repo/database", () => ({
	NEWSLETTER_SCHEMA_VERSION: 1,
	isCurrentOrgMember: (...a: unknown[]) => mockIsCurrentOrgMember(...a),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { curateStakeholderReleaseNotesActivity } from "./curate-stakeholder-release-notes";

const pr = (over: Partial<GithubItem> = {}): GithubItem =>
	({
		occurredAt: new Date(),
		title: "feat: dashboard",
		kind: "pr_merged",
		prNumber: 1,
		repoFullName: "acme/web",
		url: "https://x/1",
		baseRef: "production",
		...over,
	}) as GithubItem;

describe("curateStakeholderReleaseNotesActivity", () => {
	beforeEach(() => {
		// Reset generateObject's call history between tests — the "maps output"
		// test calls it, and the TOCTOU-skip test asserts it is NOT called.
		generateObject.mockReset();
		mockIsCurrentOrgMember.mockReset();
		mockIsCurrentOrgMember.mockResolvedValue(true);
	});

	it("returns hasMajorFeatures=false and skips the model when there are no PRs", async () => {
		const out = await curateStakeholderReleaseNotesActivity({
			projectId: "p",
			organizationId: null,
			userId: "u",
			projectName: "Acme",
			prodPrs: [],
		});
		expect(out.content.hasMajorFeatures).toBe(false);
		expect(out.content.highlights).toEqual([]);
		expect(generateObject).not.toHaveBeenCalled();
	});

	it("maps the model output into NewsletterContent", async () => {
		generateObject.mockResolvedValue({
			object: {
				headline: "June Update",
				intro: "Shipped a lot.",
				hasMajorFeatures: true,
				highlights: [
					{
						title: "Dashboard",
						description: "New home",
						prUrl: "https://x/1",
					},
				],
			},
			usage: { totalTokens: 42 },
		});
		const out = await curateStakeholderReleaseNotesActivity({
			projectId: "p",
			organizationId: null,
			userId: "u",
			projectName: "Acme",
			prodPrs: [pr()],
		});
		expect(out.content.schemaVersion).toBe(1);
		expect(out.content.hasMajorFeatures).toBe(true);
		expect(out.content.highlights[0].title).toBe("Dashboard");
		expect(out.aiUsageTokens).toBe(42);
	});

	it("skips the model when the org actor is no longer a member (TOCTOU point-of-use guard)", async () => {
		mockIsCurrentOrgMember.mockResolvedValue(false);
		const out = await curateStakeholderReleaseNotesActivity({
			projectId: "p",
			organizationId: "org-9", // org context → membership is re-checked
			userId: "removed-admin",
			projectName: "Acme",
			prodPrs: [pr()],
		});
		expect(mockIsCurrentOrgMember).toHaveBeenCalledWith(
			"removed-admin",
			"org-9",
		);
		expect(generateObject).not.toHaveBeenCalled();
		expect(out.content.hasMajorFeatures).toBe(false);
		expect(out.content.highlights).toEqual([]);
		expect(out.aiUsageTokens).toBeNull();
	});
});
