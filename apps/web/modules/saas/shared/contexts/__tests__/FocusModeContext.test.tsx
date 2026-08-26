import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PropsWithChildren } from "react";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import {
	FocusModeProvider,
	isEditableElement,
	useFocusMode,
} from "../FocusModeContext";
import { SidebarCollapseProvider } from "../SidebarCollapseContext";

// Mock next/navigation
const mockPathname = vi.fn().mockReturnValue("/app/projects/p-1");
vi.mock("next/navigation", () => ({
	usePathname: () => mockPathname(),
}));

function TestWrapper({ children }: PropsWithChildren) {
	return (
		<SidebarCollapseProvider>
			<FocusModeProvider>{children}</FocusModeProvider>
		</SidebarCollapseProvider>
	);
}

describe("FocusModeContext & isEditableElement Guard", () => {
	it("identifies editable elements correctly", () => {
		const input = document.createElement("input");
		const textarea = document.createElement("textarea");
		const select = document.createElement("select");
		const plainDiv = document.createElement("div");
		const editableDiv = document.createElement("div");
		editableDiv.setAttribute("contenteditable", "true");

		const tiptapContainer = document.createElement("div");
		tiptapContainer.className = "tiptap";
		const tiptapChild = document.createElement("p");
		tiptapContainer.appendChild(tiptapChild);

		const alertDialog = document.createElement("div");
		alertDialog.setAttribute("role", "alertdialog");
		const alertChild = document.createElement("button");
		alertDialog.appendChild(alertChild);

		expect(isEditableElement(input)).toBe(true);
		expect(isEditableElement(textarea)).toBe(true);
		expect(isEditableElement(select)).toBe(true);
		expect(isEditableElement(editableDiv)).toBe(true);
		expect(isEditableElement(tiptapChild)).toBe(true);
		expect(isEditableElement(alertChild)).toBe(true);
		expect(isEditableElement(plainDiv)).toBe(false);
		expect(isEditableElement(null)).toBe(false);
	});

	it("initializes with isFocusMode = false", () => {
		const { result } = renderHook(() => useFocusMode(), {
			wrapper: TestWrapper,
		});
		expect(result.current.isFocusMode).toBe(false);
	});

	it("toggles isFocusMode when toggleFocusMode is invoked", () => {
		const { result } = renderHook(() => useFocusMode(), {
			wrapper: TestWrapper,
		});

		act(() => {
			result.current.toggleFocusMode();
		});
		expect(result.current.isFocusMode).toBe(true);

		act(() => {
			result.current.toggleFocusMode();
		});
		expect(result.current.isFocusMode).toBe(false);
	});

	it("SUPPRESSES bare 'F' and Cmd+Shift+F key shortcut when no supported view is registered", async () => {
		const user = userEvent.setup();
		const { result } = renderHook(() => useFocusMode(), {
			wrapper: TestWrapper,
		});

		expect(result.current.isFocusModeAvailable).toBe(false);
		expect(result.current.isFocusMode).toBe(false);

		// Pressing 'F' should do nothing
		await user.keyboard("f");
		expect(result.current.isFocusMode).toBe(false);

		// Pressing 'Cmd+Shift+F' should also do nothing
		await user.keyboard("{Control>}{Shift>}f{/Shift}{/Control}");
		expect(result.current.isFocusMode).toBe(false);
	});

	it("toggles Focus Mode when pressing 'F' key if supported view is registered", async () => {
		const user = userEvent.setup();
		const { result } = renderHook(() => useFocusMode(), {
			wrapper: TestWrapper,
		});

		// Register supported view
		act(() => {
			result.current.registerFocusModeAvailable();
		});
		expect(result.current.isFocusModeAvailable).toBe(true);

		await user.keyboard("f");
		expect(result.current.isFocusMode).toBe(true);
		await user.keyboard("f");
		expect(result.current.isFocusMode).toBe(false);
	});

	it("toggles Focus Mode when pressing Cmd+Shift+F or Ctrl+Shift+F if supported view is registered", async () => {
		const user = userEvent.setup();
		const { result } = renderHook(() => useFocusMode(), {
			wrapper: TestWrapper,
		});

		// Register supported view
		act(() => {
			result.current.registerFocusModeAvailable();
		});
		expect(result.current.isFocusModeAvailable).toBe(true);

		expect(result.current.isFocusMode).toBe(false);
		await user.keyboard("{Control>}{Shift>}f{/Shift}{/Control}");
		expect(result.current.isFocusMode).toBe(true);
	});

	it("SUPPRESSES 'F' key shortcut when typing inside input or textarea", async () => {
		const user = userEvent.setup();

		function TestComponent() {
			const { isFocusMode, registerFocusModeAvailable } = useFocusMode();
			useEffect(() => {
				return registerFocusModeAvailable();
			}, [registerFocusModeAvailable]);
			return (
				<div>
					<input data-testid="test-input" type="text" />
					<textarea data-testid="test-textarea" />
					<span data-testid="status">
						{isFocusMode ? "FOCUS" : "NORMAL"}
					</span>
				</div>
			);
		}

		render(<TestComponent />, { wrapper: TestWrapper });

		const input = screen.getByTestId("test-input");
		const status = screen.getByTestId("status");

		expect(status.textContent).toBe("NORMAL");

		// Type 'f' in input
		await user.type(input, "feature");
		expect(status.textContent).toBe("NORMAL");

		// Type 'f' in textarea
		const textarea = screen.getByTestId("test-textarea");
		await user.type(textarea, "fixing bug");
		expect(status.textContent).toBe("NORMAL");
	});

	it("resets isFocusMode to false when route/pathname changes", () => {
		const { result, rerender } = renderHook(() => useFocusMode(), {
			wrapper: TestWrapper,
		});

		act(() => {
			result.current.toggleFocusMode();
		});
		expect(result.current.isFocusMode).toBe(true);

		// Simulate navigation by changing mock pathname return and re-rendering
		mockPathname.mockReturnValue("/app/projects/p-1/stories/s-1");
		rerender();

		expect(result.current.isFocusMode).toBe(false);
	});
});
