import { describe, expect, it } from "vitest";
import { isFetchComplete } from "../pm-fetch-complete";

describe("isFetchComplete", () => {
	it("true when every linked id was observed (fetched or not-found)", () => {
		expect(
			isFetchComplete({
				seenExternalIds: ["1", "2"],
				notFoundIds: ["3"],
				totalLinked: 3,
			}),
		).toBe(true);
	});
	it("false when a linked id was not observed (transient fail / budget skip / discovery timeout)", () => {
		expect(
			isFetchComplete({
				seenExternalIds: ["1"],
				notFoundIds: [],
				totalLinked: 3,
			}),
		).toBe(false);
	});
	it("true for an empty linked set (nothing to miss)", () => {
		expect(
			isFetchComplete({
				seenExternalIds: [],
				notFoundIds: [],
				totalLinked: 0,
			}),
		).toBe(true);
	});
});
