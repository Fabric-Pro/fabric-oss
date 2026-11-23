/**
 * The review controls of a Proposal Inbox update on its ticket page: what is
 * reviewed, the merge being read, and the item's three decisions.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Editor } from "@tiptap/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { diffPartialText, fromMarkdown } from "../../../lib/diff-utils";
import type { DiffViewMode } from "../../../lib/diff-view-modes";
import { editorHoldsDiffMarks } from "../../../lib/editor-diff-marks";
import { getEditorMarkdownForSave } from "../../../lib/editor-markdown-save";
import { advancedExtensions } from "../../../lib/tiptap-extensions-advanced";
import type { ChangeItem } from "../BacklogChangeProposal";
import { ProposalTicketReviewBar } from "../ProposalTicketReviewBar";
import type { useProposalTicketReview } from "../useProposalTicketReview";

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("../../../hooks/useDocumentAssistantHistory", () => ({
	useRecordDocumentAssistantDiffOutcome: () => ({ mutateAsync: vi.fn() }),
}));

beforeAll(() => {
	if (typeof Element.prototype.hasPointerCapture !== "function") {
		Element.prototype.hasPointerCapture = () => false;
	}
	if (typeof Element.prototype.setPointerCapture !== "function") {
		Element.prototype.setPointerCapture = () => undefined;
	}
	if (typeof Element.prototype.releasePointerCapture !== "function") {
		Element.prototype.releasePointerCapture = () => undefined;
	}
	if (typeof Element.prototype.scrollIntoView !== "function") {
		Element.prototype.scrollIntoView = () => undefined;
	}
});

const editors: Editor[] = [];
afterEach(() => {
	for (const editor of editors.splice(0)) {
		editor.destroy();
	}
});

/** An editor showing the change from `baseline` to `next` for review. */
function reviewEditor(baseline: string, next: string): Editor {
	const editor = new Editor({
		element: document.createElement("div"),
		extensions: advancedExtensions,
		content: fromMarkdown(diffPartialText(baseline, next, true), {
			repairLegacyBullets: false,
		}),
	});
	editors.push(editor);
	return editor;
}

const CHANGE: ChangeItem = {
	type: "feature",
	action: "update",
	existingId: "story-7",
	existingIdentifier: "F-7",
	title: { from: "Bravo", to: "Bravo" },
	description: { from: "Old", to: "New" },
	priority: { from: "P3", to: "P1" },
	structurePreserved: true,
	reasoning: "Raised in planning",
	sourceContext: "teams_messages",
};

function reviewState(
	overrides: Partial<ReturnType<typeof useProposalTicketReview>> = {},
): ReturnType<typeof useProposalTicketReview> {
	return {
		review: {
			projectId: "project_1",
			organizationId: null,
			storyId: "story-7",
			proposalId: "proposal_1",
			source: "SLACK_CHANNEL",
			changeIndex: 0,
			change: CHANGE,
			syncToPM: false,
			pmSyncOverrides: undefined,
			pmConfig: undefined,
			expectedProposalRevision: undefined,
			startedAt: 0,
		},
		isActive: true,
		isMerging: false,
		mergeFailed: false,
		retryMerge: vi.fn(),
		showingDiff: true,
		isApplying: false,
		lineByLineUnavailable: false,
		canApply: () => true,
		apply: vi.fn().mockResolvedValue(undefined),
		rejectAll: vi.fn().mockResolvedValue(undefined),
		cancel: vi.fn(),
		...overrides,
	};
}

function renderBar(
	review: ReturnType<typeof useProposalTicketReview>,
	editor: Editor | null = null,
	mode: DiffViewMode = "inline",
) {
	render(
		<ProposalTicketReviewBar
			review={review}
			editor={editor}
			mode={mode}
			onBeforeChange={vi.fn()}
			onAfterChange={vi.fn()}
		/>,
	);
}

