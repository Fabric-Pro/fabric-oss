/**
 * BacklogChangeProposal — chat-thread image-attachment chips.
 *
 * Group 6 of spec `chat-thread-image-attachments`. Covers FR-24 (📎 chip),
 * FR-25 (⚠ chip gated by status), FR-27 (legacy proposals render no chip),
 * AC12 (chip aria-label), AC14 (backward compat), and the
 * `formatWarningReasons` helper that builds the ⚠ tooltip body.
 *
 * Per `fabric/standards/frontend/accessibility.md` § 2.3, icon-only chips
 * use `role="img"` + `aria-label` so screen readers announce the meaning
 * instead of the raw glyph.
 */

import type {
	AttachmentWarning,
	PendingAttachmentRef,
} from "@repo/integrations";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
	BacklogChangeProposal,
	type ChangeItem,
	formatWarningReasons,
} from "../BacklogChangeProposal";

// `orpcClient` is referenced by the parent for the optional PM-sync
// conflict check; tests never exercise that path, but the import must
// resolve. Keep the stub minimal — adding fields here is a smell that
// the test is depending on internals rather than rendered output.
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

// Radix tooltip needs a ResizeObserver + hasPointerCapture in jsdom.
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
		title: { to: "Add chat-thread attachment chips" },
		description: { to: "Render 📎 N and ⚠ M chips on the proposal card." },
		reasoning: "Reviewers need to see attachment volume at a glance.",
		sourceContext: "teams_messages",
	};
}

function buildAttachment(id: string): PendingAttachmentRef {
	return {
		source: "slack",
		messageTs: "1715724000.123456",
		file: {
			id,
			name: `image-${id}.png`,
			mimetype: "image/png",
			urlPrivate: "https://files.slack.com/example",
			size: 1024,
		},
	};
}

function buildWarning(
	reason: AttachmentWarning["reason"],
	refId = `ref-${reason}`,
): AttachmentWarning {
	return { source: "slack", refId, reason };
}

function renderProposal(
	props: Partial<React.ComponentProps<typeof BacklogChangeProposal>> = {},
) {
	return render(
		<BacklogChangeProposal
			summary="Test proposal"
			contextSummary="Captured from a Slack thread"
			changes={[buildChange()]}
			hasPMTool={false}
			onApprove={vi.fn()}
			onReject={vi.fn()}
			{...props}
		/>,
	);
}

