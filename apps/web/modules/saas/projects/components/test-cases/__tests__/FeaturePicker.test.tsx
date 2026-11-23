/**
 * FeaturePicker, rendered: it asks the coverage query for the work-item
 * pickers' order (most recently edited first) and lists the page in the order
 * the server ranked it, covered items included, without regrouping by
 * coverage.
 */

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useQueryMock = vi.fn();

vi.mock("@tanstack/react-query", () => ({
	useQuery: (...args: unknown[]) => useQueryMock(...args),
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			testCases: {
				featureCoverage: {
					queryOptions: (opts: unknown) => opts,
				},
			},
		},
	},
}));

import { FeaturePicker } from "../FeaturePicker";

/** Most recently edited first, as the server ranks it; 101 is covered. */
const RANKED_ROWS = [
	{
		storyId: "story-101",
		identifier: "101",
		title: "Export reports",
		kind: "FEATURE",
		closed: false,
		caseCount: 3,
	},
	{
		storyId: "story-102",
		identifier: "102",
		title: "Import reports",
		kind: "FEATURE",
		closed: false,
		caseCount: 0,
	},
];

beforeEach(() => {
	vi.clearAllMocks();
	useQueryMock.mockReturnValue({
		data: { items: RANKED_ROWS, total: RANKED_ROWS.length },
		isLoading: false,
	});
});

describe("FeaturePicker", () => {
	it("asks for the most recently edited work items first", () => {
		render(
			<FeaturePicker
				projectId="example-project"
				organizationId={null}
				value={[]}
				onChange={vi.fn()}
				ariaLabel="Work item"
			/>,
		);

		expect(useQueryMock).toHaveBeenCalledWith(
			expect.objectContaining({
				input: expect.objectContaining({ order: "RECENT_FIRST" }),
			}),
		);
	});

	it("lists the ranked page as ranked, covered items included, with each coverage count", async () => {
		const user = userEvent.setup();
		render(
			<FeaturePicker
				projectId="example-project"
				organizationId={null}
				value={[]}
				onChange={vi.fn()}
				ariaLabel="Work item"
			/>,
		);

		await user.click(screen.getByRole("combobox", { name: "Work item" }));

		const options = await screen.findAllByRole("option");
		expect(options.map((option) => option.textContent)).toEqual([
			expect.stringContaining("Export reports"),
			expect.stringContaining("Import reports"),
		]);
		expect(
			within(options[0]).getByText("coverageCount"),
		).toBeInTheDocument();
	});
});
