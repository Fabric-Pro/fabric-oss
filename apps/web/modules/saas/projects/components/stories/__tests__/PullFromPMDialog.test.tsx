import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listPMTickets = vi.fn();

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			stories: {
				listPMTickets: (...args: unknown[]) => listPMTickets(...args),
			},
		},
	},
}));

import { PullFromPMDialog } from "../PullFromPMDialog";

// Basic ResizeObserver + pointer mocks for Radix primitives under jsdom.
if (!(globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver) {
	(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		};
}
if (!Element.prototype.hasPointerCapture) {
	Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.scrollIntoView) {
	Element.prototype.scrollIntoView = () => {};
}

function baseResponse(
	overrides: Partial<{
		tickets: { id: string; displayId: string; title: string }[];
		total: number;
		totalOnBoard: number;
		alreadySynced: number;
		notes: { kind: "already_imported"; id: number }[];
		errors: { kind: "not_found" | "wrong_board"; id: number }[];
	}> = {},
) {
	return {
		tickets: overrides.tickets ?? [],
		total: overrides.total ?? 0,
		totalOnBoard: overrides.totalOnBoard ?? 0,
		alreadySynced: overrides.alreadySynced ?? 0,
		page: 1,
		pageSize: 20,
		hasNextPage: false,
		notes: overrides.notes ?? [],
		errors: overrides.errors ?? [],
	};
}

function renderDialog() {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return render(
		<QueryClientProvider client={client}>
			<PullFromPMDialog
				open
				onClose={() => {}}
				onConfirm={() => {}}
				projectId="project_1"
				organizationId={null}
				pmToolName="Azure DevOps"
			/>
		</QueryClientProvider>,
	);
}

async function applyTicketIds(
	user: ReturnType<typeof userEvent.setup>,
	ids: string,
) {
	const textarea = screen.getByLabelText(/ticket ids/i);
	await user.click(textarea);
	await user.keyboard(ids);
	await user.click(screen.getByRole("button", { name: /^apply$/i }));
}

describe("PullFromPMDialog — filters", () => {
	beforeEach(() => {
		listPMTickets.mockReset();
	});

	afterEach(() => {
		cleanup();
	});

	it("disables Apply while a syntax error is present and does not fire a request on typing", async () => {
		listPMTickets.mockResolvedValue(baseResponse());
		const user = userEvent.setup();
		renderDialog();

		const textarea = screen.getByLabelText(/ticket ids/i);
		await user.click(textarea);
		await user.keyboard("abc");

		// Inline error visible.
		expect(screen.getByText(/ids must be numeric/i)).toBeInTheDocument();

		// Apply disabled.
		const apply = screen.getByRole("button", { name: /^apply$/i });
		expect(apply).toBeDisabled();

		// Typing did not fire new requests.
		expect(listPMTickets).not.toHaveBeenCalled();
	});

	it("Clear filters resets the ID field and removes filters", async () => {
		listPMTickets.mockResolvedValue(baseResponse());
		const user = userEvent.setup();
		renderDialog();

		// Enter IDs and apply.
		const textarea = screen.getByLabelText(
			/ticket ids/i,
		) as HTMLTextAreaElement;
		await user.click(textarea);
		await user.keyboard("417");

		const apply = screen.getByRole("button", { name: /^apply$/i });
		await user.click(apply);

		await waitFor(() => {
			const lastCall = listPMTickets.mock.calls.at(-1);
			expect(lastCall?.[0]?.filters).toMatchObject({ ids: [417] });
		});
		const callCountAfterApply = listPMTickets.mock.calls.length;

		const clear = await screen.findByRole("button", {
			name: /clear filters/i,
		});
		await user.click(clear);

		// Clearing disables the filtered query until the user searches or
		// applies IDs again.
		expect(listPMTickets.mock.calls.length).toBe(callCountAfterApply);

		expect(textarea.value).toBe("");
	});

	it("renders a FILTERS editorial label above the ticket search", async () => {
		listPMTickets.mockResolvedValue(baseResponse());
		renderDialog();
		const label = screen.getByText(/^filters$/i);
		expect(label).toHaveClass("editorial-label");
	});

	it("blocks Apply on over-cap expansion (201 IDs)", async () => {
		listPMTickets.mockResolvedValue(baseResponse());
		const user = userEvent.setup();
		renderDialog();

		const textarea = screen.getByLabelText(/ticket ids/i);
		await user.click(textarea);
		await user.paste("1-201");

		expect(await screen.findByText(/at most 200 ids/i)).toBeInTheDocument();
		const apply = screen.getByRole("button", { name: /^apply$/i });
		expect(apply).toBeDisabled();
	});
});

describe("PullFromPMDialog — notes & issues regions (Group 6)", () => {
	beforeEach(() => {
		listPMTickets.mockReset();
	});

	afterEach(() => {
		cleanup();
	});

	it("renders an already-imported ID as a note and omits it from the ticket list (AC-9)", async () => {
		listPMTickets.mockResolvedValue(
			baseResponse({
				tickets: [
					{ id: "419", displayId: "419", title: "Valid ticket" },
				],
				total: 1,
				totalOnBoard: 2,
				alreadySynced: 1,
				notes: [{ kind: "already_imported", id: 417 }],
			}),
		);
		const user = userEvent.setup();
		renderDialog();

		await applyTicketIds(user, "417,419");

		await waitFor(() => {
			expect(listPMTickets).toHaveBeenCalled();
		});

		expect(
			await screen.findByText(/1 already imported .*#417/i),
		).toBeInTheDocument();
		// A valid ticket from the response still renders.
		expect(screen.getByText("Valid ticket")).toBeInTheDocument();
	});

	it("renders not-found IDs in the issues region while valid IDs still import (AC-4)", async () => {
		listPMTickets.mockResolvedValue(
			baseResponse({
				tickets: [
					{ id: "419", displayId: "419", title: "Valid imported" },
				],
				total: 1,
				totalOnBoard: 10,
				errors: [{ kind: "not_found", id: 9999 }],
			}),
		);
		const user = userEvent.setup();
		renderDialog();

		await applyTicketIds(user, "419,9999");

		await waitFor(() => {
			expect(listPMTickets).toHaveBeenCalled();
		});

		const issue = await screen.findByText(/1 not found .*#9999/i);
		expect(issue).toBeInTheDocument();
		// Issues region uses role="alert".
		expect(issue.closest('[role="alert"]')).not.toBeNull();
		// Valid ticket is still imported / visible.
		expect(screen.getByText("Valid imported")).toBeInTheDocument();
	});

	it("renders a wrong-board ID with the 'not found on this board' copy", async () => {
		listPMTickets.mockResolvedValue(
			baseResponse({
				errors: [{ kind: "wrong_board", id: 432 }],
			}),
		);
		const user = userEvent.setup();
		renderDialog();

		await applyTicketIds(user, "432");

		await waitFor(() => {
			expect(listPMTickets).toHaveBeenCalled();
		});

		expect(
			await screen.findByText(/1 not on board .*#432/i),
		).toBeInTheDocument();
	});
});

describe("PullFromPMDialog — nothing new to pull (FR44, FR45)", () => {
	beforeEach(() => {
		listPMTickets.mockReset();
	});

	afterEach(() => {
		cleanup();
	});

	function renderNothingNew(
		props: Partial<Parameters<typeof PullFromPMDialog>[0]> = {},
	) {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const onClose = vi.fn();
		const onContinue = vi.fn();
		render(
			<QueryClientProvider client={client}>
				<PullFromPMDialog
					open
					onClose={onClose}
					onConfirm={() => {}}
					projectId="project_1"
					organizationId={null}
					pmToolName="Azure DevOps"
					detectNothingNew
					onContinueWithNothingNew={onContinue}
					{...props}
				/>
			</QueryClientProvider>,
		);
		return { onClose, onContinue };
	}

	it("says there is nothing new instead of an empty picker", async () => {
		listPMTickets.mockResolvedValue(
			baseResponse({ total: 0, totalOnBoard: 12, alreadySynced: 12 }),
		);
		renderNothingNew();
		expect(await screen.findByText("title")).toBeInTheDocument();
		expect(screen.getByText("body")).toBeInTheDocument();
		// The board-wide read: no search, no filters.
		expect(listPMTickets).toHaveBeenCalledWith(
			expect.objectContaining({ projectId: "project_1", page: 1 }),
		);
		expect(listPMTickets.mock.calls[0]?.[0]).not.toHaveProperty("search");
		expect(
			screen.queryByRole("button", { name: /pull selected/i }),
		).toBeNull();
	});

	it("Do both: Continue goes on to recommendations, Close just closes", async () => {
		listPMTickets.mockResolvedValue(baseResponse({ total: 0 }));
		const user = userEvent.setup();
		const { onClose, onContinue } = renderNothingNew();
		await user.click(
			await screen.findByRole("button", { name: "continue" }),
		);
		expect(onContinue).toHaveBeenCalledTimes(1);
		await user.click(screen.getByRole("button", { name: "close" }));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("outside Do both there is only Close", async () => {
		listPMTickets.mockResolvedValue(baseResponse({ total: 0 }));
		renderNothingNew({ onContinueWithNothingNew: undefined });
		expect(
			await screen.findByRole("button", { name: "close" }),
		).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "continue" })).toBeNull();
	});

	it("keeps the picker when there is something new", async () => {
		listPMTickets.mockResolvedValue(
			baseResponse({ total: 3, totalOnBoard: 3 }),
		);
		renderNothingNew();
		await waitFor(() => expect(listPMTickets).toHaveBeenCalled());
		expect(screen.queryByText("title")).toBeNull();
		expect(
			screen.getByRole("button", { name: /pull selected/i }),
		).toBeInTheDocument();
	});

	it("does not read the whole board unless asked", () => {
		listPMTickets.mockResolvedValue(baseResponse());
		renderNothingNew({ detectNothingNew: false });
		expect(listPMTickets).not.toHaveBeenCalled();
	});
});
