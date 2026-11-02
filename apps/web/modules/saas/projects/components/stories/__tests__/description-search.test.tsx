import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import {
	applyRoadmapFilters,
	EMPTY_ROADMAP_FILTERS,
} from "../../../lib/roadmap-filters";
import { scoreStoryAgainstQuery } from "../../../lib/roadmap-search-relevance";
import type { UserStory } from "../../../lib/stories/types";
import {
	DescriptionSearchStatus,
	useDescriptionSearch,
} from "../use-description-search";

const search = vi.hoisted(() => vi.fn());
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			stories: {
				searchDescriptions: {
					queryOptions: ({ input }: { input: unknown }) => ({
						queryKey: ["descriptions", input],
						queryFn: () => search(input),
					}),
				},
			},
		},
	},
}));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
const stories = [
	{ id: "body", title: "Other", identifier: "1", tags: [] },
	{ id: "title", title: "needle", identifier: "2", tags: [] },
] as unknown as UserStory[];
function Harness({
	board,
	q = "needle",
}: {
	board: { id: string; updatedAt: Date | string }[];
	q?: string;
}) {
	const result = useDescriptionSearch(
		"example-project",
		"example-org",
		q,
		board,
	);
	const score = scoreStoryAgainstQuery(q, result.matches);
	const visible = applyRoadmapFilters(
		stories,
		{ ...EMPTY_ROADMAP_FILTERS, q },
		{ descriptionMatches: result.matches },
	).sort((a, b) => score(b) - score(a));
	return (
		<>
			<DescriptionSearchStatus {...result} />
			<ol>
				{visible.map((s) => (
					<li key={s.id}>{s.id}</li>
				))}
			</ol>
		</>
	);
}
it("adds body hits, preserves title rank and refreshes only when board data changes", async () => {
	let answer!: (value: unknown) => void;
	search
		.mockReset()
		.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					answer = resolve;
				}),
		)
		.mockResolvedValue({ matches: [] });
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: 60000 } },
	});
	const board = [
		{ id: "one", updatedAt: new Date(1), createdAt: new Date(1) },
	];
	const ui = (data: typeof board) => (
		<QueryClientProvider client={client}>
			<Harness board={data} />
		</QueryClientProvider>
	);
	const view = render(ui(board));
	expect(screen.getByRole("status")).toHaveTextContent("pending");
	expect(screen.queryByText("body")).toBeNull();
	await act(async () =>
		answer({ matches: [{ id: "body", needles: ["needle"] }] }),
	);
	await waitFor(() =>
		expect(
			screen.getAllByRole("listitem").map((n) => n.textContent),
		).toEqual(["title", "body"]),
	);
	view.rerender(ui(board));
	expect(search).toHaveBeenCalledTimes(1);
	view.rerender(
		ui([{ id: "one", updatedAt: new Date(1), createdAt: new Date(1) }]),
	);
	expect(search).toHaveBeenCalledTimes(1);
	expect(screen.queryByRole("status")).toBeNull();
	view.rerender(
		ui([{ id: "one", updatedAt: new Date(2), createdAt: new Date(1) }]),
	);
	await waitFor(() => expect(search).toHaveBeenCalledTimes(2));
	await waitFor(() => expect(screen.queryByText("body")).toBeNull());
	view.rerender(
		ui([
			...board,
			{ id: "two", updatedAt: new Date(1), createdAt: new Date(1) },
		]),
	);
	await waitFor(() => expect(search).toHaveBeenCalledTimes(3));
	view.rerender(ui(board));
	await waitFor(() => expect(search).toHaveBeenCalledTimes(4));
});
it("reports failure with retry, searches realistic long queries and reports skipped queries", async () => {
	search
		.mockReset()
		.mockRejectedValueOnce(new Error("offline"))
		.mockResolvedValue({ matches: [] });
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const board: typeof stories = [];
	const ui = (q = "needle") => (
		<QueryClientProvider client={client}>
			<Harness board={board} q={q} />
		</QueryClientProvider>
	);
	const view = render(ui());
	await waitFor(() =>
		expect(screen.getByRole("status")).toHaveTextContent("failed"),
	);
	await userEvent.click(screen.getByRole("button", { name: /retry/ }));
	await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
	for (const q of [
		"x".repeat(201),
		Array.from({ length: 21 }, (_, i) => `word${i}`).join(" "),
	]) {
		view.rerender(ui(q));
		await waitFor(() =>
			expect(search).toHaveBeenCalledWith(
				expect.objectContaining({
					needles: expect.arrayContaining([q.split(" ")[0]]),
				}),
			),
		);
	}
	const calls = search.mock.calls.length;
	view.rerender(ui("x".repeat(2001)));
	expect(screen.getByRole("status")).toHaveTextContent("skipped");
	expect(search).toHaveBeenCalledTimes(calls);
	view.rerender(
		ui(Array.from({ length: 65 }, (_, i) => `word${i}`).join(" ")),
	);
	expect(screen.getByRole("status")).toHaveTextContent("skipped");
	expect(search).toHaveBeenCalledTimes(calls);
});

it("shows pending for new needles but not a background refresh with data", async () => {
	let resolveNew!: (value: unknown) => void;
	let resolveRefresh!: (value: unknown) => void;
	search
		.mockReset()
		.mockResolvedValueOnce({ matches: [] })
		.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveNew = resolve;
				}),
		)
		.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveRefresh = resolve;
				}),
		);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: 60000 } },
	});
	const board = [{ id: "one", updatedAt: new Date(1) }];
	const ui = (q: string, rows = board) => (
		<QueryClientProvider client={client}>
			<Harness board={rows} q={q} />
		</QueryClientProvider>
	);
	const view = render(ui("needle"));
	await waitFor(() => expect(search).toHaveBeenCalledTimes(1));
	await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
	view.rerender(ui("other"));
	await waitFor(() =>
		expect(screen.getByRole("status")).toHaveTextContent("pending"),
	);
	await act(async () => resolveNew({ matches: [] }));
	await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
	view.rerender(ui("other", [{ id: "one", updatedAt: new Date(2) }]));
	await waitFor(() => expect(search).toHaveBeenCalledTimes(3));
	expect(screen.queryByRole("status")).toBeNull();
	await act(async () => resolveRefresh({ matches: [] }));
});