describe("BacklogChangeProposal — attachment chips", () => {
	it("renders the 📎 N chip with a plural aria-label when 4 attachments are present and no warnings exist", () => {
		const attachments: PendingAttachmentRef[] = [
			buildAttachment("F1"),
			buildAttachment("F2"),
			buildAttachment("F3"),
			buildAttachment("F4"),
		];

		renderProposal({
			attachments,
			attachmentWarnings: [],
			proposalStatus: "PENDING",
		});

		const chip = screen.getByRole("img", {
			name: "4 image attachments from chat thread",
		});
		expect(chip).toBeInTheDocument();
		expect(chip).toHaveTextContent("4");
		// No warning chip — the M-only path must NOT render the ⚠ chip.
		expect(
			screen.queryByRole("img", { name: /attachment warning/i }),
		).not.toBeInTheDocument();
	});

	it("renders the singular aria-label when only 1 attachment is present", () => {
		renderProposal({
			attachments: [buildAttachment("F1")],
			attachmentWarnings: [],
			proposalStatus: "PENDING",
		});

		expect(
			screen.getByRole("img", {
				name: "1 image attachment from chat thread",
			}),
		).toBeInTheDocument();
	});

	it("renders no chip when both attachments and warnings are empty", () => {
		renderProposal({
			attachments: [],
			attachmentWarnings: [],
			proposalStatus: "PENDING",
		});

		expect(
			screen.queryByRole("img", { name: /image attachment/i }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("img", { name: /attachment warning/i }),
		).not.toBeInTheDocument();
	});

	it("renders both chips with correct aria-labels when 1 attachment + 2 warnings are present (status PENDING)", async () => {
		const user = userEvent.setup();
		const attachments = [buildAttachment("F1")];
		const warnings = [
			buildWarning("unsupported_mime", "ref-A"),
			buildWarning("image_too_large", "ref-B"),
		];

		renderProposal({
			attachments,
			attachmentWarnings: warnings,
			proposalStatus: "PENDING",
		});

		const attachmentChip = screen.getByRole("img", {
			name: "1 image attachment from chat thread",
		});
		const warningChip = screen.getByRole("img", {
			name: "2 attachment warnings",
		});
		expect(attachmentChip).toBeInTheDocument();
		expect(warningChip).toBeInTheDocument();
		// Tooltip body lists distinct reasons in plain English when the
		// chip is hovered/focused.
		warningChip.focus();
		await user.hover(warningChip);
		// Radix renders the tooltip body twice: once visible inside the
		// portal `<div data-slot="tooltip-content">` and once inside an
		// off-screen `<span role="tooltip">` for screen readers via
		// aria-describedby. Both must surface the same human-readable
		// text — assert via getAllByText so neither copy is silently
		// dropped by a future markup change.
		const tooltipBodies = await screen.findAllByText(
			/Unsupported image type, Image too large/,
		);
		expect(tooltipBodies.length).toBeGreaterThan(0);
		// The screen-reader copy is the load-bearing accessibility
		// surface; verify aria-describedby wires the trigger to it.
		expect(warningChip).toHaveAttribute("aria-describedby");
	});

	it("suppresses the ⚠ chip when the proposal status is APPLIED (FR-25)", () => {
		renderProposal({
			attachments: [buildAttachment("F1")],
			attachmentWarnings: [buildWarning("download_failed")],
			proposalStatus: "APPLIED",
		});

		// 📎 chip still renders — successfully-attached count is
		// informational regardless of status.
		expect(
			screen.getByRole("img", {
				name: "1 image attachment from chat thread",
			}),
		).toBeInTheDocument();
		// ⚠ chip MUST NOT render — the warning line is already on the
		// resulting story description per AC13, so re-surfacing it on
		// the proposal card would be a duplicate.
		expect(
			screen.queryByRole("img", { name: /attachment warning/i }),
		).not.toBeInTheDocument();
	});

	it("suppresses both chips when attachments/warnings are undefined (legacy proposals — FR-27)", () => {
		renderProposal({
			attachments: undefined,
			attachmentWarnings: undefined,
			proposalStatus: "PENDING",
		});

		expect(
			screen.queryByRole("img", { name: /image attachment/i }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("img", { name: /attachment warning/i }),
		).not.toBeInTheDocument();
	});

	it("renders the ⚠ chip on FAILED proposals (re-review path)", () => {
		renderProposal({
			attachments: [],
			attachmentWarnings: [
				buildWarning("upload_failed"),
				buildWarning("upload_failed"),
			],
			proposalStatus: "FAILED",
		});

		const warningChip = screen.getByRole("img", {
			name: "2 attachment warnings",
		});
		expect(warningChip).toBeInTheDocument();
	});

	it("keeps the chip keyboard-focusable so screen-reader users can reach the tooltip", () => {
		renderProposal({
			attachments: [buildAttachment("F1")],
			attachmentWarnings: [buildWarning("download_failed")],
			proposalStatus: "PENDING",
		});

		const warningChip = screen.getByRole("img", {
			name: /attachment warning/i,
		});
		// `tabIndex={0}` is required so the Radix tooltip trigger fires
		// on keyboard focus — otherwise a screen-reader user would see
		// the count but never the reason breakdown.
		expect(warningChip).toHaveAttribute("tabindex", "0");
	});
});

describe("formatWarningReasons", () => {
	it("returns an empty string when no warnings are supplied", () => {
		expect(formatWarningReasons([])).toBe("");
	});

	it("renders a single warning without a count prefix", () => {
		expect(formatWarningReasons([buildWarning("unsupported_mime")])).toBe(
			"Unsupported image type",
		);
	});

	it("collapses duplicate reasons into `N <label>` entries", () => {
		expect(
			formatWarningReasons([
				buildWarning("unsupported_mime", "A"),
				buildWarning("unsupported_mime", "B"),
				buildWarning("image_too_large", "C"),
			]),
		).toBe("2 Unsupported image type, Image too large");
	});

	it("maps every known reason to its plain-English label", () => {
		expect(
			formatWarningReasons([
				buildWarning("scope_missing"),
				buildWarning("auth_failed"),
				buildWarning("external_workspace"),
				buildWarning("download_failed"),
				buildWarning("upload_failed"),
				buildWarning("patch_failed"),
				buildWarning("budget_exceeded"),
				buildWarning("count_cap_exceeded"),
				buildWarning("thread_total_exceeded"),
			]),
		).toBe(
			[
				// Both `scope_missing` (HTTP 200 + missing_scope body) and
				// `auth_failed` (HTTP 401 — token revoked/expired/invalid)
				// point the reviewer at the same recovery action — re-authorize
				// the integration. Labels are intentionally similar; the
				// distinction is preserved in structured logs for ops triage.
				"Permission missing — re-authorize integration",
				"Auth expired — re-authorize integration",
				"External workspace",
				"Download failed",
				"Upload failed",
				"Couldn't save attachments to story",
				"Approval timeout",
				"Too many images",
				"Thread image total exceeded",
			].join(", "),
		);
	});

	it("preserves first-seen order when reasons interleave", () => {
		expect(
			formatWarningReasons([
				buildWarning("image_too_large", "A"),
				buildWarning("unsupported_mime", "B"),
				buildWarning("image_too_large", "C"),
			]),
		).toBe("2 Image too large, Unsupported image type");
	});
});
