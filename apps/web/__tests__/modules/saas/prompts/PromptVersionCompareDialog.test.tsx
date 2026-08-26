import { PromptVersionCompareDialog } from "@saas/prompts/components/PromptVersionCompareDialog";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

// The version history used to offer a "Compare" button that only raised a
// "coming soon" toast, and no way at all to go back to an earlier body. These
// tests cover the replacement: a real line diff against the current version,
// plus a Restore action that saves the old body forward as a new version.

const OLD_VERSION = {
	id: "v1",
	version: 1,
	content: "line one\nline two\nline three\n",
	changeNote: "first cut",
	createdAt: new Date("2026-08-12T10:00:00Z").toISOString(),
};

function renderDialog(overrides: Record<string, unknown> = {}) {
	const onRestore = vi.fn();
	render(
		<PromptVersionCompareDialog
			open
			onOpenChange={vi.fn()}
			version={OLD_VERSION}
			currentContent={"line one\nline two CHANGED\nline three\n"}
			currentVersionNumber={2}
			canRestore
			isRestoring={false}
			onRestore={onRestore}
			{...overrides}
		/>,
	);
	return { onRestore };
}

describe("PromptVersionCompareDialog", () => {
	it("names both sides of the comparison", () => {
		renderDialog();
		expect(screen.getByText(/v1/)).toBeTruthy();
		expect(screen.getByText(/v2/)).toBeTruthy();
	});

	it("renders the line diff with gutter markers", () => {
		renderDialog();
		const diff =
			screen.getByTestId("prompt-version-diff").textContent ?? "";

		expect(diff).toContain("  line one");
		expect(diff).toContain("- line two\n");
		expect(diff).toContain("+ line two CHANGED");
	});

	it("restores the selected version's body when Restore is clicked", async () => {
		const user = userEvent.setup();
		const { onRestore } = renderDialog();

		await user.click(screen.getByRole("button", { name: /restore/i }));

		expect(onRestore).toHaveBeenCalledWith(OLD_VERSION.content, 1);
	});

	it("disables Restore when the selected version already matches current", () => {
		renderDialog({ currentContent: OLD_VERSION.content });
		expect(
			screen
				.getByRole("button", { name: /restore/i })
				.hasAttribute("disabled"),
		).toBe(true);
	});

	it("disables Restore while a restore is in flight", () => {
		renderDialog({ isRestoring: true });
		expect(
			screen
				.getByRole("button", { name: /restore/i })
				.hasAttribute("disabled"),
		).toBe(true);
	});

	it("hides Restore entirely when the user cannot edit the prompt", () => {
		// A non-admin viewing a SYSTEM prompt can read history but not write it;
		// showing a button the API would reject is worse than showing none.
		renderDialog({ canRestore: false });
		expect(screen.queryByRole("button", { name: /restore/i })).toBeNull();
	});
});
