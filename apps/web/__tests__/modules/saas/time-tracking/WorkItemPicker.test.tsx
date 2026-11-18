/**
 * The work item picker offers the most recently edited items first.
 *
 * The board arrives whole in backlog order, so the picker ranks it by last
 * edit (creation for an item never edited) before it caps the list. Ranking
 * after the cap would strand a recent item past the fiftieth row.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockBoard } = vi.hoisted(() => ({ mockBoard: vi.fn() }));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			stories: {
				board: {
					queryOptions: (options: { input: unknown }) => ({
						queryKey: [
							["projects", "stories", "board"],
							{ input: options.input, type: "query" },
						],
						queryFn: () => mockBoard(),
					}),
				},
			},
		},
	},
}));

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => key,
}));

import { WorkItemPicker } from "@saas/time-tracking/components/WorkItemPicker";

function story(
	id: string,
	createdAt: string,
	lastEditedAt: string | null = null,
) {
	return {
		id,
		identifier: id.toUpperCase(),
		title: `Item ${id}`,
		createdAt: new Date(createdAt),
		lastEditedAt: lastEditedAt ? new Date(lastEditedAt) : null,
	};
}

function renderPicker() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queryClient}>
			{children}
		</QueryClientProvider>
	);
	return render(
		<WorkItemPicker
			projectId="project-a"
			organizationId="org-1"
			value={null}
			onChange={vi.fn()}
		/>,
		{ wrapper },
	);
}

function optionTexts() {
	return screen.getAllByRole("option").map((option) => option.textContent);
}

async function openOptions() {
	await userEvent.click(screen.getByRole("combobox", { name: "workItem" }));
	await screen.findAllByRole("option");
	return optionTexts();
}

beforeEach(() => {
	mockBoard.mockReset();
});

describe("WorkItemPicker", () => {
	it("lists items by last edit, newest first, and by creation when never edited", async () => {
		mockBoard.mockResolvedValue({
			statuses: [],
			stories: [
				story("a", "2026-01-01T00:00:00Z", "2026-03-01T00:00:00Z"),
				story("b", "2026-11-01T00:00:00Z"),
				story("c", "2026-02-01T00:00:00Z", "2026-11-10T00:00:00Z"),
			],
		});
		renderPicker();

		const options = await openOptions();

		expect(options).toEqual(["CItem c", "BItem b", "AItem a"]);
	});

	it("ranks the whole board before the cap, so a recent item past row 50 is offered", async () => {
		const older = Array.from({ length: 60 }, (_, index) =>
			story(`old${index}`, "2026-01-01T00:00:00Z"),
		);
		mockBoard.mockResolvedValue({
			statuses: [],
			stories: [...older, story("recent", "2026-11-12T00:00:00Z")],
		});
		renderPicker();

		const options = await openOptions();

		expect(options).toHaveLength(50);
		expect(options[0]).toBe("RECENTItem recent");
	});

	it("keeps the ranking while searching", async () => {
		mockBoard.mockResolvedValue({
			statuses: [],
			stories: [
				story("a", "2026-01-01T00:00:00Z"),
				story("b", "2026-02-01T00:00:00Z"),
				story("x", "2026-11-01T00:00:00Z"),
				{ ...story("z", "2026-11-11T00:00:00Z"), title: "Other work" },
			],
		});
		renderPicker();
		await openOptions();

		await userEvent.type(
			screen.getByPlaceholderText("workItemSearch"),
			"item",
		);

		expect(optionTexts()).toEqual(["XItem x", "BItem b", "AItem a"]);
	});
});
