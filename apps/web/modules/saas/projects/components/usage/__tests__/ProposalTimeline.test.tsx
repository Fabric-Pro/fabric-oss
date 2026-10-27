import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProposalTimeline } from "../ProposalTimeline";

const mocks = vi.hoisted(() => ({ flag: true, timeline: vi.fn() }));
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => mocks.flag,
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			decisionReplay: {
				getProposalTimeline: (...a: unknown[]) => mocks.timeline(...a),
			},
		},
	},
}));
function mount() {
	return render(
		<QueryClientProvider
			client={
				new QueryClient({
					defaultOptions: { queries: { retry: false } },
				})
			}
		>
			<ProposalTimeline
				projectId="example-project"
				proposalId="example-proposal"
			/>
		</QueryClientProvider>,
	);
}
const event = (values: Record<string, unknown>) => ({
	occurredAt: new Date("2026-01-01T12:00:00Z"),
	eventType: "status_changed",
	fromState: null,
	toState: null,
	actorKind: "human",
	actorName: null,
	subjectType: "backlog_proposal",
	changeIndex: null,
	action: null,
	createdEntityType: null,
	notSelectedTitles: [],
	...values,
});
beforeEach(() => {
	vi.clearAllMocks();
	mocks.flag = true;
	mocks.timeline.mockResolvedValue({ events: [], truncated: false });
});
afterEach(cleanup);
it("fetches only when expanded and maps event lines and truncation", async () => {
	mocks.timeline.mockResolvedValue({
		truncated: true,
		events: [
			event({ eventType: "proposed", actorKind: "system" }),
			event({ toState: "APPLYING", actorName: "Example reviewer" }),
			event({ toState: "APPROVED" }),
			event({ toState: "BACKLOG" }),
			event({ toState: "APPLIED", actorKind: "system" }),
			event({
				eventType: "change_applied",
				changeIndex: 0,
				action: "create",
				createdEntityType: "story",
			}),
			event({ eventType: "story_edited", subjectType: "story" }),
			event({ toState: "FAILED", actorKind: "system" }),
		],
	});
	mount();
	expect(mocks.timeline).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "Timeline" }));
	for (const line of [
		"Proposed by AI",
		"Example reviewer accepted (Applying)",
		"Someone accepted (Approved)",
		"Moved to Rejected",
		"Fabric · moved to Applied",
		"Change 1 applied (created story)",
		"Story edited",
		"Fabric · moved to Failed",
	]) {
		expect(
			await screen.findByText(line, { exact: true }),
		).toBeInTheDocument();
	}
	expect(
		screen.getByText("Showing the latest 200 events"),
	).toBeInTheDocument();
	expect(mocks.timeline).toHaveBeenCalledWith(
		{ projectId: "example-project", proposalId: "example-proposal" },
		expect.anything(),
	);
});
it("flag off has no timeline or request", () => {
	mocks.flag = false;
	mount();
	expect(
		screen.queryByRole("button", { name: "Timeline" }),
	).not.toBeInTheDocument();
	expect(mocks.timeline).not.toHaveBeenCalled();
});
it("empty history explains capture boundary", async () => {
	mount();
	fireEvent.click(screen.getByRole("button", { name: "Timeline" }));
	expect(
		await screen.findByText(
			"No history captured yet — history starts when Decision Replay is on.",
		),
	).toBeInTheDocument();
});
it("timeline failure retries inline", async () => {
	mocks.timeline.mockRejectedValueOnce(new Error("Unavailable"));
	mount();
	fireEvent.click(screen.getByRole("button", { name: "Timeline" }));
	fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
	expect(
		await screen.findByText(/No history captured yet/),
	).toBeInTheDocument();
});

it("NOT_FOUND removes the timeline and retry controls", async () => {
	mocks.timeline.mockRejectedValue({ code: "NOT_FOUND" });
	const view = mount();
	fireEvent.click(screen.getByRole("button", { name: "Timeline" }));
	const { waitFor } = await import("@testing-library/react");
	await waitFor(() => expect(view.container).toBeEmptyDOMElement());
	expect(mocks.timeline).toHaveBeenCalledTimes(1);
});
it.each([
	[{ eventType: "change_applied" }, "Change applied"],
	[
		{
			eventType: "change_applied",
			changeIndex: 0,
			action: "create",
			createdEntityType: "unknown",
		},
		"Change 1 applied",
	],
	...Object.entries({
		PENDING: "back to Pending",
		APPROVED: "to Approved",
		APPLYING: "to Applying",
		APPLIED: "to Applied",
		REJECTED: "to Rejected",
		FAILED: "to Failed",
		SUPERSEDED: "to Superseded",
		BACKLOG: "to Rejected",
	}).map(([toState, label]) => [
		{ actorKind: "system", toState },
		`Fabric · moved ${label}`,
	]),
])("formats event %j", async (values, line) => {
	mocks.timeline.mockResolvedValue({
		events: [event(values)],
		truncated: false,
	});
	mount();
	fireEvent.click(screen.getByRole("button", { name: "Timeline" }));
	const text = await screen.findByText(line as string, { exact: true });
	expect(text.textContent).toBe(line);
});

it("a person moving a proposal to PENDING uses the target-state wording", async () => {
	mocks.timeline.mockResolvedValue({
		events: [event({ toState: "PENDING", actorName: "Example reviewer" })],
		truncated: false,
	});
	mount();
	fireEvent.click(screen.getByRole("button", { name: "Timeline" }));
	expect(
		await screen.findByText("Example reviewer · moved back to Pending"),
	).toBeInTheDocument();
});

