import type { DeploymentItem } from "@repo/database";
import { describe, expect, it } from "vitest";
import {
	formatIncompleteScanReason,
	PRODUCTION_TAG_PATTERN,
	selectNewsletterReleases,
} from "./newsletter-release-select";

const rel = (over: Partial<DeploymentItem> = {}): DeploymentItem =>
	({
		occurredAt: new Date("2026-06-11T00:00:00.000Z"),
		title: "v1.3.7",
		repoFullName: "acme/web",
		tagName: "v1.3.7",
		url: "https://x/releases/v1.3.7",
		...over,
	}) as DeploymentItem;

const start = "2026-06-01T00:00:00.000Z";
const startMs = new Date(start).getTime();

describe("PRODUCTION_TAG_PATTERN", () => {
	it("accepts v-version tags; rejects prereleases, builds, and non-release tags", () => {
		expect(PRODUCTION_TAG_PATTERN.test("v1.3.7")).toBe(true);
		expect(PRODUCTION_TAG_PATTERN.test("v1")).toBe(true);
		// Prerelease/build MUST be rejected — ADO annotated tags have no prerelease
		// flag for the collector to filter, so the tag pattern is the only gate.
		expect(PRODUCTION_TAG_PATTERN.test("v2.0.0-beta")).toBe(false);
		expect(PRODUCTION_TAG_PATTERN.test("v1.4.0-rc1")).toBe(false);
		expect(PRODUCTION_TAG_PATTERN.test("v1.3.7+build.5")).toBe(false);
		expect(PRODUCTION_TAG_PATTERN.test("staging-5")).toBe(false);
		expect(PRODUCTION_TAG_PATTERN.test("sprint-12")).toBe(false);
		expect(PRODUCTION_TAG_PATTERN.test("release")).toBe(false);
		expect(PRODUCTION_TAG_PATTERN.test("1.3.7")).toBe(false);
	});
});

describe("selectNewsletterReleases", () => {
	it("keeps only v* tags published strictly after windowStart (start-exclusive, both sides)", () => {
		const out = selectNewsletterReleases(
			{
				items: [
					rel({
						tagName: "v1.3.7",
						occurredAt: new Date(startMs + 1),
					}), // start+1ms → IN
					rel({ tagName: "v1.3.6", occurredAt: new Date(startMs) }), // == start → OUT
					rel({
						tagName: "staging-9",
						occurredAt: new Date("2026-06-10T00:00:00Z"),
					}), // non-v* → OUT
					rel({
						tagName: "v1.2.0",
						occurredAt: new Date("2026-05-01T00:00:00Z"),
					}), // before → OUT
				],
				failures: [],
			},
			start,
		);
		expect(out.releases.map((r) => r.tagName)).toEqual(["v1.3.7"]);
		expect(out.incomplete).toBe(false);
	});

	it("incomplete=true ONLY for completeness-affecting failures", () => {
		const real = (reason: string) =>
			selectNewsletterReleases(
				{
					items: [rel()],
					failures: [{ repoFullName: "acme/web", reason }],
				},
				start,
			).incomplete;
		// completeness-affecting → true
		expect(
			real(
				"Release list truncated before it reached the window start; some older in-window releases may be missing",
			),
		).toBe(true);
		expect(
			real(
				"Deployments list truncated to 50 most recent; 3 older in-window release(s) omitted",
			),
		).toBe(true);
		expect(real("Release tag scan incomplete")).toBe(true); // ADO fail-closed
		expect(real("HTTP 500 Server Error")).toBe(true); // per-repo fetch error
		// permanent config failure (unsupported repo-auth) → also incomplete by
		// design: fail loud / skip rather than email a partial set.
		expect(real("Unsupported provider/auth combination")).toBe(true);
		// benign (window-irrelevant) → false
		expect(real("latest: HTTP 502")).toBe(false);
		expect(
			real("Skipped some latest-release lookups — time budget exhausted"),
		).toBe(false);
		expect(
			real(
				"2 release-note bodies omitted to stay within the brief size budget",
			),
		).toBe(false);
	});

	it("capTruncationSends: the collector's item cap no longer blocks the send; other failures still do", () => {
		const cap =
			"Deployments list truncated to 50 most recent; 123 older in-window release(s) omitted";
		const incomplete = (reasons: string[], capTruncationSends?: boolean) =>
			selectNewsletterReleases(
				{
					items: [rel()],
					failures: reasons.map((reason) => ({
						repoFullName: "acme/web",
						reason,
					})),
				},
				start,
				{ capTruncationSends },
			).incomplete;
		// Pre-patch histories keep the old classification.
		expect(incomplete([cap])).toBe(true);
		expect(incomplete([cap], true)).toBe(false);
		expect(
			incomplete(
				[
					cap,
					"Release list truncated before it reached the window start; some older in-window releases may be missing",
				],
				true,
			),
		).toBe(true);
		expect(incomplete([cap, "HTTP 500 Server Error"], true)).toBe(true);
	});

	it("returns only the failures that made the scan incomplete", () => {
		const cap =
			"Deployments list truncated to 50 most recent; 123 older in-window release(s) omitted";
		const out = selectNewsletterReleases(
			{
				items: [rel()],
				failures: [
					{
						repoFullName: "example-org/example-repo",
						reason: "GitHub API error: Not Found",
					},
					{
						repoFullName: "example-org/example-repo",
						reason: "latest: GitHub API error (latest): Not Found",
					},
					{
						repoFullName: "*",
						reason: "2 release-note bodies omitted to stay within the brief size budget; open releases on GitHub for full notes",
					},
					{ repoFullName: "*", reason: cap },
				],
			},
			start,
			{ capTruncationSends: true },
		);
		expect(out.incomplete).toBe(true);
		expect(out.incompleteFailures).toEqual([
			{
				repoFullName: "example-org/example-repo",
				reason: "GitHub API error: Not Found",
			},
		]);
	});

	it("returns no incomplete failures for a complete scan", () => {
		const out = selectNewsletterReleases(
			{
				items: [rel()],
				failures: [
					{
						repoFullName: "example-org/example-repo",
						reason: "latest: HTTP 502",
					},
				],
			},
			start,
		);
		expect(out.incomplete).toBe(false);
		expect(out.incompleteFailures).toEqual([]);
	});

	it("accepts string occurredAt (Temporal serializes Date→ISO); drops unparseable", () => {
		const out = selectNewsletterReleases(
			{
				items: [
					rel({
						occurredAt:
							"2026-06-11T00:00:00.000Z" as unknown as Date,
					}),
					rel({
						tagName: "v9.9.9",
						occurredAt: "not-a-date" as unknown as Date,
					}),
				],
				failures: [],
			},
			start,
		);
		expect(out.releases.map((r) => r.tagName)).toEqual(["v1.3.7"]);
	});
});

