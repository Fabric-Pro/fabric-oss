import { ORPCError } from "@orpc/client";
import { QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { aiApi, renderable } from "./ai-recommended-test-utils";

vi.mock("next-intl", async (importActual) => importActual());
vi.mock("@shared/lib/orpc-query-utils", async () =>
	(await import("./ai-recommended-test-utils")).orpcQueryUtilsMock(),
);
vi.mock("@shared/lib/orpc-client", async () =>
	(await import("./ai-recommended-test-utils")).orpcClientMock(),
);
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { RemoveAiBatchDialog } from "../RemoveAiBatchDialog";

const batch = {
	batchId: "batch-1",
	createdAt: new Date("2026-09-01T12:00:00.000Z"),
	eligibleCount: 3,
	editedEligibleCount: 2,
	protectedCount: 1,
	awaitingApprovalCount: 1,
};

function item(id: string, edited = false) {
	return { id, identifier: `F-${id}`, title: `Title ${id}`, edited };
}

const preview = {
	eligible: [item("1", true), item("2", true), item("3")],
	protected: [{ id: "p", identifier: "F-p", title: "Kept" }],
	awaitingApproval: [{ id: "r", identifier: "F-r", title: "Pending" }],
	editedEligibleCount: 2,
	governedReview: false,
};

function counts(overrides: Record<string, number> = {}) {
	return {
		moved: 0,
		requested: 0,
		alreadyRequested: 0,
		skippedProtected: 0,
		skippedIneligible: 0,
		failed: 0,
		notPreviewed: 0,
		...overrides,
	};
}

async function openPreview(queryClient?: QueryClient) {
	const user = userEvent.setup();
	render(
		renderable(
			<RemoveAiBatchDialog projectId="project-1" onClose={vi.fn()} />,
			queryClient,
		),
	);
	await user.click(
		await screen.findByRole("radio", {
			name: /Recommended Sep 1, 2026 · 3 items/,
		}),
	);
	await user.click(screen.getByRole("button", { name: "Review batch" }));
	await screen.findByText("F-1");
	return user;
}

describe("RemoveAiBatchDialog", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		aiApi.listBatches.mockResolvedValue({ batches: [batch] });
		aiApi.previewBatch.mockResolvedValue(preview);
	});

	it("lists each batch with its date, size and the counts that matter", async () => {
		render(
			renderable(
				<RemoveAiBatchDialog projectId="project-1" onClose={vi.fn()} />,
			),
		);
		expect(
			await screen.findByText("Recommended Sep 1, 2026 · 3 items"),
		).toBeInTheDocument();
		expect(
			screen.getByText("1 protected · 2 edited · 1 awaiting approval"),
		).toBeInTheDocument();
		expect(aiApi.listBatches).toHaveBeenCalledWith({
			projectId: "project-1",
		});
	});

	it("explains an empty picker with the capability reason", async () => {
		aiApi.listBatches.mockResolvedValue({ batches: [] });
		render(
			renderable(
				<RemoveAiBatchDialog projectId="project-1" onClose={vi.fn()} />,
			),
		);
		expect(
			await screen.findByText("No AI-recommended batch to remove"),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Review batch" }),
		).toBeDisabled();
	});

	it("previews the batch: skipped protected items, awaiting approval, the FR30 warning and the governed notice", async () => {
		aiApi.previewBatch.mockResolvedValue({
			...preview,
			governedReview: true,
		});
		await openPreview();

		expect(aiApi.previewBatch).toHaveBeenCalledWith({
			projectId: "project-1",
			batchId: "batch-1",
		});
		expect(
			screen.getByText("1 protected item will be skipped"),
		).toBeInTheDocument();
		expect(
			screen.getByText("1 item is already waiting for approval"),
		).toBeInTheDocument();

		const warning = screen.getByRole("alert");
		expect(warning).toHaveTextContent(
			"Warning: This batch includes 2 provisional items that were edited after creation. Review them before moving the batch to backlog.",
		);

		expect(
			screen.getByText(
				"This project requires approval for stage changes. Each item becomes an approval request instead of moving right away, and replaces any request already pending on it.",
			),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				"Items are hidden from the Roadmap, not deleted. Linked work items in your PM tool are not changed.",
			),
		).toBeInTheDocument();
		// Governed: each item becomes an approval request, and the confirm says so.
		expect(
			screen.getByRole("button", { name: "Request hiding 3 items" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Hide 3 items" }),
		).toBeNull();
	});

	it("describes the preview step and moves focus to the heading on each step change", async () => {
		const user = await openPreview();

		const dialog = screen.getByRole("dialog");
		expect(dialog).toHaveAccessibleDescription(
			"These items will be hidden from the Roadmap:",
		);
		expect(
			screen.getByRole("heading", {
				name: "Remove AI Recommended Items",
			}),
		).toHaveFocus();

		await user.click(screen.getByRole("button", { name: "Back" }));
		await screen.findByRole("radio");
		expect(
			screen.getByRole("heading", {
				name: "Remove AI Recommended Items",
			}),
		).toHaveFocus();
	});

	it("ignores Esc and the X while the removal runs, then focuses Close on the result", async () => {
		let finish: (value: unknown) => void = () => {};
		aiApi.removeBatch.mockReturnValue(
			new Promise((resolve) => {
				finish = resolve;
			}),
		);
		const onClose = vi.fn();
		const user = userEvent.setup();
		render(
			renderable(
				<RemoveAiBatchDialog projectId="project-1" onClose={onClose} />,
			),
		);
		await screen.findByRole("radio");
		await user.click(screen.getByRole("button", { name: "Review batch" }));
		await screen.findByText("F-1");

		await user.click(screen.getByRole("button", { name: "Hide 3 items" }));
		await screen.findByRole("button", { name: "Hiding…" });
		await user.keyboard("{Escape}");
		// The X is the dialog's only other control named Close.
		await user.click(screen.getByRole("button", { name: "Close" }));
		expect(onClose).not.toHaveBeenCalled();

		finish({
			results: [],
			counts: counts({ moved: 3 }),
			governedReview: false,
		});
		await screen.findByText("Batch removal finished");
		expect(screen.getByRole("dialog")).toHaveAccessibleDescription(
			"Batch removal finished",
		);
		// The footer Close, not the X (which is rendered after the content).
		const [footerClose] = screen.getAllByRole("button", { name: "Close" });
		expect(footerClose).toHaveAttribute("data-slot", "button");
		expect(footerClose).toHaveFocus();

		await user.keyboard("{Escape}");
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("sends exactly the previewed eligible ids and announces an itemized result", async () => {
		aiApi.removeBatch.mockResolvedValue({
			results: [
				{
					storyId: "1",
					identifier: "F-1",
					title: "T",
					outcome: "moved",
				},
				{
					storyId: "2",
					identifier: "F-2",
					title: "T",
					outcome: "failed",
					error: "This feature is not ready",
				},
				{
					storyId: "3",
					identifier: "F-3",
					title: "T",
					outcome: "skipped-protected",
				},
			],
			counts: counts({ moved: 1, failed: 1, skippedProtected: 1 }),
			governedReview: false,
		});
		const user = await openPreview();

		await user.click(screen.getByRole("button", { name: "Hide 3 items" }));

		await waitFor(() =>
			expect(aiApi.removeBatch).toHaveBeenCalledWith({
				projectId: "project-1",
				batchId: "batch-1",
				expectedStoryIds: ["1", "2", "3"],
			}),
		);
		const live = await screen.findByText(
			"1 hidden · 0 sent for approval · 1 skipped · 1 failed",
		);
		expect(live.closest("[aria-live='polite']")).not.toBeNull();
		const failures = screen.getByText("These items could not be hidden:")
			.parentElement as HTMLElement;
		expect(within(failures).getByText("F-2")).toBeInTheDocument();
		expect(failures).toHaveTextContent("This feature is not ready");
	});

	it("drops the cached removal preview once a removal settles", async () => {
		aiApi.removeBatch.mockResolvedValue({
			results: [],
			counts: counts({ moved: 3 }),
			governedReview: false,
		});
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const invalidate = vi.spyOn(queryClient, "invalidateQueries");
		const user = await openPreview(queryClient);

		await user.click(screen.getByRole("button", { name: "Hide 3 items" }));

		await waitFor(() =>
			expect(invalidate).toHaveBeenCalledWith({
				queryKey: ["projects.aiRecommended.previewBatch"],
			}),
		);
	});

	it("explains a NO_ELIGIBLE_ITEMS refusal from its counts", async () => {
		aiApi.removeBatch.mockRejectedValue(
			new ORPCError("PRECONDITION_FAILED", {
				message: "No eligible items to remove",
				data: {
					reason: "NO_ELIGIBLE_ITEMS",
					protectedCount: 1,
					alreadyRequestedCount: 2,
					ineligibleCount: 0,
				},
			}),
		);
		const user = await openPreview();

		await user.click(screen.getByRole("button", { name: "Hide 3 items" }));

		expect(
			await screen.findByText(
				"Nothing in this batch can be removed now: 1 protected, 2 already waiting for approval, 0 already hidden or changed since the preview.",
			),
		).toBeInTheDocument();
	});

	it("never calls the door for a preview with nothing eligible", async () => {
		aiApi.previewBatch.mockResolvedValue({
			...preview,
			eligible: [],
			editedEligibleCount: 0,
		});
		const user = userEvent.setup();
		render(
			renderable(
				<RemoveAiBatchDialog projectId="project-1" onClose={vi.fn()} />,
			),
		);
		await screen.findByRole("radio");
		await user.click(screen.getByRole("button", { name: "Review batch" }));

		// Before any removal there is nothing "changed since the preview".
		expect(
			await screen.findByText(
				"Nothing in this batch can be removed now: 1 protected, 1 already waiting for approval.",
			),
		).toBeInTheDocument();
		expect(screen.getByRole("dialog")).toHaveAccessibleDescription(
			/Nothing in this batch can be removed now/,
		);
		expect(
			screen.getByRole("button", { name: "Hide 0 items" }),
		).toBeDisabled();
		expect(aiApi.removeBatch).not.toHaveBeenCalled();
	});
});
