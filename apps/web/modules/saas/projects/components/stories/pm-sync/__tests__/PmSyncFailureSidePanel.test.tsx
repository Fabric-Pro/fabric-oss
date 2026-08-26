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
