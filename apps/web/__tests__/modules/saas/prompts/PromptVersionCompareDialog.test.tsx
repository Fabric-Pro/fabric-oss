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

	// Fizzy #2250: a version saved before today's save rules — over the length
	// limit, or blank — would be refused on restore. The reason belongs next to
	// the disabled button, not in a toast after a failed request.
	it.each([
		[
			"over the length limit",
			"x".repeat(50_001),
			"Prompt content is 50,001 characters; the maximum is 50,000.",
		],
		["blank", "  ​ \n", "Prompt content cannot be empty"],
	])(
		"explains why a version %s cannot be restored and disables Restore",
		(_label, content, message) => {
			const { onRestore } = renderDialog({
				version: { ...OLD_VERSION, content },
			});

			const restore = screen.getByRole("button", { name: /restore/i });
			expect(restore.hasAttribute("disabled")).toBe(true);
			// Announced: a disabled button is not focusable, so its description
			// alone may never be read.
			const reason = screen.getByRole("alert");
			expect(reason.textContent).toContain(message);
			expect(reason.textContent).toContain("can't be restored");
			expect(restore.getAttribute("aria-describedby")).toBe(reason.id);
			expect(onRestore).not.toHaveBeenCalled();
		},
	);

	it("shows no restore warning for a version that can be saved", () => {
		renderDialog();
		expect(screen.queryByText(/can't be restored/)).toBeNull();
		expect(
			screen
				.getByRole("button", { name: /restore/i })
				.hasAttribute("aria-describedby"),
		).toBe(false);
	});
});
