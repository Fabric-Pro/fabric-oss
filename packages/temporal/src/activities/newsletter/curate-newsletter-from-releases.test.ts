import type { DeploymentItem } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));

const generateObject = vi.fn();
vi.mock("@repo/ai", () => ({
	generateObject: (...a: unknown[]) => generateObject(...a),
	getAIModelWithMetadata: vi.fn().mockResolvedValue({
		model: {},
		metadata: { taskType: "SIMPLE" },
		trackUsage: vi.fn(),
	}),
	getCurrentDateContext: vi.fn().mockReturnValue("Today is 2026-06-15."),
	logModelUsageAsync: vi.fn(),
}));

const mockIsCurrentOrgMember = vi.fn();
vi.mock("@repo/database", () => ({
	NEWSLETTER_SCHEMA_VERSION: 1,
	isCurrentOrgMember: (...a: unknown[]) => mockIsCurrentOrgMember(...a),
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock the collector module with the REAL omitted-notice value so the strip test
// catches a real-constant regression (use the actual string from
// collect-github-releases.ts:77-78). The literal is inlined inside the factory
// because vi.mock is hoisted above this const — referencing REAL_OMITTED in the
// factory would throw "Cannot access before initialization".
const REAL_OMITTED =
	"_Release notes omitted to keep this brief within size limits — open the release on GitHub._";
vi.mock("../daily-brief/collect-github-releases", () => ({
	RELEASE_NOTES_OMITTED_NOTICE:
		"_Release notes omitted to keep this brief within size limits — open the release on GitHub._",
}));

import {
	buildReleaseNewsletterPrompt,
	curateNewsletterFromReleasesActivity,
	mapHighlightReleaseMeta,
} from "./curate-newsletter-from-releases";

const rel = (over: Partial<DeploymentItem> = {}): DeploymentItem =>
	({
		occurredAt: new Date("2026-06-11T00:00:00Z"),
		title: "v1.3.7",
		repoFullName: "acme/web",
		tagName: "v1.3.7",
		url: "https://x/releases/v1.3.7",
		body: "- New dashboard\n- Faster search",
		...over,
	}) as DeploymentItem;

describe("buildReleaseNewsletterPrompt", () => {
	it("enumerates EVERY release (title+tag) even when bodies are budget-trimmed", () => {
		const many = Array.from({ length: 30 }, (_, i) =>
			rel({
				tagName: `v1.3.${i}`,
				title: `v1.3.${i}`,
				body: "x".repeat(5000),
			}),
		);
		const prompt = buildReleaseNewsletterPrompt("Acme", many);
		for (const r of many) {
			expect(prompt).toContain(`[${r.tagName}]`);
		}
	});

	it("strips the omitted-notice (real value) — never leaks it into the prompt", () => {
		const prompt = buildReleaseNewsletterPrompt("Acme", [
			rel({ body: REAL_OMITTED }),
		]);
		expect(prompt).not.toContain("open the release on GitHub");
		expect(prompt).toContain("[v1.3.7]");
	});

	it("per-repo-FAIR: every repo's newest release contributes a body even past the budget", () => {
		// Exactly PROMPT_RELEASE_LIMIT (50) distinct repos so none are sliced off the
		// prompt — this isolates the fairness guarantee from the cap. Each body is far
		// larger than the per-repo min, and 50 full bodies (~150k) blow the 24k budget,
		// so fairness is genuinely exercised: 50 × PER_REPO_MIN_BODY (400) = 20k ≤ 24k,
		// so EVERY repo's newest must still receive its guaranteed slice.
		const repos = Array.from({ length: 50 }, (_, i) =>
			rel({
				repoFullName: `acme/r${i}`,
				tagName: `v${i}.0.0`,
				title: `v${i}.0.0`,
				body: "y".repeat(3000),
			}),
		);
		const prompt = buildReleaseNewsletterPrompt("Acme", repos);
		// Every repo's newest must have SOME body content (a "y" run on the line after its head).
		for (const r of repos) {
			expect(prompt).toMatch(
				new RegExp(
					`\\[${r.tagName.replace(/\./g, "\\.")}\\][^\\n]*\\ny`,
				),
			);
		}
	});

	it("includes repo attribution + release URL for prUrl", () => {
		const prompt = buildReleaseNewsletterPrompt("Acme", [
			rel({ repoFullName: "acme/web", url: "https://x/web/v1" }),
			rel({
				repoFullName: "acme/api",
				tagName: "v2.0.0",
				title: "v2.0.0",
				url: "https://x/api/v2",
			}),
		]);
		expect(prompt).toContain("acme/web");
		expect(prompt).toContain("acme/api");
		expect(prompt).toContain("https://x/web/v1");
	});

	it("STANDARD (default) still emits the historical include/exclude/tone lines", () => {
		const prompt = buildReleaseNewsletterPrompt("Acme", [rel()]);
		expect(prompt).toContain(
			"Include ONLY major, user-facing feature additions and significant changes.",
		);
		expect(prompt).toContain(
			"EXCLUDE bug fixes, refactors, chores, CI, dependency bumps, tests, and internal/granular work.",
		);
		// Explicit STANDARD arg must equal the defaulted call (no regression).
		expect(buildReleaseNewsletterPrompt("Acme", [rel()], "STANDARD")).toBe(
			prompt,
		);
	});

	it("BRIEF and DETAILED change the prompt observably", () => {
		const std = buildReleaseNewsletterPrompt("Acme", [rel()], "STANDARD");
		const brief = buildReleaseNewsletterPrompt("Acme", [rel()], "BRIEF");
		const detailed = buildReleaseNewsletterPrompt(
			"Acme",
			[rel()],
			"DETAILED",
		);
		expect(brief).not.toBe(std);
		expect(detailed).not.toBe(std);
		expect(brief).toContain("extremely concise");
		expect(detailed).toContain("2-4 sentences");
		// Release enumeration is unchanged regardless of tier.
		expect(brief).toContain("[v1.3.7]");
		expect(detailed).toContain("[v1.3.7]");
	});

	it("starts with the stable instruction text and places the date context after it, not the per-project name (prompt-cache prefix)", () => {
		const prompt = buildReleaseNewsletterPrompt("Acme", [rel()]);

		// The opening sentence must not vary per project — projectName used to
		// be interpolated here, fragmenting the shared cacheable prefix.
		expect(
			prompt.startsWith(
				"You are writing an external-stakeholder release-notes newsletter for a software project.",
			),
		).toBe(true);

		// Index comparison, not just toContain — the date context must land
		// strictly after the stable opening/rules block.
		const dateIndex = prompt.indexOf("Today is 2026-06-15.");
		expect(dateIndex).toBeGreaterThan(0);
		expect(prompt.slice(0, dateIndex)).not.toContain("Acme");
	});
});

describe("curateNewsletterFromReleasesActivity", () => {
	beforeEach(() => {
		generateObject.mockReset();
		mockIsCurrentOrgMember.mockReset();
		mockIsCurrentOrgMember.mockResolvedValue(true);
	});

	it("empty releases → hasMajorFeatures=false, model skipped", async () => {
		const out = await curateNewsletterFromReleasesActivity({
			projectId: "p",
			organizationId: null,
			userId: "u",
			projectName: "Acme",
			releases: [],
		});
		expect(out.content.hasMajorFeatures).toBe(false);
		expect(generateObject).not.toHaveBeenCalled();
	});

	it("maps model output into NewsletterContent (prUrl carries release URL)", async () => {
		generateObject.mockResolvedValue({
			object: {
				headline: "June",
				intro: "Lots shipped.",
				hasMajorFeatures: true,
				highlights: [
					{
						title: "Dashboard",
						description: "New home",
						prUrl: "https://x/releases/v1.3.7",
					},
				],
			},
			usage: { totalTokens: 42 },
		});
		const out = await curateNewsletterFromReleasesActivity({
			projectId: "p",
			organizationId: null,
			userId: "u",
			projectName: "Acme",
			releases: [rel()],
		});
		expect(out.content.schemaVersion).toBe(1);
		expect(out.content.hasMajorFeatures).toBe(true);
		expect(out.content.highlights[0].prUrl).toBe(
			"https://x/releases/v1.3.7",
		);
		expect(out.aiUsageTokens).toBe(42);
	});

	// NON-NEGOTIABLE carry-over from the legacy curate test (TOCTOU actor gate).
	it("skips the model when the org actor is no longer a member", async () => {
		mockIsCurrentOrgMember.mockResolvedValue(false);
		const out = await curateNewsletterFromReleasesActivity({
			projectId: "p",
			organizationId: "org-9",
			userId: "removed-admin",
			projectName: "Acme",
			releases: [rel()],
		});
		expect(mockIsCurrentOrgMember).toHaveBeenCalledWith(
			"removed-admin",
			"org-9",
		);
		expect(generateObject).not.toHaveBeenCalled();
		expect(out.content.hasMajorFeatures).toBe(false);
	});

	it("logs the effective detailLevel and passes it into the prompt", async () => {
		const { logger } = await import("@repo/logs");
		generateObject.mockResolvedValue({
			object: {
				headline: "h",
				intro: "i",
				hasMajorFeatures: true,
				highlights: [],
			},
			usage: { totalTokens: 1 },
		});
		await curateNewsletterFromReleasesActivity({
			projectId: "p",
			organizationId: null,
			userId: "u",
			projectName: "Acme",
			releases: [rel()],
			detailLevel: "DETAILED",
		});
		expect(logger.info).toHaveBeenCalledWith(
			"[Newsletter] curating release notes",
			expect.objectContaining({
				projectId: "p",
				detailLevel: "DETAILED",
			}),
		);
		const promptArg = generateObject.mock.calls[0][0].prompt as string;
		expect(promptArg).toContain("2-4 sentences");
	});
});

it("attaches releaseTag and repoFullName by matching prUrl to a release", () => {
	// buildReleaseNewsletterPrompt is exported; the enrichment logic is exercised
	// via the exported helper mapHighlightReleaseMeta(highlight, releases).
	const releases = [
		{
			id: "1",
			title: "R1",
			repoFullName: "acme/web",
			tagName: "v1.2.0",
			url: "https://github.com/acme/web/releases/tag/v1.2.0",
		},
	] as any;
	const meta = mapHighlightReleaseMeta(
		{
			title: "t",
			description: "d",
			prUrl: "https://github.com/acme/web/releases/tag/v1.2.0",
		},
		releases,
	);
	expect(meta).toEqual({ releaseTag: "v1.2.0", repoFullName: "acme/web" });
});

it("returns empty meta when the highlight URL matches no release", () => {
	const releases = [
		{
			id: "1",
			title: "R1",
			repoFullName: "acme/web",
			tagName: "v1.2.0",
			url: "https://github.com/acme/web/releases/tag/v1.2.0",
		},
	] as any;
	const meta = mapHighlightReleaseMeta(
		{ title: "t", description: "d", prUrl: "https://example.com/unknown" },
		releases,
	);
	expect(meta).toEqual({});
});

it("does not match a release whose URL is a prefix of another tag", () => {
	const releases = [
		{
			id: "1",
			title: "R",
			repoFullName: "acme/web",
			tagName: "v1.2.0",
			url: "https://github.com/acme/web/releases/tag/v1.2.0",
		},
	] as any;
	const meta = mapHighlightReleaseMeta(
		{
			title: "t",
			description: "d",
			prUrl: "https://github.com/acme/web/releases/tag/v1.2",
		},
		releases,
	);
	expect(meta).toEqual({});
});
