/**
 * Tests for the DiffReviewBar zero-changes state.
 *
 * Previously the bar returned `null` when the editor held zero diff marks,
 * which stranded a Flow-B review locked in the "diff" phase with no exit
 * affordance. It now renders a compact "No changes to review" bar whose single
 * dismiss button is wired to `onRejectAll` (the review-exit path in both
 * flows). With diff ranges present, the bar is unchanged.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => key,
}));

vi.mock("@saas/projects/hooks/useDocumentAssistantHistory", () => ({
	useRecordDocumentAssistantDiffOutcome: () => ({ mutateAsync: vi.fn() }),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import { DiffReviewBar } from "@saas/projects/components/DiffReviewBar";

/** Editor whose document contains zero diff marks. */
function makeEmptyEditor(): Editor {
	return {
		state: { doc: { descendants: () => {} } },
		view: { dom: document.createElement("div") },
	} as unknown as Editor;
}

/** Editor whose document contains a single diffInsert (addition) mark. */
function makeEditorWithOneAddition(): Editor {
	const insertNode = {
		isText: true,
		nodeSize: 5,
		marks: [{ type: { name: "diffInsert" } }],
	};
	return {
		state: {
			doc: {
				descendants: (cb: (node: unknown, pos: number) => void) => {
					cb(insertNode, 0);
				},
			},
		},
		view: { dom: document.createElement("div") },
	} as unknown as Editor;
}

describe("DiffReviewBar — zero diff ranges", () => {
	it("renders a 'No changes to review' bar with a working dismiss", () => {
		const onRejectAll = vi.fn();
		render(
			<DiffReviewBar
				editor={makeEmptyEditor()}
				onAcceptAll={vi.fn()}
				onRejectAll={onRejectAll}
			/>,
		);

		// The translation mock echoes keys, so assert on the i18n key.
		expect(screen.getByText("noChangesToReview")).toBeInTheDocument();
		// The bulk-review controls are absent in the zero-changes state.
		expect(screen.queryByText("Accept All")).not.toBeInTheDocument();

		const dismiss = screen.getByRole("button", { name: "rejectAll" });
		expect(dismiss.tagName).toBe("BUTTON");
		fireEvent.click(dismiss);
		expect(onRejectAll).toHaveBeenCalledTimes(1);
	});

	it("renders the full bar unchanged when diff ranges exist", () => {
		render(
			<DiffReviewBar
				editor={makeEditorWithOneAddition()}
				onAcceptAll={vi.fn()}
				onRejectAll={vi.fn()}
			/>,
		);

		expect(screen.getByText("Accept All")).toBeInTheDocument();
		expect(screen.getByText("1 change")).toBeInTheDocument();
		expect(screen.queryByText("noChangesToReview")).not.toBeInTheDocument();
	});
});
