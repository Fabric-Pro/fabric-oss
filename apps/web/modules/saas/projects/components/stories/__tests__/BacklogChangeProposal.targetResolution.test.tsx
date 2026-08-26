/**
 * BacklogChangeProposal — targetResolution badge.
 *
 * Covers the per-item badge that surfaces whether the AI's target reference
 * was resolved to a real Fabric item:
 *
 * - A resolved update shows "Updates <identifier> — <title>" so the reviewer
 *   sees the canonical Fabric identity instead of the raw AI reference.
 * - A demoted change (was an update, no match found, promoted to create) shows
 *   "New item — no existing match" so the reviewer knows the AI had no target.
 */

import { render, screen } from "@testing-library/react";
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

vi.mock("@saas/organizations/hooks/use-organization-context", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	useBasePath: () => "/app/acme",
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

function buildChange(overrides: Partial<ChangeItem> = {}): ChangeItem {
	return {
		type: "feature",
		action: "create",
		title: { to: "Login page improvements" },
		reasoning: "Reviewer needs canonical target identity.",
		sourceContext: "teams_messages",
		...overrides,
	};
}

function renderProposal(
	props: Partial<React.ComponentProps<typeof BacklogChangeProposal>> = {},
) {
	return render(
		<BacklogChangeProposal
			summary="Test proposal"
			contextSummary="Captured from a Teams thread"
			changes={props.changes ?? [buildChange()]}
			hasPMTool={false}
			onApprove={vi.fn()}
			onReject={vi.fn()}
			{...props}
		/>,
	);
}

describe("BacklogChangeProposal — targetResolution badge", () => {
	it("renders 'Updates F-1 — Login page' for a resolved update", () => {
		const change = buildChange({
			action: "update",
			existingId: "story_1",
			targetResolution: {
				status: "resolved",
				resolvedIdentifier: "F-1",
				resolvedTitle: "Login page",
			},
		});

		renderProposal({ changes: [change] });

		expect(screen.getByText(/Updates F-1/)).toBeInTheDocument();
		expect(
			screen.getByText(/Updates F-1 — Login page/),
		).toBeInTheDocument();
	});

	it("renders 'New item — no existing match' for a demoted change", () => {
		const change = buildChange({
			action: "create",
			targetResolution: {
				status: "unresolved",
				demotedFromUpdate: true,
			},
		});

		renderProposal({ changes: [change] });

		expect(
			screen.getByText(/New item — no existing match/),
		).toBeInTheDocument();
	});

	it("renders no targetResolution badge when targetResolution is absent", () => {
		renderProposal({
			changes: [buildChange({ targetResolution: undefined })],
		});

		expect(screen.queryByText(/Updates [A-Z]-\d/)).not.toBeInTheDocument();
		expect(
			screen.queryByText(/New item — no existing match/),
		).not.toBeInTheDocument();
	});
});