describe("ProposalTicketReviewBar", () => {
	it("names the item and the fields applied outside the editor", () => {
		renderBar(reviewState());

		expect(
			screen.getByRole("region", {
				name: "Reviewing a proposed update: Bravo",
			}),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				/Apply also sets, as approved in the inbox: Priority/,
			),
		).toBeInTheDocument();
	});

	it("applies the accepted changes, rejects every change, or cancels", async () => {
		const user = userEvent.setup();
		const review = reviewState();
		renderBar(review);

		await user.click(
			screen.getByRole("button", {
				name: "Apply the accepted changes to Bravo",
			}),
		);
		await user.click(
			screen.getByRole("button", { name: "Reject all changes to Bravo" }),
		);
		await user.click(screen.getByRole("button", { name: "Cancel review" }));

		expect(review.apply).toHaveBeenCalledOnce();
		expect(review.rejectAll).toHaveBeenCalledOnce();
		expect(review.cancel).toHaveBeenCalledOnce();
	});

	it("says the merge is being read, and offers only Cancel until it is", () => {
		renderBar(reviewState({ isMerging: true, showingDiff: false }));

		expect(screen.getByRole("status")).toHaveTextContent(
			"Working out what this update changes on the ticket as it is now…",
		);
		expect(
			screen.queryByRole("button", {
				name: /Apply the accepted changes/,
			}),
		).toBeNull();
		expect(
			screen.getByRole("button", { name: "Cancel review" }),
		).toBeEnabled();
	});

	it("offers to read the merge again when it failed", async () => {
		const user = userEvent.setup();
		const review = reviewState({
			isMerging: true,
			mergeFailed: true,
			showingDiff: false,
		});
		renderBar(review);

		await user.click(screen.getByRole("button", { name: "Try again" }));

		expect(review.retryMerge).toHaveBeenCalledOnce();
	});

	it("holds every decision while one is being applied", () => {
		renderBar(reviewState({ isApplying: true }));

		for (const name of [
			"Apply the accepted changes to Bravo",
			"Reject all changes to Bravo",
			"Cancel review",
		]) {
			expect(screen.getByRole("button", { name })).toBeDisabled();
		}
	});

	it.each([
		{
			mode: "inline" as const,
			// The item also changes its priority, which Apply sets alone once
			// every change is rejected.
			hint: "Accept at least one change, or reject every change to apply only Priority; or choose Reject all.",
		},
		{
			mode: "sideBySide" as const,
			hint: "Accept changes in the Inline view, or with Accept All, to apply them; or choose Reject all.",
		},
	])(
		"keeps Apply off until it would write something ($mode)",
		({ mode, hint }) => {
			const review = reviewState({ canApply: () => false });
			renderBar(review, null, mode);

			const applyButton = screen.getByRole("button", {
				name: "Apply the accepted changes to Bravo",
			});
			expect(applyButton).toBeDisabled();
			expect(applyButton).toHaveAccessibleDescription(hint);
			// Reject all stays available.
			expect(
				screen.getByRole("button", {
					name: "Reject all changes to Bravo",
				}),
			).toBeEnabled();
		},
	);

	it("asks for an accepted change when the item changes nothing outside the editor", () => {
		const base = reviewState({ canApply: () => false });
		const review = {
			...base,
			review: base.review && {
				...base.review,
				change: { ...CHANGE, priority: undefined },
			},
		};
		renderBar(review);

		expect(
			screen.getByRole("button", {
				name: "Apply the accepted changes to Bravo",
			}),
		).toHaveAccessibleDescription(
			"Accept at least one change to apply it, or choose Reject all.",
		);
		expect(screen.queryByText(/Apply also sets/)).toBeNull();
	});

	it("says line-by-line review is unavailable and keeps Apply off when the changes could not be marked", () => {
		const review = reviewState({
			lineByLineUnavailable: true,
			canApply: () => false,
		});
		renderBar(review);

		expect(screen.getByRole("status")).toHaveTextContent(
			/Line-by-line review isn't available for this update/,
		);
		const applyButton = screen.getByRole("button", {
			name: "Apply the accepted changes to Bravo",
		});
		expect(applyButton).toBeDisabled();
		expect(applyButton).toHaveAccessibleDescription(
			"To apply the whole update, cancel this review and choose Apply all changes in the Proposal Inbox; or choose Reject all.",
		);
		// Nothing applies from here, the inbox's fields included.
		expect(
			screen.queryByText(/Apply also sets, as approved in the inbox/),
		).toBeNull();
		expect(
			screen.getByRole("button", { name: "Reject all changes to Bravo" }),
		).toBeEnabled();
	});

	it.each([
		{ control: "approveAll", kept: "New text." },
		{ control: "rejectAll", kept: "Old text." },
	])(
		"answers only the editor's changes from the change bar's $control",
		async ({ control, kept }) => {
			const user = userEvent.setup();
			const review = reviewState();
			const editor = reviewEditor("Old text.", "New text.");
			renderBar(review, editor);

			await user.click(screen.getByRole("button", { name: control }));

			expect(editorHoldsDiffMarks(editor.state.doc)).toBe(false);
			expect(getEditorMarkdownForSave(editor)?.trim()).toBe(kept);
			expect(review.apply).not.toHaveBeenCalled();
			expect(review.rejectAll).not.toHaveBeenCalled();
		},
	);
});
