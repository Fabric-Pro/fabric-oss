import { describe, expect, it } from "vitest";
import { extractGroupMentions, extractUserMentions } from "../user-mention";

describe("extractGroupMentions", () => {
	it("matches @@<slug> tokens and maps to tags", () => {
		expect(extractGroupMentions("hey @@developers please review")).toEqual([
			"DEVELOPER",
		]);
		expect(extractGroupMentions("@@sdet-qa and @@architects")).toEqual([
			"SDET_QA",
			"ARCHITECT",
		]);
	});
	it("dedupes and ignores unknown slugs", () => {
		expect(
			extractGroupMentions("@@developers @@developers @@nobody"),
		).toEqual(["DEVELOPER"]);
	});
	it("is disjoint from the username matcher (both directions)", () => {
		// A group token yields NO username…
		expect(extractUserMentions("@@developers")).toEqual([]);
		// …and a single-@ token is NOT a group.
		expect(extractGroupMentions("@developers")).toEqual([]);
		expect(extractGroupMentions("@alice")).toEqual([]);
	});
	it("requires a leading boundary (mid-word @@ is not a mention)", () => {
		expect(extractGroupMentions("email@@developers")).toEqual([]);
	});
});
