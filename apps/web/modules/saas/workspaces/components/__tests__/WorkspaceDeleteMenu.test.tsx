/**
 * Deleting a Workspace: only its author is offered it, the page is named and
 * what goes with it is said, and the author is taken back to the list.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	deleteFrame: vi.fn(),
	push: vi.fn(),
	toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { frames: { delete: mocks.deleteFrame } },
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: mocks.push }),
}));

vi.mock("sonner", () => ({ toast: mocks.toast }));

import { FabricToolError } from "@saas/mcp/lib/fabric-tool-client";
import { WorkspaceDeleteMenu } from "../WorkspaceDeleteMenu";

function renderMenu() {
	const client = new QueryClient({
		defaultOptions: { mutations: { retry: false } },
	});
	const invalidate = vi.spyOn(client, "invalidateQueries");
	render(
		<QueryClientProvider client={client}>
			<WorkspaceDeleteMenu
				frameId="frame-1"
				title="Delivery status"
				organizationId="org-1"
				organizationSlug="example-org"
			/>
		</QueryClientProvider>,
	);
	return { invalidate };
}

async function openConfirmation() {
	await userEvent.click(screen.getByRole("button", { name: "More actions" }));
	await userEvent.click(
		screen.getByRole("menuitem", { name: "Delete workspace" }),
	);
	return screen.findByRole("alertdialog");
}

const confirmButton = () =>
	screen.getByRole("button", { name: /^(Delete workspace|Deleting\.\.\.)$/ });

beforeEach(() => {
	vi.clearAllMocks();
	mocks.deleteFrame.mockResolvedValue({ success: true });
});

describe("asking before deleting", () => {
	it("offers Delete workspace under More, and deletes nothing until asked to", async () => {
		renderMenu();

		await userEvent.click(
			screen.getByRole("button", { name: "More actions" }),
		);

		expect(
			screen.getByRole("menuitem", { name: "Delete workspace" }),
		).toBeInTheDocument();
		expect(mocks.deleteFrame).not.toHaveBeenCalled();
	});

	it("names the page and says its data, files and comments go with it", async () => {
		renderMenu();

		const dialog = await openConfirmation();

		expect(dialog).toHaveTextContent("Delete “Delivery status”?");
		expect(dialog).toHaveTextContent("data, files and comments");
		expect(dialog).toHaveTextContent("cannot be undone");
		expect(mocks.deleteFrame).not.toHaveBeenCalled();
	});

	it("deletes nothing when the author cancels", async () => {
		renderMenu();
		await openConfirmation();

		await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

		expect(mocks.deleteFrame).not.toHaveBeenCalled();
		expect(mocks.push).not.toHaveBeenCalled();
	});
});

describe("deleting", () => {
	it("deletes the page in its organization, says so, refreshes the lists and goes back to the Workspaces list", async () => {
		const { invalidate } = renderMenu();
		await openConfirmation();

		await userEvent.click(confirmButton());

		await waitFor(() =>
			expect(mocks.push).toHaveBeenCalledWith(
				"/app/example-org/workspaces",
			),
		);
		expect(mocks.deleteFrame).toHaveBeenCalledWith({
			id: "frame-1",
			organizationId: "org-1",
		});
		expect(mocks.toast.success).toHaveBeenCalledWith("Workspace deleted");
		expect(invalidate).toHaveBeenCalledWith({ queryKey: ["fabric-tool"] });
		expect(invalidate).toHaveBeenCalledWith({ queryKey: ["frames"] });
	});

	it("stays on the page and says it could not be deleted, without a tool id or HTTP status, when it fails", async () => {
		mocks.deleteFrame.mockRejectedValue(
			new FabricToolError("frames.delete failed with HTTP 500", "frames"),
		);
		renderMenu();
		await openConfirmation();

		await userEvent.click(confirmButton());

		await waitFor(() =>
			expect(mocks.toast.error).toHaveBeenCalledWith(
				"Could not delete this workspace",
				{ description: "Please try again." },
			),
		);
		expect(mocks.push).not.toHaveBeenCalled();
		expect(mocks.toast.success).not.toHaveBeenCalled();
	});

	it("is not closed by Esc while the delete is under way", async () => {
		mocks.deleteFrame.mockReturnValue(new Promise(() => {}));
		renderMenu();
		await openConfirmation();

		await userEvent.click(confirmButton());
		await waitFor(() => expect(mocks.deleteFrame).toHaveBeenCalled());
		fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
		await new Promise((resolve) => setTimeout(resolve, 30));

		expect(screen.getByRole("alertdialog")).toBeInTheDocument();
		expect(confirmButton()).toBeDisabled();
		expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
	});
});
