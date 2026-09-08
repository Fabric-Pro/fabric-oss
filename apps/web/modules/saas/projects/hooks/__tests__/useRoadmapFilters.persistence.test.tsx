import { act, renderHook } from "@testing-library/react";
import { withNuqsTestingAdapter } from "nuqs/adapters/testing";
import { beforeEach, describe, expect, it } from "vitest";
import {
	readRoadmapQuery,
	rememberRoadmapQuery,
} from "../../lib/stories/roadmap-return";
import { useRoadmapFilters } from "../useRoadmapFilters";

// `useRoadmapFilters` remembers its serialized filter query in sessionStorage
// on every state change (see `../../lib/stories/roadmap-return.ts`) so "Back
// to roadmap" can restore it from a different route. Nothing else in the
// suite mounts the hook and observes sessionStorage — without this file, a
// change that deleted that persistence effect would leave every other test
// green.
//
// `hasMemory: true` on the testing adapter is required: without it, the
// adapter records URL updates for `onUrlUpdate` assertions but never feeds
// them back into `useQueryStates`' own state, so `clearAll()` wouldn't be
// observable here.

describe("useRoadmapFilters — sessionStorage persistence", () => {
	beforeEach(() => {
		window.sessionStorage.clear();
	});

	it("remembers the mounted project's filter query", () => {
		renderHook(() => useRoadmapFilters("p1"), {
			wrapper: withNuqsTestingAdapter({
				searchParams: "?q=login&kind=BUG",
				hasMemory: true,
			}),
		});

		expect(readRoadmapQuery("p1")).toBe("?q=login&kind=BUG");
	});

	it("remembers an empty query after clearAll", () => {
		const { result } = renderHook(() => useRoadmapFilters("p1"), {
			wrapper: withNuqsTestingAdapter({
				searchParams: "?q=login&kind=BUG",
				hasMemory: true,
			}),
		});

		act(() => {
			result.current.clearAll();
		});

		expect(readRoadmapQuery("p1")).toBe("");
	});

	it("leaves a different projectId's stored key untouched", () => {
		rememberRoadmapQuery("other-project", "?untouched=1");

		renderHook(() => useRoadmapFilters("p1"), {
			wrapper: withNuqsTestingAdapter({
				searchParams: "?q=login",
				hasMemory: true,
			}),
		});

		expect(readRoadmapQuery("other-project")).toBe("?untouched=1");
	});
});
