import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type PropsWithChildren, useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import {
	FocusModeProvider,
	useFocusMode,
} from "../../contexts/FocusModeContext";
import { SidebarCollapseProvider } from "../../contexts/SidebarCollapseContext";
import { FocusModeToggle } from "../FocusModeToggle";

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => {
		const translations: Record<string, string> = {
			enterFocusMode: "Focus Mode",
			enterFocusModeHint: "Hide surrounding headers (F)",
			exitFocusMode: "Exit Focus Mode",
			exitFocusModeHint: "Restore standard header (F)",
		};
		return translations[key] ?? key;
	},
}));

function RegisteredScope({ children }: PropsWithChildren) {
	const { registerFocusModeAvailable } = useFocusMode();
	useEffect(() => {
		return registerFocusModeAvailable();
	}, [registerFocusModeAvailable]);
	return <>{children}</>;
}

function TestWrapper({ children }: PropsWithChildren) {
	return (
		<SidebarCollapseProvider>
			<FocusModeProvider>
				<RegisteredScope>{children}</RegisteredScope>
			</FocusModeProvider>
		</SidebarCollapseProvider>
	);
}

describe("FocusModeToggle Component", () => {
	it("renders button with correct initial label and tooltip", () => {
		render(<FocusModeToggle />, { wrapper: TestWrapper });

		const button = screen.getByRole("button", { name: "Focus Mode" });
		expect(button).toBeInTheDocument();
		expect(button).toHaveTextContent("Focus Mode");
	});

	it("toggles focus mode state on click and updates button label", async () => {
		const user = userEvent.setup();

		function TestConsumer() {
			const { isFocusMode } = useFocusMode();
			return (
				<div>
					<FocusModeToggle />
					<span data-testid="status">
						{isFocusMode ? "ACTIVE" : "INACTIVE"}
					</span>
				</div>
			);
		}

		render(<TestConsumer />, { wrapper: TestWrapper });

		const status = screen.getByTestId("status");
		expect(status.textContent).toBe("INACTIVE");

		const toggleBtn = screen.getByRole("button", { name: "Focus Mode" });
		await user.click(toggleBtn);

		expect(status.textContent).toBe("ACTIVE");
		expect(
			screen.getByRole("button", { name: "Exit Focus Mode" }),
		).toBeInTheDocument();
	});
});
