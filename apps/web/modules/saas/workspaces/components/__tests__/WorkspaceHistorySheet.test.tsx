/**
 * The versions of a Workspace page. Each row is the page as it was before one
 * change, so its position is its version number; restoring one asks the existing
 * revert procedure for that number and nothing else.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getHistory: vi.fn(),
	revert: vi.fn(),
	toast: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		frames: { getHistory: mocks.getHistory, revert: mocks.revert },
	},
}));

vi.mock("@ui/hooks/use-toast", () => ({
	useToast: () => ({ toast: mocks.toast }),
}));

import { WorkspaceHistorySheet } from "../WorkspaceHistorySheet";

function entry(id: string, editType: string, editedAt: string) {
	return {
		id,
		editType,
		oldString: null,
		newString: null,
		editedBy: "user-1",
		editedAt,
		revertedToVersion: null,
	};
}

// Newest first, as the procedure returns them.
const history = [
	entry("e3", "revert", "2026-10-14T12:00:00.000Z"),
	entry("e2", "full_update", "2026-10-13T12:00:00.000Z"),
	entry("e1", "string_replace", "2026-10-12T12:00:00.000Z"),
];

const onOpenChange = vi.fn();
const onRestored = vi.fn();

function renderSheet(open = true) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<WorkspaceHistorySheet
				frameId="frame-1"
				organizationId="org-1"
				open={open}
				onOpenChange={onOpenChange}
				onRestored={onRestored}
			/>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getHistory.mockResolvedValue({ history });
	mocks.revert.mockResolvedValue({ success: true });
});

describe("the version history", () => {
	it("reads the history of this frame in this organization, only once it is opened", async () => {
		renderSheet(false);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(mocks.getHistory).not.toHaveBeenCalled();

		renderSheet(true);

		await screen.findByText("Page changed");
		expect(mocks.getHistory).toHaveBeenCalledWith({
			id: "frame-1",
			organizationId: "org-1",
			limit: 500,
		});
	});

	it("lists each change, newest first, in words", async () => {
		renderSheet();

		await screen.findByText("Page changed");
		const items = screen.getAllByRole("listitem");
		expect(items).toHaveLength(3);
		expect(items[0]).toHaveTextContent("Earlier version restored");
		expect(items[1]).toHaveTextContent("Page changed");
		expect(items[2]).toHaveTextContent("Text replaced");
	});

	it("restores by version number: the oldest entry is version 1", async () => {
		renderSheet();
		await screen.findByText("Page changed");

		const restoreButtons = screen.getAllByRole("button", {
			name: "Restore the page before",
		});
		// The text replacement keeps no snapshot, so it has nothing to restore.
		expect(restoreButtons).toHaveLength(2);
		fireEvent.click(restoreButtons[1]);

		await waitFor(() =>
			expect(mocks.revert).toHaveBeenCalledWith({
				id: "frame-1",
				organizationId: "org-1",
				toVersion: 2,
			}),
		);
		fireEvent.click(restoreButtons[0]);
		await waitFor(() =>
			expect(mocks.revert).toHaveBeenLastCalledWith({
				id: "frame-1",
				organizationId: "org-1",
				toVersion: 3,
			}),
		);
	});

	it("tells the page when a version is restored", async () => {
		renderSheet();
		await screen.findByText("Page changed");

		fireEvent.click(
			screen.getAllByRole("button", {
				name: "Restore the page before",
			})[0],
		);

		await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));
		expect(mocks.toast).toHaveBeenCalledWith({
			title: "Earlier version restored",
		});
	});

	it("says so, and does not tell the page, when the restore is refused", async () => {
		mocks.revert.mockResolvedValue({
			success: false,
			error: "Version 3 not found or has no snapshot",
		});
		renderSheet();
		await screen.findByText("Page changed");

		fireEvent.click(
			screen.getAllByRole("button", {
				name: "Restore the page before",
			})[0],
		);

		await waitFor(() =>
			expect(mocks.toast).toHaveBeenCalledWith(
				expect.objectContaining({
					title: "Could not restore this version",
					description: "Version 3 not found or has no snapshot",
					variant: "destructive",
				}),
			),
		);
		expect(onRestored).not.toHaveBeenCalled();
	});

	it("says so when the call itself fails", async () => {
		mocks.revert.mockRejectedValue(new Error("offline"));
		renderSheet();
		await screen.findByText("Page changed");

		fireEvent.click(
			screen.getAllByRole("button", {
				name: "Restore the page before",
			})[0],
		);

		await waitFor(() =>
			expect(mocks.toast).toHaveBeenCalledWith(
				expect.objectContaining({ variant: "destructive" }),
			),
		);
		expect(onRestored).not.toHaveBeenCalled();
	});

	it("offers no restore when the history may be cut short, since a version number would be wrong", async () => {
		mocks.getHistory.mockResolvedValue({
			history: Array.from({ length: 500 }, (_, index) =>
				entry(`e${index}`, "full_update", "2026-10-14T12:00:00.000Z"),
			),
		});
		renderSheet();

		await screen.findAllByText("Page changed");
		expect(
			screen.queryByRole("button", { name: "Restore the page before" }),
		).toBeNull();
	});

	it("explains an empty history", async () => {
		mocks.getHistory.mockResolvedValue({ history: [] });
		renderSheet();

		expect(
			await screen.findByText(/No earlier versions yet/),
		).toBeInTheDocument();
	});

	it("says so when the history cannot be read", async () => {
		mocks.getHistory.mockRejectedValue(new Error("offline"));
		renderSheet();

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"The history could not be loaded.",
		);
	});
});