it.each([
	[true, 8, 5, "Example reviewer selected 5 of 8 changes · 3 not selected"],
	[false, 8, 5, "Example reviewer selected 5 changes"],
	[true, 5, 5, "Example reviewer selected 5 of 5 changes"],
])(
	"summarizes complete=%s offered=%s selected=%s reviews",
	async (complete, offered, selected, line) => {
		mocks.timeline.mockResolvedValue({
			truncated: false,
			events: [
				event({
					eventType: "proposal_reviewed",
					actorName: "Example reviewer",
					offeredCount: offered,
					selectedCount: selected,
					offeredListComplete: complete,
					notSelectedTitles: [],
				}),
			],
		});
		mount();
		fireEvent.click(screen.getByRole("button", { name: "Timeline" }));
		expect(
			await screen.findByText(line as string, { exact: true }),
		).toBeInTheDocument();
	},
);
it("expands not-selected titles with an accessible button and renders deduplication", async () => {
	mocks.timeline.mockResolvedValue({
		truncated: false,
		events: [
			event({
				eventType: "proposal_reviewed",
				offeredCount: 8,
				selectedCount: 5,
				offeredListComplete: true,
				notSelectedTitles: ["Example omitted change"],
			}),
			event({
				eventType: "change_deduplicated",
				actorKind: "system",
				changeIndex: 2,
			}),
		],
	});
	mount();
	fireEvent.click(screen.getByRole("button", { name: "Timeline" }));
	expect(
		await screen.findByText("Change 3 already on roadmap"),
	).toBeInTheDocument();
	const button = await screen.findByRole("button", {
		name: "Review 1: show 3 not selected changes",
	});
	expect(button).toHaveAttribute("aria-expanded", "false");
	expect(
		screen.queryByText("Example omitted change"),
	).not.toBeInTheDocument();
	fireEvent.click(button);
	expect(button).toHaveAttribute("aria-expanded", "true");
	expect(screen.getByText("Example omitted change")).toBeInTheDocument();
	expect(screen.getByText("and 2 more")).toBeInTheDocument();
	fireEvent.click(button);
	expect(button).toHaveAttribute("aria-expanded", "false");
});

it("distinguishes equal-count reviews and shows the omitted title remainder", async () => {
	mocks.timeline.mockResolvedValue({
		truncated: false,
		events: [
			event({
				eventType: "proposal_reviewed",
				offeredCount: 30,
				selectedCount: 5,
				offeredListComplete: true,
				notSelectedTitles: Array.from(
					{ length: 20 },
					(_, i) => `Example title ${i}`,
				),
			}),
			event({
				eventType: "proposal_reviewed",
				offeredCount: 30,
				selectedCount: 5,
				offeredListComplete: true,
				notSelectedTitles: ["Example second review"],
			}),
		],
	});
	mount();
	fireEvent.click(screen.getByRole("button", { name: "Timeline" }));
	const first = await screen.findByRole("button", {
		name: "Review 1: show 25 not selected changes",
	});
	const second = screen.getByRole("button", {
		name: "Review 2: show 25 not selected changes",
	});
	expect(first).toHaveAttribute("aria-expanded", "false");
	expect(second).toHaveAttribute("aria-expanded", "false");
	fireEvent.click(first);
	expect(screen.getByText("and 5 more")).toBeInTheDocument();
	expect(screen.queryByText("and 24 more")).not.toBeInTheDocument();
	fireEvent.click(second);
	expect(screen.getByText("and 24 more")).toBeInTheDocument();
});

it.each([
	[6, 5],
	[2, 5],
])(
	"omits the remainder for offered=%s selected=%s when no additional titles are known",
	async (offered, selected) => {
		mocks.timeline.mockResolvedValue({
			truncated: false,
			events: [
				event({
					eventType: "proposal_reviewed",
					offeredCount: offered,
					selectedCount: selected,
					offeredListComplete: true,
					notSelectedTitles: ["Example complete title"],
				}),
			],
		});
		mount();
		fireEvent.click(screen.getByRole("button", { name: "Timeline" }));
		fireEvent.click(
			await screen.findByRole("button", {
				name: /Review 1: show .* not selected changes/,
			}),
		);
		expect(screen.getByText("Example complete title")).toBeInTheDocument();
		expect(screen.queryByText(/^and .* more$/)).not.toBeInTheDocument();
	},
);

it("numbers reviews independently of other events, including reviews without an expander", async () => {
	const review = (titles: string[]) =>
		event({
			eventType: "proposal_reviewed",
			offeredCount: 8,
			selectedCount: 5,
			offeredListComplete: true,
			notSelectedTitles: titles,
		});
	mocks.timeline.mockResolvedValue({
		truncated: false,
		events: [
			event({ eventType: "proposed" }),
			event({ toState: "APPROVED" }),
			review(["Example first review"]),
			event({ eventType: "change_applied" }),
			review([]),
			event({ toState: "APPLIED" }),
			review(["Example third review"]),
		],
	});
	mount();
	fireEvent.click(screen.getByRole("button", { name: "Timeline" }));
	expect(
		await screen.findByRole("button", {
			name: "Review 1: show 3 not selected changes",
		}),
	).toHaveAttribute("aria-expanded", "false");
	const third = screen.getByRole("button", {
		name: "Review 3: show 3 not selected changes",
	});
	expect(
		screen.queryByRole("button", {
			name: "Review 2: show 3 not selected changes",
		}),
	).not.toBeInTheDocument();
	fireEvent.click(third);
	expect(screen.getByText("Example third review")).toBeInTheDocument();
	expect(screen.queryByText("Example first review")).not.toBeInTheDocument();
});
