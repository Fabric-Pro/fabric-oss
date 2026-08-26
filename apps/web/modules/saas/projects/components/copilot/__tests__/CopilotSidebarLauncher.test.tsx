/**
 * Tests for the branded AI Assistant launcher (the reopen control).
 *
 * The launcher is the reopen half of the close/reopen pair: it renders nothing
 * while the panel is open (the header's X owns closing) and a labelled pill
 * while it is closed, calling the shared chat context's `setOpen(true)`.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const setOpenMock = vi.fn();
const useChatContextMock = vi.fn();

vi.mock("@copilotkit/react-ui", () => ({
	useChatContext: () => useChatContextMock(),
}));

// Import AFTER vi.mock so the component sees the stubbed hook.
import {
	CopilotSidebarLauncher,
	createCopilotSidebarLauncher,
} from "../CopilotSidebarLauncher";

beforeEach(() => {
	vi.clearAllMocks();
});

describe("CopilotSidebarLauncher", () => {
	it("renders nothing while the panel is open", () => {
		useChatContextMock.mockReturnValue({
			open: true,
			setOpen: setOpenMock,
		});
		const { container } = render(<CopilotSidebarLauncher />);
		expect(container.firstChild).toBeNull();
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("renders a labelled pill that reopens the panel via setOpen(true) while closed", () => {
		useChatContextMock.mockReturnValue({
			open: false,
			setOpen: setOpenMock,
		});
		render(<CopilotSidebarLauncher />);

		const button = screen.getByRole("button", { name: "AI Assistant" });
		fireEvent.click(button);
		expect(setOpenMock).toHaveBeenCalledWith(true);
	});

	it("honours a custom label", () => {
		useChatContextMock.mockReturnValue({
			open: false,
			setOpen: setOpenMock,
		});
		render(<CopilotSidebarLauncher label="Feature Assistant" />);
		expect(
			screen.getByRole("button", { name: "Feature Assistant" }),
		).toBeTruthy();
	});

	it("factory renders the default-labelled pill while closed", () => {
		useChatContextMock.mockReturnValue({
			open: false,
			setOpen: setOpenMock,
		});
		const Launcher = createCopilotSidebarLauncher();
		render(<Launcher />);
		expect(
			screen.getByRole("button", { name: "AI Assistant" }),
		).toBeTruthy();
	});
});
