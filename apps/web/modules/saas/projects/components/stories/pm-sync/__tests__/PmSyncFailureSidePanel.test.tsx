import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import * as axeMatchers from "vitest-axe/matchers";
import { PmSyncFailureSidePanel } from "../PmSyncFailureSidePanel";

expect.extend(axeMatchers);

const baseProps = {
	open: true,
	onOpenChange: () => {},
	pmToolName: "Fizzy",
	error: "Connection refused: PM endpoint unreachable",
	attemptedAt: new Date("2026-04-30T12:00:00Z"),
	onRetry: () => {},
};

describe("PmSyncFailureSidePanel", () => {
	it("renders the failure heading, error body, and retry action", () => {
		render(<PmSyncFailureSidePanel {...baseProps} />);

		expect(
			screen.getByRole("dialog", { name: "Sync failed" }),
		).toBeInTheDocument();
		expect(
			screen.getByText("Connection refused: PM endpoint unreachable"),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /Retry sync/ }),
		).toBeInTheDocument();
	});

	it("renders the humanized error summary verbatim without re-transforming it", () => {
		// `error` arrives already humanized by `humanizePmSyncError` at write
		// time (a prose guidance sentence + parenthesized original). The panel
		// must surface that human-readable summary as-is and must not expose a
		// raw stack trace or re-derive its own message.
		const humanizedError =
			"This project's Jira board is on an Atlassian site your current connection can't reach. Open the project's Settings → Project Management and re-select a board on a site you have access to. (Original error: Cloud id f4f670d4 isn't explicitly granted by the user.)";
		render(
			<PmSyncFailureSidePanel {...baseProps} error={humanizedError} />,
		);

		expect(screen.getByText(humanizedError)).toBeInTheDocument();
	});

	it("truncates errors longer than 500 characters", () => {
		const longError = `${"x".repeat(550)}`;
		render(<PmSyncFailureSidePanel {...baseProps} error={longError} />);

		const block = screen.getByText((_, node) =>
			(node?.textContent ?? "").startsWith("xxxx"),
		);
		expect(block.textContent ?? "").toHaveLength(501);
		expect(block.textContent?.endsWith("…")).toBe(true);
	});

	it("falls back to placeholder when error is missing", () => {
		render(<PmSyncFailureSidePanel {...baseProps} error={null} />);

		expect(
			screen.getByText("No error details available."),
		).toBeInTheDocument();
	});

	it("invokes onRetry when retry is clicked", async () => {
		const onRetry = vi.fn();
		const user = userEvent.setup();
		render(<PmSyncFailureSidePanel {...baseProps} onRetry={onRetry} />);

		await user.click(screen.getByRole("button", { name: /Retry sync/ }));
		expect(onRetry).toHaveBeenCalledTimes(1);
	});

	it("disables retry while a retry is in flight", () => {
		render(<PmSyncFailureSidePanel {...baseProps} isRetrying />);

		expect(
			screen.getByRole("button", { name: /Retry sync/ }),
		).toBeDisabled();
	});

	it("never renders a PM-tool link in a failure state (the link only shows on success, elsewhere)", () => {
		render(
			<PmSyncFailureSidePanel
				{...baseProps}
				error={'Resource not found: {"status":404,"error":"Not Found"}'}
				onUnlinkRecreate={vi.fn()}
			/>,
		);

		expect(
			screen.queryByRole("link", { name: /View in/i }),
		).not.toBeInTheDocument();
	});

	it("for a deleted-card 404: a generic 'Sync failed' that shows the 404 inside, and Retry re-creates under the hood", async () => {
		const onRetry = vi.fn();
		const onUnlinkRecreate = vi.fn();
		const user = userEvent.setup();
		render(
			<PmSyncFailureSidePanel
				{...baseProps}
				error={'Resource not found: {"status":404,"error":"Not Found"}'}
				onRetry={onRetry}
				onUnlinkRecreate={onUnlinkRecreate}
			/>,
		);

		// Generic failure title — NOT a separate "PM card missing" dialog/chip.
		expect(
			screen.getByRole("dialog", { name: "Sync failed" }),
		).toBeInTheDocument();
		expect(screen.queryByText("PM card missing")).not.toBeInTheDocument();
		// The 404 detail is shown INSIDE the panel (not suppressed).
		expect(screen.getByText(/Resource not found/i)).toBeInTheDocument();
		// The description explains the deleted card + that retry re-creates it.
		expect(screen.getByText(/no longer exists/i)).toBeInTheDocument();
		expect(screen.getByText(/re-create it/i)).toBeInTheDocument();
		// One Retry button, no separate "Unlink" button, no PM-tool link.
		expect(
			screen.queryByRole("button", { name: /Unlink/i }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("link", { name: /View in/i }),
		).not.toBeInTheDocument();

		// The single Retry re-creates (not a plain retry).
		await user.click(screen.getByRole("button", { name: /Retry sync/ }));
		expect(onUnlinkRecreate).toHaveBeenCalledTimes(1);
		expect(onRetry).not.toHaveBeenCalled();
	});

	it("a generic (non-missing) failure: Retry does a plain retry, not a re-create", async () => {
		const onRetry = vi.fn();
		const onUnlinkRecreate = vi.fn();
		const user = userEvent.setup();
		render(
			<PmSyncFailureSidePanel
				{...baseProps}
				error="Connection refused: PM endpoint unreachable"
				onRetry={onRetry}
				onUnlinkRecreate={onUnlinkRecreate}
			/>,
		);

		await user.click(screen.getByRole("button", { name: /Retry sync/ }));
		expect(onRetry).toHaveBeenCalledTimes(1);
		expect(onUnlinkRecreate).not.toHaveBeenCalled();
	});

	it("for a 'different PM tool' (mismatch) error: the primary action is 'Push & relink' (calls onRelink, not Retry)", async () => {
		const onRetry = vi.fn();
		const onRelink = vi.fn();
		const user = userEvent.setup();
		render(
			<PmSyncFailureSidePanel
				{...baseProps}
				error="This item is synced to a different PM tool. Switch back to the original tool, or unlink the item to push it to the current tool."
				onRetry={onRetry}
				onRelink={onRelink}
			/>,
		);

		// A plain Retry can't clear a mismatch — the CTA is "Push & relink".
		expect(
			screen.queryByRole("button", { name: /Retry sync/i }),
		).not.toBeInTheDocument();
		// The phrase appears in both the guidance copy and the raw error block.
		expect(
			screen.getAllByText(/different PM tool/i).length,
		).toBeGreaterThan(0);
		await user.click(
			screen.getByRole("button", { name: /Push & relink/i }),
		);
		expect(onRelink).toHaveBeenCalledTimes(1);
		expect(onRetry).not.toHaveBeenCalled();
	});

	it("for a create that may have landed unlinked: the primary action is an explicit 'Unlink & re-create'", async () => {
		// The backend refuses every create while the item's create claim is
		// held, so a plain Retry would only fail again (Fizzy #3045). The
		// quoted transport error must not turn this into the 404 flow.
		const onRetry = vi.fn();
		const onUnlinkRecreate = vi.fn();
		const user = userEvent.setup();
		render(
			<PmSyncFailureSidePanel
				{...baseProps}
				error="The create request to fizzy got no definite answer (HTTP 404 from proxy), so a fizzy item may already exist for this item. Check fizzy; if there is none, use Unlink & re-create."
				onRetry={onRetry}
				onUnlinkRecreate={onUnlinkRecreate}
			/>,
		);

		expect(
			screen.getByText(/may already have this item/i),
		).toBeInTheDocument();
		expect(screen.queryByText(/no longer exists/i)).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /Retry sync/i }),
		).not.toBeInTheDocument();
		await user.click(
			screen.getByRole("button", { name: /Unlink & re-create/i }),
		);
		expect(onUnlinkRecreate).toHaveBeenCalledTimes(1);
		expect(onRetry).not.toHaveBeenCalled();
	});

	it("for a legacy link to another PM tool: the primary action is 'Unlink & re-create', not 'Push & relink'", async () => {
		// The backend never replaces an unstamped link on its own, and a
		// migrate push cannot replace it either; only Unlink & re-create can.
		// The message also says "different PM tool", which alone would offer
		// Push & relink.
		const onRetry = vi.fn();
		const onRelink = vi.fn();
		const onUnlinkRecreate = vi.fn();
		const user = userEvent.setup();
		render(
			<PmSyncFailureSidePanel
				{...baseProps}
				error="This item is linked to a ticket in a different PM tool, so Fabric did not create a new one in fizzy. To make a new ticket in fizzy, use Unlink & re-create (the old ticket is not deleted)."
				onRetry={onRetry}
				onRelink={onRelink}
				onUnlinkRecreate={onUnlinkRecreate}
			/>,
		);

		expect(
			screen.getByText(/won't replace it on its own/i),
		).toBeInTheDocument();
		expect(
			screen.queryByText(/may already have this item/i),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /Push & relink/i }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /Retry sync/i }),
		).not.toBeInTheDocument();
		await user.click(
			screen.getByRole("button", { name: /Unlink & re-create/i }),
		);
		expect(onUnlinkRecreate).toHaveBeenCalledTimes(1);
		expect(onRelink).not.toHaveBeenCalled();
		expect(onRetry).not.toHaveBeenCalled();
	});

	describe("Link to existing item", () => {
		const UNCONFIRMED =
			"The create request to fizzy got no definite answer (timed out), so a fizzy item may already exist for this item. Check fizzy; if there is none, use Unlink & re-create.";

		it("is offered beside Unlink & re-create for an unconfirmed create, and links the named item", async () => {
			const onLinkExisting = vi.fn().mockResolvedValue({ linked: true });
			const onOpenChange = vi.fn();
			const onUnlinkRecreate = vi.fn();
			const user = userEvent.setup();
			render(
				<PmSyncFailureSidePanel
					{...baseProps}
					error={UNCONFIRMED}
					onOpenChange={onOpenChange}
					onUnlinkRecreate={onUnlinkRecreate}
					onLinkExisting={onLinkExisting}
				/>,
			);

			expect(
				screen.getByText(
					/if the item is there, Link to existing item/i,
				),
			).toBeInTheDocument();
			expect(
				screen.getByRole("button", { name: /Unlink & re-create/i }),
			).toBeInTheDocument();
			await user.click(
				screen.getByRole("button", { name: /Link to existing item/i }),
			);
			const field = await screen.findByLabelText("Fizzy item ID or key");
			await waitFor(() => expect(field).toHaveFocus());
			await user.type(field, " 1234 ");
			await user.click(screen.getByRole("button", { name: "Link item" }));

			await waitFor(() =>
				expect(onLinkExisting).toHaveBeenCalledWith("1234"),
			);
			await waitFor(() =>
				expect(onOpenChange).toHaveBeenCalledWith(false),
			);
			expect(onUnlinkRecreate).not.toHaveBeenCalled();
		});

		it("shows the server's refusal in the dialog and keeps the panel open", async () => {
			const onLinkExisting = vi
				.fn()
				.mockRejectedValue(
					new Error('Item "1234" was not found in the PM tool.'),
				);
			const onOpenChange = vi.fn();
			const user = userEvent.setup();
			render(
				<PmSyncFailureSidePanel
					{...baseProps}
					error={UNCONFIRMED}
					onOpenChange={onOpenChange}
					onUnlinkRecreate={vi.fn()}
					onLinkExisting={onLinkExisting}
				/>,
			);

			await user.click(
				screen.getByRole("button", { name: /Link to existing item/i }),
			);
			await user.type(
				await screen.findByLabelText("Fizzy item ID or key"),
				"1234",
			);
			await user.click(screen.getByRole("button", { name: "Link item" }));

			expect(await screen.findByRole("alert")).toHaveTextContent(
				'Item "1234" was not found in the PM tool.',
			);
			expect(onOpenChange).not.toHaveBeenCalledWith(false);
		});

		it.each([
			["Cancel", "cancel"],
			["Escape", "escape"],
		] as const)(
			"returns focus to the opening button when dismissed with %s",
			async (_label, how) => {
				const onLinkExisting = vi.fn();
				const user = userEvent.setup();
				render(
					<PmSyncFailureSidePanel
						{...baseProps}
						error={UNCONFIRMED}
						onUnlinkRecreate={vi.fn()}
						onLinkExisting={onLinkExisting}
					/>,
				);
				const opener = screen.getByRole("button", {
					name: /Link to existing item/i,
				});
				await user.click(opener);
				await screen.findByLabelText("Fizzy item ID or key");

				if (how === "cancel") {
					await user.click(
						screen.getByRole("button", { name: "Cancel" }),
					);
				} else {
					await user.keyboard("{Escape}");
				}

				await waitFor(() =>
					expect(
						screen.queryByLabelText("Fizzy item ID or key"),
					).not.toBeInTheDocument(),
				);
				await waitFor(() => expect(opener).toHaveFocus());
				expect(onLinkExisting).not.toHaveBeenCalled();
			},
		);

		it("is not offered when the caller does not wire it (a linked item)", () => {
			render(
				<PmSyncFailureSidePanel
					{...baseProps}
					error={UNCONFIRMED}
					onUnlinkRecreate={vi.fn()}
				/>,
			);

			expect(
				screen.queryByRole("button", {
					name: /Link to existing item/i,
				}),
			).not.toBeInTheDocument();
			expect(
				screen.getByText(
					/if the item isn't there, Unlink & re-create/i,
				),
			).toBeInTheDocument();
		});

		it.each([
			[
				"a legacy link to another PM tool",
				"This item is linked to a ticket in a different PM tool, so Fabric did not create a new one in fizzy. To make a new ticket in fizzy, use Unlink & re-create (the old ticket is not deleted).",
			],
			["a deleted card", "Work item 42 does not exist (404)"],
			["an ordinary failure", "Connection refused"],
		])("is not offered for %s", (_label, error) => {
			render(
				<PmSyncFailureSidePanel
					{...baseProps}
					error={error}
					onUnlinkRecreate={vi.fn()}
					onLinkExisting={vi.fn()}
				/>,
			);

			expect(
				screen.queryByRole("button", {
					name: /Link to existing item/i,
				}),
			).not.toBeInTheDocument();
		});

		it("the link dialog has no serious or critical axe violations", async () => {
			const user = userEvent.setup();
			const { baseElement } = render(
				<PmSyncFailureSidePanel
					{...baseProps}
					error={UNCONFIRMED}
					onUnlinkRecreate={vi.fn()}
					onLinkExisting={vi.fn()}
				/>,
			);
			await user.click(
				screen.getByRole("button", { name: /Link to existing item/i }),
			);
			await screen.findByLabelText("Fizzy item ID or key");

			const results = await axe(baseElement);
			expect(results).toHaveNoViolations();
		});
	});

	it("has no serious or critical axe violations", async () => {
		const { baseElement } = render(
			<PmSyncFailureSidePanel {...baseProps} />,
		);

		await waitFor(() =>
			expect(screen.getByRole("dialog")).toBeInTheDocument(),
		);

		const results = await axe(baseElement);
		expect(results).toHaveNoViolations();
	});
});
