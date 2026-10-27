import { OrchestratorMemoryForm } from "@saas/settings/components/OrchestratorMemoryForm";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	episodes: vi.fn(),
	preferences: vi.fn(),
	deleteEpisode: vi.fn(),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		orchestrator: {
			memory: {
				getEpisodes: mocks.episodes,
				getPreferences: mocks.preferences,
				deleteEpisode: mocks.deleteEpisode,
			},
		},
	},
}));
const summary =
	"First request: Review the example\nTurn 1\n- Read the example\nTurn 2\n- Summarize findings";
const episodes = Array.from({ length: 12 }, (_, index) => ({
	id: `example-episode-${index}`,
	title: `Example conversation ${index + 1}`,
	summary,
	keyTopics: [],
	userIntents: [],
	outcome: "success",
	toolsUsed: [],
	agentsUsed: [],
	messageCount: 4,
	turnCount: 2,
	conversationStartedAt: "2026-10-01",
	conversationEndedAt: "2026-10-02",
}));
beforeEach(() => {
	vi.resetAllMocks();
	mocks.preferences.mockResolvedValue({ preferences: { preferences: {} } });
	mocks.episodes.mockImplementation(async ({ offset, limit }) => ({
		episodes: episodes.slice(offset, offset + limit),
		total: 12,
	}));
});
afterEach(cleanup);
function renderForm(
	client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	}),
) {
	return render(
		<QueryClientProvider client={client}>
			<OrchestratorMemoryForm organizationId="example-org" />
		</QueryClientProvider>,
	);
}
it("preserves newlines in the expanded summary while keeping the collapsed preview clamped", async () => {
	renderForm();
	const title = await screen.findByText("Example conversation 1");
	expect(
		title.closest("button")?.querySelector(".line-clamp-1"),
	).toBeTruthy();
	fireEvent.click(title);
	const heading = screen.getByText("Summary");
	const paragraph = heading.nextElementSibling;
	expect(paragraph?.textContent).toBe(summary);
	expect(paragraph).toHaveClass("whitespace-pre-line");
});
// Guards the existing UI contract with paged responses; server paging is tested separately.
it("guards the UI contract for total, Next button and second page range", async () => {
	renderForm();
	await screen.findByText("Showing 1 - 10 of 12");
	expect(screen.getByText("12 episodes")).toBeInTheDocument();
	expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
	expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();
	fireEvent.click(screen.getByRole("button", { name: "Next" }));
	await screen.findByText("Showing 11 - 12 of 12");
	expect(mocks.episodes).toHaveBeenLastCalledWith({
		organizationId: "example-org",
		limit: 10,
		offset: 10,
	});
	expect(
		screen.queryByText("Example conversation 1"),
	).not.toBeInTheDocument();
	expect(screen.getByText("Example conversation 11")).toBeInTheDocument();
	expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
	expect(screen.getByRole("button", { name: "Previous" })).toBeEnabled();
});

it("returns to the last existing page after deleting its final entry", async () => {
	let remaining = episodes.slice(0, 11);
	mocks.episodes.mockImplementation(async ({ offset, limit }) => ({
		episodes: remaining.slice(offset, offset + limit),
		total: remaining.length,
	}));
	mocks.deleteEpisode.mockImplementation(async ({ episodeId }) => {
		remaining = remaining.filter((episode) => episode.id !== episodeId);
		return { success: true };
	});
	renderForm();
	await screen.findByText("Showing 1 - 10 of 11");
	fireEvent.click(screen.getByRole("button", { name: "Next" }));
	const title = await screen.findByText("Example conversation 11");
	fireEvent.click(title);
	fireEvent.click(screen.getByRole("button", { name: "Remove" }));
	await screen.findByText("Showing 1 - 10 of 10");
	expect(screen.getByText("10 episodes")).toBeInTheDocument();
	expect(screen.getByText("Example conversation 1")).toBeInTheDocument();
	expect(
		screen.queryByText("No conversation history yet"),
	).not.toBeInTheDocument();
	expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
	await waitFor(() =>
		expect(mocks.deleteEpisode).toHaveBeenCalledWith({
			organizationId: "example-org",
			episodeId: "example-episode-10",
		}),
	);
});

