import { describe, expect, it } from "vitest";
import { leftOutListing } from "../instructions-left-out";

const name = (path: string) => ({ path, rule: "tasks/" });

describe("leftOutListing", () => {
	it("lists a version whose names cover the count", () => {
		expect(
			leftOutListing(2, [name("tasks/a.md"), name("tasks/b.md")]),
		).toEqual({ listable: true, partial: false });
	});

	it("lists but flags a version that kept fewer names than files it left out", () => {
		expect(leftOutListing(4000, [name("tasks/a.md")])).toEqual({
			listable: true,
			partial: true,
		});
	});

	it("keeps the count alone for a version made before the names were kept", () => {
		expect(leftOutListing(4, [])).toEqual({
			listable: false,
			partial: false,
		});
		expect(leftOutListing(4, undefined)).toEqual({
			listable: false,
			partial: false,
		});
		expect(leftOutListing(4, null)).toEqual({
			listable: false,
			partial: false,
		});
	});

	it("has nothing to list when nothing was left out", () => {
		expect(leftOutListing(0, [])).toEqual({
			listable: false,
			partial: false,
		});
	});
});
