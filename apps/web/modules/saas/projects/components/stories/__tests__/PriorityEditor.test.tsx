/**
 * Focused tests for <PriorityEditor>'s external-change sync — the subtle bit.
 *
 * The editor can be a permanent fixture (the Priority view keeps it open on
 * every expanded row), so its `current` prop changes UNDER it: the user's own
 * save landing, the AI sparkle, another member's move arriving via refetch.
 * The sync must never be a remount — a remount wipes an in-progress comment
 * draft mid-keystroke — so these pin the two sync rules down directly:
 *   - external move  → picker re-seeds, draft survives
 *   - own save lands → draft clears (it is recorded in the history now)
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { StoryPriority } from "../../../lib/stories/types";
import { getPriorityLabel } from "../../../lib/stories/types";
import { PriorityEditor } from "../priority/PriorityEditor";

function renderEditor(current: StoryPriority) {
	const onSave = vi.fn();
	const view = render(
		<PriorityEditor current={current} isSaving={false} onSave={onSave} />,
	);
	return {
		onSave,
		rerenderWith: (next: StoryPriority) =>
			view.rerender(
				<PriorityEditor
					current={next}
					isSaving={false}
					onSave={onSave}
				/>,
			),
	};
}

const bandButton = (priority: StoryPriority) =>
	screen.getByRole("button", { name: getPriorityLabel(priority) });

// The global next-intl mock echoes keys, so the sr-only comment label IS its key.
const commentInput = () => screen.getByLabelText("commentLabel");

describe("PriorityEditor — sync to an external band change", () => {
	it("re-seeds the picker when the band moves externally, preserving the comment draft", () => {
		const { rerenderWith } = renderEditor("P2_MEDIUM");

		fireEvent.change(commentInput(), {
			target: { value: "half-typed justification" },
		});
		expect(bandButton("P2_MEDIUM")).toHaveAttribute("aria-pressed", "true");

		// The AI sparkle (or another member) lands P0 while the draft is open.
		rerenderWith("P0_CRITICAL");

		expect(bandButton("P0_CRITICAL")).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		// The half-typed note survives — this is the whole point of syncing
		// instead of remounting.
		expect(commentInput()).toHaveValue("half-typed justification");
	});

	it("clears the comment once its own save lands (band arrives where the picker points)", () => {
		const { rerenderWith } = renderEditor("P2_MEDIUM");

		fireEvent.click(bandButton("P1_HIGH"));
		fireEvent.change(commentInput(), {
			target: { value: "raising for the release" },
		});

		// The save's refetch delivers the band the user picked.
		rerenderWith("P1_HIGH");

		expect(bandButton("P1_HIGH")).toHaveAttribute("aria-pressed", "true");
		expect(commentInput()).toHaveValue("");
	});

	it("hides Cancel when no onCancel is given (the permanent-fixture mode)", () => {
		renderEditor("P2_MEDIUM");
		expect(
			screen.queryByRole("button", { name: "cancel" }),
		).not.toBeInTheDocument();
	});
});
