import { fireEvent, render, screen } from "@testing-library/react";
import { Tabs, TabsContent } from "@ui/components/tabs";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRequestedFieldFocus } from "../use-requested-field-focus";

const scrollIntoView = vi.fn();

beforeEach(() => {
	scrollIntoView.mockClear();
	HTMLElement.prototype.scrollIntoView = scrollIntoView;
});

function RenameHarness({ initialTab }: { initialTab: string }) {
	const [tab, setTab] = useState(initialTab);
	const nameFieldFocus = useRequestedFieldFocus();
	return (
		<Tabs value={tab} onValueChange={setTab}>
			<button
				type="button"
				onClick={() => {
					setTab("overview");
					nameFieldFocus.request();
				}}
			>
				Rename
			</button>
			<button type="button" onClick={() => setTab("history")}>
				Show history
			</button>
			<button type="button" onClick={() => setTab("overview")}>
				Show settings
			</button>
			<TabsContent value="overview">
				<input
					ref={nameFieldFocus.ref}
					aria-label="Instance Name"
					defaultValue="Weekly status"
				/>
			</TabsContent>
			<TabsContent value="history">Past runs</TabsContent>
		</Tabs>
	);
}

function expectNameFieldFocused() {
	const nameField = screen.getByLabelText<HTMLInputElement>("Instance Name");
	expect(nameField).toHaveFocus();
	expect(nameField.selectionStart).toBe("Weekly status".length);
	expect(nameField.selectionEnd).toBe("Weekly status".length);
	expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
}

describe("useRequestedFieldFocus", () => {
	it("focuses the name field when Rename starts on the tab that shows it", () => {
		render(<RenameHarness initialTab="overview" />);

		fireEvent.click(screen.getByRole("button", { name: "Rename" }));

		expectNameFieldFocused();
	});

	it("focuses the name field once it mounts when Rename starts on another tab", () => {
		render(<RenameHarness initialTab="history" />);
		expect(screen.queryByLabelText("Instance Name")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Rename" }));

		expectNameFieldFocused();
	});

	it("does not take focus again after the request is served", () => {
		render(<RenameHarness initialTab="history" />);
		fireEvent.click(screen.getByRole("button", { name: "Rename" }));
		fireEvent.click(screen.getByRole("button", { name: "Show history" }));
		const showSettings = screen.getByRole("button", {
			name: "Show settings",
		});
		showSettings.focus();

		fireEvent.click(showSettings);

		expect(showSettings).toHaveFocus();
	});
});
