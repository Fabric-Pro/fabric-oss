/**
 * Slice 8 — merged-PR → CodingRun.mergedAt join.
 *
 * Run with: pnpm --filter @repo/temporal test __tests__/stamp-merged-coding-runs.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	db: {
		codingRun: { updateMany: vi.fn() },
	},
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@temporalio/activity", () => ({
	heartbeat: vi.fn(),
}));

import { db } from "@repo/database";
import {
	normalizePullRequestUrl,
	stampMergedCodingRuns,
} from "../src/activities/daily-brief/stamp-merged-coding-runs";

describe("normalizePullRequestUrl", () => {
	it("lower-cases the host, strips trailing slashes, .git, query and hash", () => {
		expect(
			normalizePullRequestUrl("https://GitHub.com/Acme/Portal/pull/12/"),
		).toBe("https://github.com/Acme/Portal/pull/12");
		expect(
			normalizePullRequestUrl(
				"https://github.com/acme/portal/pull/12.git",
			),
		).toBe("https://github.com/acme/portal/pull/12");
		expect(
			normalizePullRequestUrl(
				"https://github.com/acme/portal/pull/12?diff=split#discussion",
			),
		).toBe("https://github.com/acme/portal/pull/12");
	});

	it("keeps the path case (owner/repo names are case-sensitive on some hosts)", () => {
		expect(
			normalizePullRequestUrl("https://github.com/Acme/Portal/pull/1"),
		).toBe("https://github.com/Acme/Portal/pull/1");
	});

	it("falls back to a trimmed string for non-URLs", () => {
		expect(normalizePullRequestUrl("  not-a-url/ ")).toBe("not-a-url");
	});

	it("strips every trailing slash and only trailing ones", () => {
		expect(
			normalizePullRequestUrl("https://github.com/a/b/pull/1///"),
		).toBe("https://github.com/a/b/pull/1");
		expect(normalizePullRequestUrl("https://github.com/")).toBe(
			"https://github.com",
		);
		expect(normalizePullRequestUrl("not-a-url//x///")).toBe("not-a-url//x");
		expect(normalizePullRequestUrl("///")).toBe("");
	});

	it("handles a long interior run of slashes in linear time", () => {
		// `/\/+$/` retried every slash of the run against the end.
		const run = "/".repeat(100_000);
		const started = performance.now();
		expect(normalizePullRequestUrl(`not-a-url${run}x`)).toBe(
			`not-a-url${run}x`,
		);
		expect(normalizePullRequestUrl(`https://github.com/${run}x`)).toBe(
			`https://github.com/${run}x`,
		);
		expect(performance.now() - started).toBeLessThan(500);
	});
});

describe("stampMergedCodingRuns", () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	it("stamps mergedAt only where it is still null, scoped to the project and tenant", async () => {
		vi.mocked(db.codingRun.updateMany).mockResolvedValue({
			count: 2,
		} as never);
		const mergedAt = new Date("2026-09-10T09:00:00Z");

		const out = await stampMergedCodingRuns({
			projectId: "p1",
			organizationId: "org1",
			mergedItems: [
				{
					kind: "pr_merged",
					url: "https://GitHub.com/acme/portal/pull/12/",
					occurredAt: mergedAt,
				},
				// Not a merge — ignored.
				{
					kind: "pr_opened",
					url: "https://github.com/acme/portal/pull/13",
					occurredAt: mergedAt,
				},
			],
		});

		expect(db.codingRun.updateMany).toHaveBeenCalledTimes(1);
		expect(db.codingRun.updateMany).toHaveBeenCalledWith({
			where: {
				projectId: "p1",
				organizationId: "org1",
				mergedAt: null,
				pullRequestUrl: {
					in: expect.arrayContaining([
						"https://github.com/acme/portal/pull/12",
						"https://GitHub.com/acme/portal/pull/12/",
					]),
				},
			},
			data: { mergedAt },
		});
		expect(out).toEqual({ stamped: 2, considered: 1 });
	});

	it("collapses duplicate merge items to the earliest timestamp", async () => {
		vi.mocked(db.codingRun.updateMany).mockResolvedValue({
			count: 1,
		} as never);
		const early = new Date("2026-09-10T09:00:00Z");
		const late = new Date("2026-09-11T09:00:00Z");
		await stampMergedCodingRuns({
			projectId: "p1",
			organizationId: null,
			mergedItems: [
				{
					kind: "pr_merged",
					url: "https://github.com/a/b/pull/1",
					occurredAt: late,
				},
				{
					kind: "pr_merged",
					url: "https://github.com/a/b/pull/1/",
					occurredAt: early,
				},
			],
		});
		expect(db.codingRun.updateMany).toHaveBeenCalledTimes(1);
		expect(
			vi.mocked(db.codingRun.updateMany).mock.calls[0]?.[0],
		).toMatchObject({
			where: { organizationId: null },
			data: { mergedAt: early },
		});
	});

	it("does nothing when no merged items are supplied", async () => {
		const out = await stampMergedCodingRuns({
			projectId: "p1",
			organizationId: null,
			mergedItems: [],
		});
		expect(db.codingRun.updateMany).not.toHaveBeenCalled();
		expect(out).toEqual({ stamped: 0, considered: 0 });
	});
});
