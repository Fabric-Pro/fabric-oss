import type { GithubItem } from "@repo/database";
import { describe, expect, it } from "vitest";
import { splitReleasePrs } from "./newsletter-release-split";

const pr = (over: Partial<GithubItem>): GithubItem =>
	({
		occurredAt: new Date("2026-06-10T00:00:00Z"),
		title: "x",
		kind: "pr_merged",
		prNumber: 1,
		repoFullName: "a/b",
		url: "u",
		...over,
	}) as GithubItem;

describe("splitReleasePrs", () => {
	it("no prod merges → everything is staging", () => {
		const { prodPrs, stagingPrs } = splitReleasePrs([
			pr({ baseRef: "main", prNumber: 1 }),
			pr({ baseRef: "develop", prNumber: 2 }),
		]);
		expect(prodPrs).toHaveLength(0);
		expect(stagingPrs).toHaveLength(2);
	});
	it("splits staging PRs at the latest prod merge time", () => {
		const r = splitReleasePrs([
			pr({
				baseRef: "production",
				prNumber: 99,
				occurredAt: new Date("2026-06-10T12:00:00Z"),
			}),
			pr({
				baseRef: "main",
				prNumber: 1,
				occurredAt: new Date("2026-06-10T09:00:00Z"),
			}),
			pr({
				baseRef: "main",
				prNumber: 2,
				occurredAt: new Date("2026-06-10T15:00:00Z"),
			}),
		]);
		expect(r.prodPrs.map((p) => p.prNumber)).toEqual([1]);
		expect(r.stagingPrs.map((p) => p.prNumber)).toEqual([2]);
	});
});
