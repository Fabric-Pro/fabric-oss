import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	ENGAGEMENT_PROFILE_METADATA_STORAGE_KEY,
	useEngagementProfileExpanded,
} from "../useEngagementProfileExpanded";

describe("useEngagementProfileExpanded", () => {
	beforeEach(() => {
		localStorage.clear();
		vi.restoreAllMocks();
	});

	it("defaults to collapsed when localStorage is empty", () => {
		const { result } = renderHook(() => useEngagementProfileExpanded());

		expect(result.current.isExpanded).toBe(false);
		expect(
			localStorage.getItem(ENGAGEMENT_PROFILE_METADATA_STORAGE_KEY),
		).toBeNull();
	});

	it("toggles between expanded and collapsed and persists to localStorage", () => {
		const { result } = renderHook(() => useEngagementProfileExpanded());

		act(() => {
			result.current.toggleExpanded();
		});
		expect(result.current.isExpanded).toBe(true);
		expect(
			localStorage.getItem(ENGAGEMENT_PROFILE_METADATA_STORAGE_KEY),
		).toBe("true");

		act(() => {
			result.current.toggleExpanded();
		});
		expect(result.current.isExpanded).toBe(false);
		expect(
			localStorage.getItem(ENGAGEMENT_PROFILE_METADATA_STORAGE_KEY),
		).toBe("false");
	});

	it("hydrates to expanded on mount when localStorage has 'true'", () => {
		localStorage.setItem(ENGAGEMENT_PROFILE_METADATA_STORAGE_KEY, "true");

		const { result } = renderHook(() => useEngagementProfileExpanded());

		expect(result.current.isExpanded).toBe(true);
	});

	it("falls back to collapsed when localStorage contains invalid data", () => {
		localStorage.setItem(
			ENGAGEMENT_PROFILE_METADATA_STORAGE_KEY,
			"not-a-boolean",
		);

		const { result } = renderHook(() => useEngagementProfileExpanded());

		expect(result.current.isExpanded).toBe(false);
	});

	it("falls back to collapsed when localStorage throws an error", () => {
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("SecurityError: Access is denied");
		});

		const { result } = renderHook(() => useEngagementProfileExpanded());

		expect(result.current.isExpanded).toBe(false);
	});
});
