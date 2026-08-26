import { describe, expect, it } from "vitest";
import { buildDigestDeepLink, parseDigestDeepLink } from "../digest-deep-link";

describe("buildDigestDeepLink", () => {
	it("targets the digest tab, the meeting, and the action item", () => {
		const url = buildDigestDeepLink({
			basePath: "/app/acme",
			projectId: "proj1",
			transcriptRef: "graph-transcript-1",
			itemKey: "abc123",
		});
		expect(url).toBe(
			"/app/acme/projects/proj1?tab=meeting-digest&meeting=graph-transcript-1&actionItem=abc123",
		);
	});

	it("encodes values that would otherwise break the query string", () => {
		const url = buildDigestDeepLink({
			basePath: "/app",
			projectId: "proj 1",
			transcriptRef: "a&b=c",
			itemKey: "k/1",
		});
		expect(url).toContain("projects/proj%201");
		expect(url).toContain("meeting=a%26b%3Dc");
		expect(url).toContain("actionItem=k%2F1");
	});

	it("round-trips through parseDigestDeepLink", () => {
		const url = buildDigestDeepLink({
			basePath: "/app",
			projectId: "p",
			transcriptRef: "a&b=c",
			itemKey: "k/1",
		});
		const parsed = parseDigestDeepLink(
			new URLSearchParams(url.split("?")[1]),
		);
		expect(parsed).toEqual({ transcriptRef: "a&b=c", itemKey: "k/1" });
	});
});

describe("parseDigestDeepLink", () => {
	it("returns nulls when the params are absent", () => {
		expect(parseDigestDeepLink(new URLSearchParams(""))).toEqual({
			transcriptRef: null,
			itemKey: null,
		});
	});

	it("returns the meeting alone when no action item is given", () => {
		expect(parseDigestDeepLink(new URLSearchParams("meeting=t1"))).toEqual({
			transcriptRef: "t1",
			itemKey: null,
		});
	});
});
