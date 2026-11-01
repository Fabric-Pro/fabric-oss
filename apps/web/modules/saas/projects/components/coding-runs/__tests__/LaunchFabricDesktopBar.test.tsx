import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LaunchFabricDesktopBar } from "../LaunchFabricDesktopBar";

vi.mock("sonner", () => ({
	toast: {
		success: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
	},
}));

describe("LaunchFabricDesktopBar", () => {
	it("renders both Launch Fabric Desktop and Delegate to Remote Server buttons and opens the subscription delegation panel", () => {
		render(
			<LaunchFabricDesktopBar
				projectId="proj_123"
				projectName="Payments V2"
				webUiUrl="https://agents.example.com"
			/>,
		);

		const desktopLink = screen.getByTestId("launch-fabric-desktop-button");
		expect(desktopLink).toBeInTheDocument();
		expect(desktopLink.getAttribute("href")).toContain(
			"fabricagents://action/new-chat?name=Payments+V2",
		);

		const delegateBtn = screen.getByTestId(
			"delegate-remote-agent-server-button",
		);
		expect(delegateBtn).toBeInTheDocument();

		fireEvent.click(delegateBtn);

		const panel = screen.getByTestId("remote-server-delegation-panel");
		expect(panel).toBeInTheDocument();

		// Select Claude Max subscription harness
		fireEvent.click(screen.getByText("Claude"));

		const verifyBtn = screen.getByTestId(
			"verify-subscription-credits-button",
		);
		expect(verifyBtn).toHaveTextContent(/Subscription Credits Verified/i);

		const webUiLink = screen.getByTestId("open-remote-server-webui-link");
		expect(webUiLink.getAttribute("href")).toContain(
			"https://agents.example.com/?",
		);
		expect(webUiLink.getAttribute("href")).toContain("harness=claude-max");
		expect(webUiLink.getAttribute("href")).toContain(
			"fallback=subscription_harnesses",
		);
	});

	it("renders compact mode with both Desktop and Remote Server delegation controls", () => {
		render(
			<LaunchFabricDesktopBar
				projectId="proj_123"
				projectSlug="payments-v2"
				compact
			/>,
		);

		expect(
			screen.getByTestId("launch-fabric-desktop-button"),
		).toBeInTheDocument();
		const delegateBtn = screen.getByTestId(
			"delegate-remote-agent-server-button",
		);
		fireEvent.click(delegateBtn);
		expect(
			screen.getByTestId("remote-server-delegation-panel"),
		).toBeInTheDocument();
	});
});
