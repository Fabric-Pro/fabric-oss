import { describe, expect, it } from "vitest";
import {
	hasAnyItems,
	truncateSections,
} from "../src/activities/daily-brief/summarize-daily-brief";

const deployment = {
	occurredAt: new Date("2026-06-05T10:00:00Z"),
	title: "v1.0.0",
	repoFullName: "o/r",
	tagName: "v1.0.0",
	url: "https://x/y",
};

describe("hasAnyItems", () => {
	it("is true when only deployments are present", () => {
		expect(hasAnyItems({ deployments: [deployment] })).toBe(true);
	});
	it("is false for an empty sections object", () => {
		expect(hasAnyItems({})).toBe(false);
	});
});

describe("truncateSections", () => {
	it("includes deployments so the LLM prompt can reference them", () => {
		const out = truncateSections({ deployments: [deployment] });
		expect(out.deployments).toHaveLength(1);
	});
	it("caps deployments at the section item limit", () => {
		const many = Array.from({ length: 40 }, () => deployment);
		const out = truncateSections({ deployments: many });
		expect(out.deployments?.length).toBe(25);
	});
	it("trims long deployment bodies for the prompt (the full body still persists for the UI via the untruncated sections)", () => {
		const big = "x".repeat(9_000);
		const out = truncateSections({
			deployments: [{ ...deployment, body: big }],
		});
		const body = out.deployments?.[0].body ?? "";
		expect(body.length).toBeLessThanOrEqual(501); // 500 cap + "…"
		expect(body.endsWith("…")).toBe(true);
	});
	it("leaves short deployment bodies intact", () => {
		const out = truncateSections({
			deployments: [{ ...deployment, body: "short notes" }],
		});
		expect(out.deployments?.[0].body).toBe("short notes");
	});
});
