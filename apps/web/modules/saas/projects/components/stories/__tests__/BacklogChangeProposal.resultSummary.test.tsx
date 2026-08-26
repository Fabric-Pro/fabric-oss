/**
 * BacklogChangeProposal — per-item result summary (Created / Updated / Skipped /
 * Failed).
 *
 * The AI Update apply flow tracks dedup-skipped creates and per-item failures
 * server-side, but until now only Created/Updated were surfaced in the in-chat
 * result card — skipped (already-in-backlog) items and per-item failures
 * vanished. These tests cover the per-item outcome badges + reasons and the
 * aria-live status region.
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

// Deterministic base path so the result-card ticket links resolve to a known
// URL. Keeps every other export from the org-context module intact.
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

function buildChange(): ChangeItem {
	return {
		type: "feature",
		action: "create",
		title: { to: "Add per-item result summary" },
		description: { to: "Surface skipped + failed outcomes per item." },
		reasoning: "FR-6 requires per-item Created/Updated/Skipped/Failed.",
		sourceContext: "ai_update",
	};
}

async function renderAndApprove(
	props: Partial<React.ComponentProps<typeof BacklogChangeProposal>> = {},
) {
	const result = render(
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
	const user = userEvent.setup();
	const approveBtn = await screen.findByRole("button", {
		name: /apply selected/i,
	});
	await user.click(approveBtn);
	return result;
}

describe("BacklogChangeProposal — per-item result summary", () => {
	it("renders Created / Updated / Skipped / Failed badges with reasons", async () => {
		await renderAndApprove({
			applyResult: {
				status: "success",
				createdCount: 1,
				updatedCount: 1,
				failedCount: 1,
				skippedCount: 1,
				batchTotal: 4,
				syncedToPM: false,
				items: [
					{
						identifier: "F-1",
						title: "Brand new feature",
						type: "feature",
						_action: "created",
					},
					{
						identifier: "F-2",
						title: "Edited feature",
						type: "feature",
						_action: "updated",
					},
					{
						identifier: "",
						title: "Duplicate feature",
						type: "feature",
						_action: "skipped",
						reason: "Already in the backlog as F-9",
					},
					{
						identifier: "",
						title: "Broken item",
						type: "bug",
						_action: "failed",
						reason: "Database write failed",
					},
				],
				message:
					"2 of 4 proposals added to roadmap — 1 failed, open Review proposals to retry",
			},
		});

		// All four outcome badges render.
		expect(screen.getByText("Created")).toBeInTheDocument();
		expect(screen.getByText("Updated")).toBeInTheDocument();
		expect(screen.getByText("Skipped")).toBeInTheDocument();
		expect(screen.getByText("Failed")).toBeInTheDocument();

		// Skipped + failed carry their reason.
		expect(
			screen.getByText(/Already in the backlog as F-9/),
		).toBeInTheDocument();
		expect(screen.getByText(/Database write failed/)).toBeInTheDocument();
	});

	it("exposes an aria-live status region for screen readers", async () => {
		const { container } = await renderAndApprove({
			applyResult: {
				status: "success",
				createdCount: 1,
				updatedCount: 0,
				failedCount: 0,
				skippedCount: 0,
				batchTotal: 1,
				syncedToPM: false,
				items: [
					{
						identifier: "F-1",
						title: "Brand new feature",
						type: "feature",
						_action: "created",
					},
				],
				message: "Applied 1 item(s)",
			},
		});
		expect(
			container.querySelector('[aria-live="polite"]'),
		).toBeInTheDocument();
	});

	it("surfaces Skipped items even when nothing new was applied (all duplicates)", async () => {
		await renderAndApprove({
			applyResult: {
				status: "success",
				createdCount: 0,
				updatedCount: 0,
				failedCount: 0,
				skippedCount: 2,
				batchTotal: 2,
				syncedToPM: false,
				items: [
					{
						identifier: "",
						title: "Duplicate A",
						type: "feature",
						_action: "skipped",
						reason: "Already in the backlog as F-9",
					},
					{
						identifier: "",
						title: "Duplicate B",
						type: "bug",
						_action: "skipped",
						reason: "Already in the backlog as F-10",
					},
				],
				message:
					"All 2 item(s) already existed in the backlog — nothing new to add",
			},
		});

		expect(screen.getAllByText("Skipped")).toHaveLength(2);
		expect(screen.queryByText("Created")).not.toBeInTheDocument();
	});

	it("links Created/Updated identifiers to the ticket, opening in a new tab", async () => {
		await renderAndApprove({
			projectId: "proj_1",
			applyResult: {
				status: "success",
				createdCount: 1,
				updatedCount: 1,
				failedCount: 0,
				skippedCount: 1,
				batchTotal: 3,
				syncedToPM: false,
				items: [
					{
						id: "story_created",
						identifier: "F-7",
						title: "Linked feature",
						type: "feature",
						_action: "created",
					},
					{
						id: "story_updated",
						identifier: "B-3",
						title: "Linked bug",
						type: "bug",
						_action: "updated",
					},
					{
						identifier: "",
						title: "Duplicate",
						type: "feature",
						_action: "skipped",
						reason: "Already in the backlog as F-9",
					},
				],
				message: "2 item(s) applied, 1 skipped (already existed)",
			},
		});

		// The auto-generated identifier is a link to the ticket, in a new tab —
		// the user types nothing; the id comes straight from the apply result.
		const createdLink = screen.getByRole("link", { name: "F-7" });
		expect(createdLink).toHaveAttribute(
			"href",
			"/app/acme/projects/proj_1/stories/story_created",
		);
		expect(createdLink).toHaveAttribute("target", "_blank");
		expect(createdLink).toHaveAttribute("rel", "noopener noreferrer");

		// Updated items link too.
		expect(screen.getByRole("link", { name: "B-3" })).toHaveAttribute(
			"href",
			"/app/acme/projects/proj_1/stories/story_updated",
		);

		// Skipped (no created ticket / no story id) stays plain text.
		expect(screen.getByText("Skipped")).toBeInTheDocument();
		expect(screen.queryByRole("link", { name: /Duplicate/ })).toBeNull();
	});

	it("shows the identifier as plain text when the item has no story id", async () => {
		await renderAndApprove({
			projectId: "proj_1",
			applyResult: {
				status: "success",
				createdCount: 1,
				updatedCount: 0,
				failedCount: 0,
				skippedCount: 0,
				batchTotal: 1,
				syncedToPM: false,
				items: [
					{
						identifier: "F-7",
						title: "Unlinked feature",
						type: "feature",
						_action: "created",
					},
				],
				message: "Applied 1 item(s)",
			},
		});

		expect(screen.queryByRole("link", { name: "F-7" })).toBeNull();
		expect(screen.getByText(/Unlinked feature/)).toBeInTheDocument();
	});
});
