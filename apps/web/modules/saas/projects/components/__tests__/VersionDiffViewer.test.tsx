/**
 * VersionDiffViewer — its Restore while Restore is closed off (Fizzy #2946).
 *
 * The version history hands the viewer the translated reason while a run is
 * live or the tab's own regeneration is under way; the viewer's Restore is
 * then closed off with `aria-disabled` (still focusable, its own tab stop,
 * no wrapper around it), described by that sentence, and pressing it does
 * nothing. With no reason it restores as before.
 *
 * TipTap is mocked: the panes are not under test, only the header's Restore.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tiptap/react", () => ({
	useEditor: () => null,
	EditorContent: () => null,
}));
vi.mock("../../lib/tiptap-extensions-advanced", () => ({
	advancedExtensions: [],
}));

import { VersionDiffViewer } from "../VersionDiffViewer";

const REASON =
	"Restore is unavailable while a generation run is queued or writing this document.";

function renderViewer(
	props: Partial<Parameters<typeof VersionDiffViewer>[0]> = {},
) {
	const onRestore = vi.fn();
	render(
		<VersionDiffViewer
			open
			onOpenChange={vi.fn()}
			selectedVersion={{
				id: "ver-2",
				version: 2,
				content: "An earlier body.",
				changeDescription: null,
				createdAt: "2026-07-01T00:00:00.000Z",
			}}
			currentContent="The current body."
			currentVersion={3}
			onRestore={onRestore}
			isRestoring={false}
			{...props}
		/>,
	);
	return { onRestore };
}

const restoreButton = () =>
	screen.getByRole("button", { name: "Restore Version 2" });

describe("VersionDiffViewer — Restore", () => {
	it("restores as before with no reason to hold it", () => {
		const { onRestore } = renderViewer();

		expect(restoreButton()).toBeEnabled();
		expect(restoreButton()).not.toHaveAttribute("aria-disabled");
		expect(restoreButton()).not.toHaveAccessibleDescription();
		fireEvent.click(restoreButton());
		expect(onRestore).toHaveBeenCalledTimes(1);
	});

	it("is closed off and says why on the button itself while a reason holds it", () => {
		renderViewer({ restoreDisabledReason: REASON });

		const restore = restoreButton();
		expect(restore).toHaveAttribute("aria-disabled", "true");
		expect(restore).toHaveAccessibleDescription(REASON);
		// Still focusable, so a keyboard or screen-reader user reaches it and
		// hears why; no focusable wrapper around it as a second tab stop.
		act(() => {
			restore.focus();
		});
		expect(restore).toHaveFocus();
		expect(restore.closest("[tabindex]:not([role])")).toBeNull();
	});

	it("restores nothing when the closed-off Restore is clicked or pressed with Enter or Space", async () => {
		const { onRestore } = renderViewer({ restoreDisabledReason: REASON });
		const user = userEvent.setup();

		const restore = restoreButton();
		fireEvent.click(restore);
		act(() => {
			restore.focus();
		});
		await user.keyboard("{Enter}");
		await user.keyboard(" ");

		expect(onRestore).not.toHaveBeenCalled();
	});
});
