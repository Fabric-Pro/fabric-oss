/**
 * FeatureCoverageList — the Features/coverage row's click target.
 *
 * A coverage row's title used to call `onSelectFeature(storyId)`, which
 * filtered the Cases segment in place and switched to it. #2492 replaced
 * that with a real link to the feature's own page (its QA tab for a
 * FEATURE, its details page for a BUG) — filtering by feature is still
 * available from the toolbar's Feature filter, so nothing was lost, but
 * nothing pins the row to a real, navigable link either. Without this test
 * a revert to the old filter-on-click callback compiles clean (the `Props`
 * type has no `onSelectFeature` to remove-and-miss) and nothing catches it.
 *
 * next-intl is globally key-mocked in vitest.setup.ts (labels === keys).
 */

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TestResult } from "../constants";

const useInfiniteQueryMock = vi.fn();

vi.mock("@tanstack/react-query", () => ({
	useInfiniteQuery: (...args: unknown[]) => useInfiniteQueryMock(...args),
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			testCases: {
				featureCoverage: {
					infiniteOptions: (opts: unknown) => opts,
				},
			},
		},
	},
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({ basePath: "/app" }),
}));

import { FeatureCoverageList } from "../FeatureCoverageList";

function counts(
	over: Partial<Record<TestResult, number>> = {},
): Record<TestResult, number> {
	return {
		NOT_RUN: 0,
		PASSED: 0,
		FAILED: 0,
		BLOCKED: 0,
		SKIPPED: 0,
		...over,
	};
}

function makeRow(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		storyId: "story-1",
		identifier: "42",
		title: "Reset password from settings",
		kind: "FEATURE",
		draftingStage: "DRAFT",
		caseCount: 2,
		resultCounts: counts({ PASSED: 2 }),
		distinctAcRefs: 1,
		coverageState: "COVERED",
		...overrides,
	};
}

function mockRows(rows: ReturnType<typeof makeRow>[]) {
	useInfiniteQueryMock.mockReturnValue({
		data: { pages: [{ items: rows, total: rows.length }] },
		isLoading: false,
		isError: false,
		hasNextPage: false,
		isFetchingNextPage: false,
		fetchNextPage: vi.fn(),
		refetch: vi.fn(),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("FeatureCoverageList — row click target", () => {
	it("a FEATURE row's title is a real link to its QA tab, not a filter callback", () => {
		mockRows([makeRow({ kind: "FEATURE", storyId: "story-1" })]);
		render(<FeatureCoverageList projectId="p1" />);

		const link = screen.getByRole("link", {
			name: "Reset password from settings",
		});
		expect(link.tagName).toBe("A");
		expect(link).toHaveAttribute(
			"href",
			"/app/projects/p1/stories/story-1?storyTab=qa",
		);
	});

	it("a BUG row's title links to its details page instead — bugs have no QA tab", () => {
		mockRows([
			makeRow({
				kind: "BUG",
				storyId: "story-2",
				title: "Crash on save",
			}),
		]);
		render(<FeatureCoverageList projectId="p1" />);

		const link = screen.getByRole("link", { name: "Crash on save" });
		expect(link).toHaveAttribute(
			"href",
			"/app/projects/p1/stories/story-2",
		);
	});
});
