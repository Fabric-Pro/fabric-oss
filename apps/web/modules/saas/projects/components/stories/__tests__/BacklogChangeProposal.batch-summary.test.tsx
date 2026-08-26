/**
 * BacklogChangeProposal — in-chat batch summary on partial-failure batches.
 *
 * Verifies that the in-chat applyResult card surfaces the failure count
 * when some items succeeded and some failed, matching the AC #5 wording
 * "X of Y proposals added to roadmap — Z failed, open Review proposals to
 * retry". Without this surfacing, a user who approves a 32-item batch
 * and sees "Applied 30 items" has no in-chat hint that 2 items vanished
 * — they would have to navigate to the Review proposals inbox to find and
 * retry the failed ones.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
	BacklogChangeProposal,
	type ChangeItem,
} from "../BacklogChangeProposal";

vi.mock("../../../../../shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			stories: {
				checkPmSyncConflicts: vi
					.fn()
					.mockResolvedValue({ results: [] }),
				retryPmSyncBatch: vi.fn(),
			},
		},
	},
}));

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

function buildChange(): ChangeItem {
	return {
		type: "feature",
		action: "create",
		title: { to: "Add batch failed summary" },
		description: { to: "Surface partial-failure counts in chat." },
		reasoning: "AC #5 requires in-chat visibility of partial failures.",
		sourceContext: "ai_update",
	};
}

function renderProposal(
	props: Partial<React.ComponentProps<typeof BacklogChangeProposal>> = {},
) {
	return render(
		<BacklogChangeProposal
			summary="Test proposal"
			contextSummary="Captured from an AI Update batch"
			changes={[buildChange()]}
			hasPMTool={false}
			onApprove={vi.fn()}
			onReject={vi.fn()}
			{...props}
		/>,
	);
}

// Helper — render the proposal, then "click Approve" so the component's
// internal `resolved` state moves to "approved" and the applyResult card
// renders. The card visibility is gated on BOTH `resolved === "approved"`
// AND a non-null `applyResult` prop — passing both is required.
async function renderAndApprove(
	props: Partial<React.ComponentProps<typeof BacklogChangeProposal>> = {},
) {
	const result = renderProposal(props);
	const user = userEvent.setup();
	// The Approve action's actual button text is "Apply Selected (N/M)";
	// match loosely so future copy churn won't break the test.
	const approveBtn = await screen.findByRole("button", {
		name: /apply selected/i,
	});
	await user.click(approveBtn);
	return result;
}

describe("BacklogChangeProposal — in-chat batch summary", () => {
	it("renders the AC #5 partial-failure copy when some items applied and some failed", async () => {
		await renderAndApprove({
			applyResult: {
				status: "success",
				createdCount: 30,
				updatedCount: 0,
				failedCount: 2,
				batchTotal: 32,
				syncedToPM: false,
				items: [],
				message:
					"30 of 32 proposals added to roadmap — 2 failed, open Review proposals to retry",
			},
		});

		// The exact AC #5 wording must be rendered in the result card so a
		// user who stays in the sidebar sees the partial-failure context.
		expect(
			screen.getByText(
				/30 of 32 proposals added to roadmap — 2 failed, open Review proposals to retry/i,
			),
		).toBeInTheDocument();
	});

	it("renders the plain success copy when failedCount is 0", async () => {
		await renderAndApprove({
			applyResult: {
				status: "success",
				createdCount: 32,
				updatedCount: 0,
				failedCount: 0,
				batchTotal: 32,
				syncedToPM: false,
				items: [],
				message: "32 item(s) applied",
			},
		});

		expect(screen.getByText("Applied 32 item(s)")).toBeInTheDocument();
		// Partial-failure copy must NOT render when no items failed.
		expect(
			screen.queryByText(/open Review proposals to retry/i),
		).not.toBeInTheDocument();
	});

	it("falls back gracefully when failedCount and batchTotal are omitted (backward compat)", async () => {
		await renderAndApprove({
			applyResult: {
				status: "success",
				createdCount: 5,
				updatedCount: 3,
				syncedToPM: false,
				items: [],
				message: "8 item(s) applied",
			},
		});

		// Without failedCount, no AC #5 copy; falls back to the plain success line.
		expect(screen.getByText("Applied 8 item(s)")).toBeInTheDocument();
		expect(
			screen.queryByText(/open Review proposals to retry/i),
		).not.toBeInTheDocument();
	});

	it("renders the failure message when the whole batch failed", async () => {
		await renderAndApprove({
			applyResult: {
				status: "failed",
				createdCount: 0,
				updatedCount: 0,
				failedCount: 10,
				batchTotal: 10,
				syncedToPM: false,
				items: [],
				message: "Workflow scheduling timed out",
			},
		});

		expect(
			screen.getByText(/Failed: Workflow scheduling timed out/i),
		).toBeInTheDocument();
		// Don't double-surface the count when the whole batch failed —
		// the message-line is enough.
		expect(
			screen.queryByText(/of 10 proposals added to roadmap/i),
		).not.toBeInTheDocument();
	});
});