describe("formatIncompleteScanReason", () => {
	it("is null when there is nothing to report", () => {
		expect(formatIncompleteScanReason([])).toBeNull();
	});

	it("writes one line per repository, merging a repository's reasons", () => {
		expect(
			formatIncompleteScanReason([
				{
					repoFullName: "example-org/example-repo",
					reason: "GitHub API error: Not Found",
				},
				{
					repoFullName: "example-org/other-repo",
					reason: "No access token on integration (not yet authorized?)",
				},
				{
					repoFullName: "example-org/example-repo",
					reason: "Release list truncated before it reached the window start; some older in-window releases may be missing",
				},
				{
					repoFullName: "example-org/example-repo",
					reason: "GitHub API error: Not Found",
				},
			]),
		).toBe(
			[
				"example-org/example-repo: GitHub API error: Not Found; Release list truncated before it reached the window start; some older in-window releases may be missing",
				"example-org/other-repo: No access token on integration (not yet authorized?)",
			].join("\n"),
		);
	});

	it("writes a section-level note without a repository prefix", () => {
		expect(
			formatIncompleteScanReason([
				{
					repoFullName: "*",
					reason: "Deployments list truncated to 50 most recent; 3 older in-window release(s) omitted",
				},
			]),
		).toBe(
			"Deployments list truncated to 50 most recent; 3 older in-window release(s) omitted",
		);
	});

	it("caps the repositories listed and the length of each line", () => {
		const failures = Array.from({ length: 8 }, (_, i) => ({
			repoFullName: `example-org/example-repo-${i}`,
			reason: `GitHub API error: ${"x".repeat(500)}`,
		}));
		const out = formatIncompleteScanReason(failures);
		const lines = out?.split("\n") ?? [];
		expect(lines).toHaveLength(6);
		expect(lines[0].startsWith("example-org/example-repo-0: ")).toBe(true);
		expect(lines[4].startsWith("example-org/example-repo-4: ")).toBe(true);
		expect(lines[5]).toBe("and 3 more repositories");
		for (const line of lines.slice(0, 5)) {
			expect(line.length).toBeLessThanOrEqual(200);
			expect(line.endsWith("…")).toBe(true);
		}
		expect(out?.length ?? 0).toBeLessThanOrEqual(5 * 200 + 5 + 30);
	});

	it("says repository in the singular for one more", () => {
		const failures = Array.from({ length: 6 }, (_, i) => ({
			repoFullName: `example-org/example-repo-${i}`,
			reason: "GitHub API error: Not Found",
		}));
		const out = formatIncompleteScanReason(failures);
		expect(out?.split("\n").at(-1)).toBe("and 1 more repository");
	});
});
