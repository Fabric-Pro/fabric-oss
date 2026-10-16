/**
 * The list of agent-written pages both surfaces draw: a loading placeholder, an
 * error with a retry, an empty state, and a card each. What differs between
 * the surfaces - names, where a card leads, what the empty state offers - comes
 * in as props.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { FrameCollection } from "@saas/frames/components/FrameCollection";
import type { FrameSummary } from "@saas/frames/lib/frame-tool-types";

const frames: FrameSummary[] = [
	{
		frameId: "frame-1",
		title: "Delivery status",
		description: "Open work by status.",
		kind: "frame",
		updatedAt: "2026-10-14T09:00:00.000Z",
	},
	{
		frameId: "frame-2",
		title: "Decisions board",
		kind: "frame",
		updatedAt: "2026-10-13T09:00:00.000Z",
	},
];

const empty = {
	icon: <svg data-testid="empty-icon" />,
	title: "Nothing yet",
	description: "Ask for one.",
	action: <button type="button">Ask</button>,
};

function collection(
	query: Partial<React.ComponentProps<typeof FrameCollection>["query"]>,
	props: Partial<React.ComponentProps<typeof FrameCollection>> = {},
) {
	return render(
		<FrameCollection
			query={{
				isLoading: false,
				isError: false,
				refetch: vi.fn(),
				...query,
			}}
			cardLabel="Thing"
			loadingLabel="Loading things"
			errorMessage="The things could not be loaded."
			empty={empty}
			cardTarget={(frame) => ({ href: `/things/${frame.frameId}` })}
			{...props}
		/>,
	);
}

describe("FrameCollection", () => {
	it("shows a labelled placeholder while the list is read, and nothing else", () => {
		collection({ isLoading: true });

		expect(
			screen.getByRole("status", { name: "Loading things" }),
		).toBeInTheDocument();
		expect(screen.queryByText("Nothing yet")).toBeNull();
		expect(screen.queryByRole("list")).toBeNull();
	});

	it("says what failed and retries on request", () => {
		const refetch = vi.fn();
		collection({ isError: true, refetch });

		expect(screen.getByRole("alert")).toHaveTextContent(
			"The things could not be loaded.",
		);
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(refetch).toHaveBeenCalledTimes(1);
	});

	it("shows the empty state, with its one action, when there is nothing", () => {
		collection({ data: { frames: [] } });

		expect(screen.getByText("Nothing yet")).toBeInTheDocument();
		expect(screen.getByText("Ask for one.")).toBeInTheDocument();
		expect(screen.getByTestId("empty-icon")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Ask" })).toBeInTheDocument();
		expect(screen.queryByRole("list")).toBeNull();
	});

	it("leaves the action out of the empty state when there is none to offer", () => {
		collection(
			{ data: { frames: [] } },
			{ empty: { ...empty, action: undefined } },
		);

		expect(screen.queryByRole("button", { name: "Ask" })).toBeNull();
		expect(screen.getByText("Nothing yet")).toBeInTheDocument();
	});

	it("treats a list not read yet as empty rather than failing", () => {
		collection({ data: undefined });

		expect(screen.getByText("Nothing yet")).toBeInTheDocument();
	});

	it("draws a card for each page, labelled and linked where the surface says", () => {
		collection({ data: { frames } });

		const cards = screen.getAllByRole("listitem");
		expect(cards).toHaveLength(2);
		const first = within(cards[0]).getByRole("link");
		expect(first).toHaveAttribute("href", "/things/frame-1");
		expect(within(first).getByText("Thing")).toBeInTheDocument();
		expect(
			within(first).getByRole("heading", { name: "Delivery status" }),
		).toBeInTheDocument();
		expect(
			within(cards[1]).getByText("No description yet."),
		).toBeInTheDocument();
	});

	it("opens a card in the list when the surface says so", () => {
		const onOpen = vi.fn();
		collection(
			{ data: { frames } },
			{
				cardTarget: (frame) => ({
					onOpen: () => onOpen(frame.frameId),
				}),
			},
		);

		fireEvent.click(
			screen.getByRole("button", { name: /Decisions board/ }),
		);

		expect(onOpen).toHaveBeenCalledWith("frame-2");
	});

	it("puts the surface's badges on each card and its tour anchor on the list", () => {
		const { container } = collection(
			{ data: { frames } },
			{
				cardBadges: (frame) => <span>badge {frame.frameId}</span>,
				"data-onboarding-target": "things-list",
			},
		);

		expect(screen.getByText("badge frame-1")).toBeInTheDocument();
		expect(screen.getByText("badge frame-2")).toBeInTheDocument();
		expect(
			container.querySelector('[data-onboarding-target="things-list"]'),
		).not.toBeNull();
	});
});
