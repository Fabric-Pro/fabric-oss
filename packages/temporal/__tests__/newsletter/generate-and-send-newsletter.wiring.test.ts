import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DeploymentItem } from "@repo/database";
import { describe, expect, it, vi } from "vitest";
import { selectNewsletterReleases } from "../../src/workflows/newsletter-release-select";

const SRC = readFileSync(
	join(__dirname, "../../src/workflows/generate-and-send-newsletter.ts"),
	"utf8",
);

describe("generate-and-send-newsletter wiring (static scan)", () => {
	it("gates the release-based path behind the patch marker and the new activities", () => {
		expect(SRC).toContain(
			'patched("newsletter-release-based-collection-2026-06-15")',
		);
		expect(SRC).toContain("collectGitHubReleasesActivity(");
		expect(SRC).toContain("selectNewsletterReleases(");
		expect(SRC).toContain("curateNewsletterFromReleasesActivity(");
	});
	it("keeps the legacy branch (replay) and the unchanged advance condition", () => {
		expect(SRC).toContain("collectGitHubPullRequestsActivity(");
		expect(SRC).toContain("splitReleasePrs(");
		expect(SRC).toContain("advanceLastSentAt: sentCount > 0");
	});
	it("never reads the window-independent latestRelease fields (leak guard, spec §3/§9)", () => {
		expect(SRC).not.toContain("latestRelease");
		expect(SRC).not.toContain("latestReleasesByRepo");
	});
	it("does NOT import the collector module into the workflow sandbox", () => {
		expect(SRC).not.toContain("daily-brief/collect-github-releases");
	});
	it("passes a precise skipReason at each skip point and adds only the expected patches", () => {
		expect(SRC).toContain('skipReason: "INCOMPLETE_SCAN"');
		expect(SRC).toContain('skipReason: "NO_SUBSCRIBERS"');
		expect(SRC).toContain("skipReason: noContentReason");
		// Replay safety: exactly FIVE real patch CALLS with id strings exist (the
		// release-based collection marker + the destination-aware delivery marker +
		// the Fizzy 1869 approval-gate marker + the Fizzy 2172 reviewer-email
		// marker + the Fizzy 2203 reviewer-chat marker) — no OTHER patch id was
		// introduced. Matches only `patched("…")`/`patched('…')`, never the
		// `patched()` mentions in surrounding comments, so the count tracks
		// calls, not prose.
		const patchCalls = SRC.match(/patched\(\s*["']/g) ?? [];
		expect(patchCalls.length).toBe(5);
		expect(SRC).toContain(
			'patched("newsletter-release-based-collection-2026-06-15")',
		);
		expect(SRC).toContain('patched("newsletter-chat-delivery-2026-07-08")');
		expect(SRC).toContain('patched("newsletter-approval-gate-2026-07-09")');
		expect(SRC).toContain(
			'patched("newsletter-approval-email-2026-08-10")',
		);
		expect(SRC).toContain('patched("newsletter-approval-chat-2026-08-20")');
	});
});

// Mirror of the NEW-branch post-collection decision. Kept in sync with the
// workflow body (caught on review); uses the REAL selectNewsletterReleases.
const rel = (over: Partial<DeploymentItem> = {}): DeploymentItem =>
	({
		occurredAt: new Date("2026-06-11T00:00:00Z"),
		title: "v1.3.7",
		repoFullName: "a/b",
		tagName: "v1.3.7",
		url: "u",
		body: "x",
		...over,
	}) as DeploymentItem;

interface Deps {
	collect: () => Promise<{
		items: DeploymentItem[];
		failures: { repoFullName: string; reason: string }[];
		activeRepoCount?: number;
	}>;
	curate: (r: DeploymentItem[]) => Promise<{
		content: { hasMajorFeatures: boolean };
		aiUsageTokens: number | null;
	}>;
	loadSubs: () => Promise<{ subscribers: unknown[] }>;
	sendEmails: () => Promise<{ sentCount: number; failedCount: number }>;
	finalize: (a: {
		status: string;
		skipReason?: string;
		advanceLastSentAt?: boolean;
	}) => Promise<void>;
	windowStart: string;
}
async function runNewBranchMirror(d: Deps) {
	const collected = await d.collect();
	const sel = selectNewsletterReleases(
		{ items: collected.items, failures: collected.failures },
		d.windowStart,
	);
	if (sel.incomplete) {
		await d.finalize({
			status: "SKIPPED_EMPTY",
			skipReason: "INCOMPLETE_SCAN",
		});
		return { status: "SKIPPED_EMPTY", sentCount: 0 };
	}
	let noContentReason = "NO_MAJOR_FEATURES";
	if (sel.releases.length === 0) {
		// STRICT === 0 (not ?? 0): a MISSING activeRepoCount (pre-change in-flight
		// collector result on replay, or the tenant-mismatch path) must NOT be
		// coerced to 0 → it falls through to the neutral NO_RELEASES, never a false
		// NO_ACTIVE_REPOS. (Codex findings 1 & 2.)
		noContentReason =
			collected.activeRepoCount === 0 ? "NO_ACTIVE_REPOS" : "NO_RELEASES";
	}
	const { content } = await d.curate(sel.releases);
	if (!content.hasMajorFeatures) {
		await d.finalize({
			status: "SKIPPED_EMPTY",
			skipReason: noContentReason,
		});
		return { status: "SKIPPED_EMPTY", sentCount: 0 };
	}
	const { subscribers } = await d.loadSubs();
	if (subscribers.length === 0) {
		await d.finalize({
			status: "SKIPPED_EMPTY",
			skipReason: "NO_SUBSCRIBERS",
		});
		return { status: "SKIPPED_EMPTY", sentCount: 0 };
	}
	const { sentCount, failedCount } = await d.sendEmails();
	const status =
		failedCount === 0 ? "SENT" : sentCount > 0 ? "PARTIAL" : "FAILED";
	await d.finalize({ status, advanceLastSentAt: sentCount > 0 });
	return { status, sentCount };
}

describe("new-branch decision (mirror)", () => {
	const base = (over: Partial<Deps> = {}): Deps => ({
		collect: vi.fn().mockResolvedValue({
			items: [rel()],
			failures: [],
			activeRepoCount: 1,
		}),
		curate: vi.fn().mockResolvedValue({
			content: { hasMajorFeatures: true },
			aiUsageTokens: 1,
		}),
		loadSubs: vi.fn().mockResolvedValue({ subscribers: [{}] }),
		sendEmails: vi.fn().mockResolvedValue({ sentCount: 1, failedCount: 0 }),
		finalize: vi.fn().mockResolvedValue(undefined),
		windowStart: "2026-06-01T00:00:00Z",
		...over,
	});

	it("incomplete scan → SKIPPED_EMPTY, curate NOT called, no advance", async () => {
		const curate = vi.fn();
		const finalize = vi.fn().mockResolvedValue(undefined);
		const out = await runNewBranchMirror(
			base({
				collect: vi.fn().mockResolvedValue({
					items: [rel()],
					failures: [
						{
							repoFullName: "a/b",
							reason: "Release list truncated at 500",
						},
					],
					activeRepoCount: 1,
				}),
				curate,
				finalize,
			}),
		);
		expect(out.status).toBe("SKIPPED_EMPTY");
		expect(curate).not.toHaveBeenCalled();
		expect(finalize).toHaveBeenCalledWith(
			expect.not.objectContaining({ advanceLastSentAt: true }),
		);
	});

	it("complete + major feature + subscriber + sent → SENT, advanceLastSentAt true", async () => {
		const finalize = vi.fn().mockResolvedValue(undefined);
		const out = await runNewBranchMirror(base({ finalize }));
		expect(out.status).toBe("SENT");
		expect(finalize).toHaveBeenCalledWith(
			expect.objectContaining({
				status: "SENT",
				advanceLastSentAt: true,
			}),
		);
	});

	it("complete but no major features → SKIPPED_EMPTY", async () => {
		const out = await runNewBranchMirror(
			base({
				curate: vi.fn().mockResolvedValue({
					content: { hasMajorFeatures: false },
					aiUsageTokens: null,
				}),
			}),
		);
		expect(out.status).toBe("SKIPPED_EMPTY");
	});

	it("incomplete → skipReason INCOMPLETE_SCAN", async () => {
		const finalize = vi.fn().mockResolvedValue(undefined);
		await runNewBranchMirror(
			base({
				collect: vi.fn().mockResolvedValue({
					items: [rel()],
					failures: [
						{
							repoFullName: "a/b",
							reason: "Release list truncated at 500",
						},
					],
					activeRepoCount: 1,
				}),
				curate: vi.fn(),
				finalize,
			}),
		);
		expect(finalize).toHaveBeenCalledWith(
			expect.objectContaining({ skipReason: "INCOMPLETE_SCAN" }),
		);
	});

	it("no releases + 0 active repos → skipReason NO_ACTIVE_REPOS", async () => {
		const finalize = vi.fn().mockResolvedValue(undefined);
		await runNewBranchMirror(
			base({
				collect: vi.fn().mockResolvedValue({
					items: [],
					failures: [],
					activeRepoCount: 0,
				}),
				curate: vi.fn().mockResolvedValue({
					content: { hasMajorFeatures: false },
					aiUsageTokens: null,
				}),
				finalize,
			}),
		);
		expect(finalize).toHaveBeenCalledWith(
			expect.objectContaining({ skipReason: "NO_ACTIVE_REPOS" }),
		);
	});

	it("no releases + active repos present → skipReason NO_RELEASES", async () => {
		const finalize = vi.fn().mockResolvedValue(undefined);
		await runNewBranchMirror(
			base({
				collect: vi.fn().mockResolvedValue({
					items: [],
					failures: [],
					activeRepoCount: 2,
				}),
				curate: vi.fn().mockResolvedValue({
					content: { hasMajorFeatures: false },
					aiUsageTokens: null,
				}),
				finalize,
			}),
		);
		expect(finalize).toHaveBeenCalledWith(
			expect.objectContaining({ skipReason: "NO_RELEASES" }),
		);
	});

	it("no releases + MISSING activeRepoCount (pre-change replay / tenant-mismatch) → NO_RELEASES, never NO_ACTIVE_REPOS", async () => {
		const finalize = vi.fn().mockResolvedValue(undefined);
		await runNewBranchMirror(
			base({
				// Pre-change collector result: NO activeRepoCount field present.
				collect: vi.fn().mockResolvedValue({ items: [], failures: [] }),
				curate: vi.fn().mockResolvedValue({
					content: { hasMajorFeatures: false },
					aiUsageTokens: null,
				}),
				finalize,
			}),
		);
		expect(finalize).toHaveBeenCalledWith(
			expect.objectContaining({ skipReason: "NO_RELEASES" }),
		);
		expect(finalize).not.toHaveBeenCalledWith(
			expect.objectContaining({ skipReason: "NO_ACTIVE_REPOS" }),
		);
	});

	it("releases present but no major features → skipReason NO_MAJOR_FEATURES", async () => {
		const finalize = vi.fn().mockResolvedValue(undefined);
		await runNewBranchMirror(
			base({
				collect: vi.fn().mockResolvedValue({
					items: [rel()],
					failures: [],
					activeRepoCount: 1,
				}),
				curate: vi.fn().mockResolvedValue({
					content: { hasMajorFeatures: false },
					aiUsageTokens: null,
				}),
				finalize,
			}),
		);
		expect(finalize).toHaveBeenCalledWith(
			expect.objectContaining({ skipReason: "NO_MAJOR_FEATURES" }),
		);
	});

	it("major features but no subscribers → skipReason NO_SUBSCRIBERS", async () => {
		const finalize = vi.fn().mockResolvedValue(undefined);
		await runNewBranchMirror(
			base({
				loadSubs: vi.fn().mockResolvedValue({ subscribers: [] }),
				finalize,
			}),
		);
		expect(finalize).toHaveBeenCalledWith(
			expect.objectContaining({ skipReason: "NO_SUBSCRIBERS" }),
		);
	});
});
