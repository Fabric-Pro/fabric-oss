import type { DeploymentItem } from "@repo/database";
import { describe, expect, it } from "vitest";
import {
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
				"Release list truncated at 500; some older in-window releases may be missing",
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
