import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serializeRoadmapQuery } from "../../../hooks/useRoadmapFilters";
import {
	buildRoadmapReturnRoute,
	readRoadmapQuery,
	rememberRoadmapQuery,
} from "../roadmap-return";

describe("buildRoadmapReturnRoute", () => {
	it("with an empty query returns exactly the pre-existing literal", () => {
		expect(buildRoadmapReturnRoute("/app/acme", "p1", "")).toBe(
			"/app/acme/projects/p1?tab=stories",
		);
	});

	it("puts tab first, then the filter query, preserving repeated keys", () => {
		expect(
			buildRoadmapReturnRoute(
				"/app/acme",
				"p1",
				"?q=login&kind=BUG&kind=FEATURE",
			),
		).toBe(
			"/app/acme/projects/p1?tab=stories&q=login&kind=BUG&kind=FEATURE",
		);
	});

	it("accepts a query without a leading '?'", () => {
		expect(buildRoadmapReturnRoute("/app/acme", "p1", "q=login")).toBe(
			"/app/acme/projects/p1?tab=stories&q=login",
		);
	});

	it("overrides a tab embedded in the query — stories always wins, appearing once", () => {
		const result = buildRoadmapReturnRoute(
			"/app/acme",
			"p1",
			"?tab=documents&q=login",
		);
		expect(result).toBe("/app/acme/projects/p1?tab=stories&q=login");
		expect(result.match(/tab=/g)).toHaveLength(1);
	});

	it("round-trips a query the serializer actually produces — comma-joined arrays, and array items containing the separator", () => {
		// `serializeRoadmapQuery` (nuqs) never repeats a key for an array
		// filter: it joins items with `,` into ONE value (`kind=BUG,FEATURE`),
		// and escapes any `,` inside an item's own value so it doesn't get
		// mistaken for the join separator on parse. Re-parsing that through
		// `URLSearchParams` (as `buildRoadmapReturnRoute` does) re-spells the
		// escape but must not change what the value decodes back to.
		const serialized = serializeRoadmapQuery({
			kind: ["BUG", "FEATURE"],
			tags: ["a,b", "c"],
		});

		const route = buildRoadmapReturnRoute("/app/acme", "p1", serialized);
		const routeParams = new URLSearchParams(route.split("?")[1]);

		expect(routeParams.get("kind")).toBe("BUG,FEATURE");

		// For `tags`, compare against the serializer's own output parsed the
		// same way, rather than a hand-computed encoded literal — that
		// sidesteps needing to reason about nuqs's internal comma-escaping.
		const serializedParams = new URLSearchParams(
			serialized.startsWith("?") ? serialized.slice(1) : serialized,
		);
		expect(routeParams.get("tags")).toBe(serializedParams.get("tags"));
	});
});

describe("rememberRoadmapQuery / readRoadmapQuery", () => {
	beforeEach(() => {
		window.sessionStorage.clear();
	});

	it("round-trips a stored query", () => {
		rememberRoadmapQuery("p1", "?q=login&kind=BUG");
		expect(readRoadmapQuery("p1")).toBe("?q=login&kind=BUG");
	});

	it("isolates storage between two projectIds", () => {
		rememberRoadmapQuery("p1", "?q=login");
		rememberRoadmapQuery("p2", "?q=other");
		expect(readRoadmapQuery("p1")).toBe("?q=login");
		expect(readRoadmapQuery("p2")).toBe("?q=other");
	});

	it("returns '' when nothing has been stored", () => {
		expect(readRoadmapQuery("never-stored")).toBe("");
	});

	it("remembers an empty query too, so clearing filters is recorded", () => {
		rememberRoadmapQuery("p1", "?q=login");
		rememberRoadmapQuery("p1", "");
		expect(readRoadmapQuery("p1")).toBe("");
	});

	describe("when sessionStorage throws", () => {
		afterEach(() => {
			vi.restoreAllMocks();
		});

		it("rememberRoadmapQuery no-ops instead of throwing", () => {
			vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
				throw new Error("storage disabled");
			});
			expect(() => rememberRoadmapQuery("p1", "?q=login")).not.toThrow();
		});

		it("readRoadmapQuery returns '' instead of throwing", () => {
			vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
				throw new Error("storage disabled");
			});
			expect(() => readRoadmapQuery("p1")).not.toThrow();
			expect(readRoadmapQuery("p1")).toBe("");
		});
	});
});