it("keeps Next on an existing page while revalidating a cached out-of-range total", async () => {
	let remaining = episodes.slice(0, 11);
	let revalidation:
		| Promise<{ episodes: typeof episodes; total: number }>
		| undefined;
	const freshPage = Promise.withResolvers<{
		episodes: typeof episodes;
		total: number;
	}>();
	mocks.episodes.mockImplementation(async ({ offset, limit }) => {
		if (offset === 10 && revalidation) {
			return revalidation;
		}
		return {
			episodes: remaining.slice(offset, offset + limit),
			total: remaining.length,
		};
	});
	mocks.deleteEpisode.mockImplementation(async ({ episodeId }) => {
		remaining = remaining.filter((episode) => episode.id !== episodeId);
		return { success: true };
	});
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const { container } = renderForm(client);
	await screen.findByText("Showing 1 - 10 of 11");
	fireEvent.click(screen.getByRole("button", { name: "Next" }));
	fireEvent.click(await screen.findByText("Example conversation 11"));
	fireEvent.click(screen.getByRole("button", { name: "Remove" }));
	await screen.findByText("Showing 1 - 10 of 10");

	// A newly saved conversation refreshes page 1 and leaves page 2's old
	// { episodes: [], total: 10 } cached but invalidated within its gcTime.
	remaining.push(episodes[11]);
	await act(async () => {
		await client.invalidateQueries({
			queryKey: ["orchestrator-memory-episodes", "example-org"],
		});
	});
	await screen.findByText("Showing 1 - 10 of 11");
	revalidation = freshPage.promise;
	fireEvent.click(screen.getByRole("button", { name: "Next" }));
	await waitFor(() => {
		expect(
			client.isFetching({
				queryKey: ["orchestrator-memory-episodes", "example-org", 10],
			}),
		).toBe(1);
	});
	expect(container.querySelector(".animate-pulse")).toBeInTheDocument();
	expect(screen.queryByText("Showing 1 - 10 of 11")).not.toBeInTheDocument();
	expect(
		screen.queryByText("No conversation history yet"),
	).not.toBeInTheDocument();

	await act(async () => {
		freshPage.resolve({ episodes: [episodes[11]], total: 11 });
	});
	await screen.findByText("Showing 11 - 11 of 11");
	expect(screen.getByText("Example conversation 12")).toBeInTheDocument();
	expect(screen.getByRole("button", { name: "Previous" })).toBeEnabled();
	expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
	fireEvent.click(screen.getByRole("button", { name: "Previous" }));
	await screen.findByText("Showing 1 - 10 of 11");
});

it("shows a retryable error instead of a blank section when episodes fail to load", async () => {
	mocks.episodes.mockRejectedValueOnce(new Error("example failure"));
	renderForm();
	await screen.findByText("Conversation history could not be loaded.");
	expect(
		screen.queryByText("No conversation history yet"),
	).not.toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: "Try again" }));
	await screen.findByText("Showing 1 - 10 of 12");
});

it("leaves a cached out-of-range page when its refresh fails", async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const pageTwoKey = ["orchestrator-memory-episodes", "example-org", 10];
	client.setQueryData(pageTwoKey, { episodes: [], total: 10 });
	await client.invalidateQueries({
		queryKey: pageTwoKey,
		refetchType: "none",
	});
	mocks.episodes.mockImplementation(async ({ offset, limit }) => {
		if (offset === 10) {
			throw new Error("example failure");
		}
		return { episodes: episodes.slice(offset, offset + limit), total: 12 };
	});
	renderForm(client);
	await screen.findByText("Showing 1 - 10 of 12");
	fireEvent.click(screen.getByRole("button", { name: "Next" }));
	await waitFor(() =>
		expect(mocks.episodes).toHaveBeenCalledWith(
			expect.objectContaining({ offset: 10 }),
		),
	);
	await screen.findByText("Showing 1 - 10 of 12");
});
