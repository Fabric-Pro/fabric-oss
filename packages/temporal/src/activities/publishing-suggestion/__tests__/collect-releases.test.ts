import { beforeEach, describe, expect, it, vi } from "vitest";

// Bare unit test: Context.current() throws "Activity context not initialized"
// outside a real Temporal activity execution, so collectReleases's
// `Context.current().heartbeat()` needs Context mocked (mirrors
// collect-stories.test.ts / fetch-ado-states-heartbeat.test.ts).
vi.mock("@temporalio/activity", () => ({
	Context: { current: () => ({ heartbeat: vi.fn() }) },
}));

// vi.mock factories are hoisted above all other top-level code, so the mock's
// backing fn must be created via vi.hoisted (see collect-stories.test.ts).
const { collectGitHubReleasesActivityMock } = vi.hoisted(() => ({
	collectGitHubReleasesActivityMock: vi.fn(),
}));

vi.mock("../../daily-brief/collect-github-releases", () => ({
	collectGitHubReleasesActivity: collectGitHubReleasesActivityMock,
}));

import {
	collectReleases,
	RELEASE_MAX_FAILURE_REASON_CHARS,
	RELEASE_MAX_FAILURES,
} from "../collect-releases";

const WINDOW_START = "2026-07-01T00:00:00.000Z";
const WINDOW_END = "2026-07-08T00:00:00.000Z";
const IN_WINDOW = new Date("2026-07-04T12:00:00.000Z");

function baseInput() {
	return {
		projectId: "proj-a",
		organizationId: "org-a",
		userId: "user-a",
		windowStart: WINDOW_START,
		windowEnd: WINDOW_END,
	};
}

function releaseItem(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		repoFullName: "acme/repo",
		tagName: "v1.0.0",
		url: "https://github.com/acme/repo/releases/tag/v1.0.0",
		occurredAt: IN_WINDOW,
		title: "v1.0.0",
		...overrides,
	};
}

beforeEach(() => {
	collectGitHubReleasesActivityMock.mockReset();
	collectGitHubReleasesActivityMock.mockResolvedValue({
		items: [],
		failures: [],
	});
});

describe("collectReleases", () => {
	// F6: a mass provider failure (one failure per repo) must not push the
	// activity return past Temporal's ~4MB gRPC limit — bound the array length
	// and each reason string, and treat truncation as source incompleteness.
	it("bounds an oversized failures[] array to RELEASE_MAX_FAILURES entries with reasons capped at RELEASE_MAX_FAILURE_REASON_CHARS, and sets capExhausted", async () => {
		const hugeReason = "x".repeat(RELEASE_MAX_FAILURE_REASON_CHARS * 3);
		const failures = Array.from(
			{ length: RELEASE_MAX_FAILURES + 25 },
			(_, i) => ({
				repoFullName: `acme/repo-${i}`,
				reason: hugeReason,
			}),
		);
		collectGitHubReleasesActivityMock.mockResolvedValue({
			items: [],
			failures,
		});

		const result = await collectReleases(baseInput());

		expect(result.failures.length).toBeLessThanOrEqual(
			RELEASE_MAX_FAILURES,
		);
		for (const f of result.failures) {
			expect(f.reason.length).toBeLessThanOrEqual(
				RELEASE_MAX_FAILURE_REASON_CHARS,
			);
		}
		expect(result.capExhausted).toBe(true);
	});

	it("preserves the other failure fields (repoFullName) and truncates only reason", async () => {
		collectGitHubReleasesActivityMock.mockResolvedValue({
			items: [],
			failures: [
				{
					repoFullName: "acme/repo-1",
					reason: "x".repeat(RELEASE_MAX_FAILURE_REASON_CHARS + 100),
				},
			],
		});

		const result = await collectReleases(baseInput());

		expect(result.failures).toHaveLength(1);
		expect(result.failures[0]?.repoFullName).toBe("acme/repo-1");
		expect(result.failures[0]?.reason).toHaveLength(
			RELEASE_MAX_FAILURE_REASON_CHARS,
		);
	});

	it("leaves a small failures[] array unchanged and does not set capExhausted from failures", async () => {
		collectGitHubReleasesActivityMock.mockResolvedValue({
			items: [],
			failures: [{ repoFullName: "acme/repo-1", reason: "auth expired" }],
		});

		const result = await collectReleases(baseInput());

		expect(result.failures).toEqual([
			{ repoFullName: "acme/repo-1", reason: "auth expired" },
		]);
		expect(result.capExhausted).toBe(false);
	});

	it("returns items + count for the base case, unaffected by the failures bound", async () => {
		collectGitHubReleasesActivityMock.mockResolvedValue({
			items: [
				releaseItem({ tagName: "v1.0.0" }),
				releaseItem({ tagName: "v1.0.1" }),
			],
			failures: [],
		});

		const result = await collectReleases(baseInput());

		expect(result.count).toBe(2);
		expect(result.qualifyingCount).toBe(2);
		expect(result.capExhausted).toBe(false);
	});

	// Pre-existing guard (unrelated to F6) — fail closed without calling
	// through when userId is null. Kept as a sanity check that the failures
	// bound doesn't interfere with that path.
	it("fails closed with empty failures when userId is null", async () => {
		const result = await collectReleases({
			...baseInput(),
			userId: null,
		});

		expect(result.failures).toEqual([]);
		expect(result.capExhausted).toBe(false);
		expect(collectGitHubReleasesActivityMock).not.toHaveBeenCalled();
	});
});
