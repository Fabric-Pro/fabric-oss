/**
 * Taking a delivered newsletter's images down: the confirmation says the
 * images disappear from emails already delivered, and only confirming calls
 * the procedure. Success and failure both refresh the history row.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { unpublishMock, toastMock } = vi.hoisted(() => ({
	unpublishMock: vi.fn(),
	toastMock: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("sonner", () => ({ toast: toastMock }));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		newsletter: { sends: { images: { unpublish: unpublishMock } } },
	},
}));

import { NewsletterPublishedImagesAction } from "../NewsletterPublishedImagesAction";

const onRemoved = vi.fn();

function renderAction(imageCount = 3) {
	const queryClient = new QueryClient({
		defaultOptions: { mutations: { retry: false } },
	});
	render(
		<QueryClientProvider client={queryClient}>
			<NewsletterPublishedImagesAction
				projectId="p-1"
				organizationId={null}
				sendId="send-1"
				imageCount={imageCount}
				onRemoved={onRemoved}
			/>
		</QueryClientProvider>,
	);
}

function openConfirmation() {
	fireEvent.click(
		screen.getByRole("button", { name: /^Remove published images?$/ }),
	);
	return screen.getByRole("alertdialog");
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("NewsletterPublishedImagesAction", () => {
	it("warns that the images disappear from emails already delivered", () => {
		renderAction(3);

		const dialog = openConfirmation();

		expect(dialog.textContent).toContain("This newsletter's 3 images are");
		expect(dialog.textContent).toContain(
			"They disappear from the emails that were already delivered",
		);
		expect(unpublishMock).not.toHaveBeenCalled();
	});

	it("speaks of a single image in the singular", () => {
		renderAction(1);

		const dialog = openConfirmation();

		expect(dialog.textContent).toContain(
			"This newsletter's image is deleted from public storage. It disappears from the emails",
		);
		expect(
			within(dialog).getByRole("heading", {
				name: "Remove published image?",
			}),
		).toBeTruthy();
		expect(
			within(dialog).getByRole("button", { name: "Remove image" }),
		).toBeTruthy();
	});

	it("does nothing when the reviewer cancels", () => {
		renderAction();

		openConfirmation();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		expect(unpublishMock).not.toHaveBeenCalled();
		expect(onRemoved).not.toHaveBeenCalled();
	});

	it("removes the images on confirmation and refreshes the history", async () => {
		unpublishMock.mockResolvedValue({ removed: 3 });
		renderAction();

		openConfirmation();
		fireEvent.click(screen.getByRole("button", { name: "Remove images" }));

		await waitFor(() => expect(onRemoved).toHaveBeenCalledTimes(1));
		expect(unpublishMock).toHaveBeenCalledWith({
			projectId: "p-1",
			organizationId: null,
			sendId: "send-1",
		});
		expect(toastMock.success).toHaveBeenCalledWith(
			"3 published images removed",
		);
	});

	it("reports a partial failure and still refreshes the history", async () => {
		unpublishMock.mockRejectedValue(
			new Error("Some published images could not be removed. Try again."),
		);
		renderAction();

		openConfirmation();
		fireEvent.click(screen.getByRole("button", { name: "Remove images" }));

		await waitFor(() =>
			expect(toastMock.error).toHaveBeenCalledWith(
				"Some published images could not be removed. Try again.",
			),
		);
		expect(onRemoved).toHaveBeenCalledTimes(1);
		expect(toastMock.success).not.toHaveBeenCalled();
	});
});
