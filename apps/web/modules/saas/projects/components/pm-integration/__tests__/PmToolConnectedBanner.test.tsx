import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PmToolConnectedBanner } from "../PmToolConnectedBanner";

describe("PmToolConnectedBanner", () => {
	afterEach(() => {
		localStorage.clear();
	});

	it("renders when tenant-connected and not selected", () => {
		render(
			<PmToolConnectedBanner
				projectId="p1"
				provider="gitlab"
				tenantConnected={true}
				projectSelected={false}
				onUseProvider={vi.fn()}
			/>,
		);
		expect(screen.getByText(/gitlab is connected/i)).toBeInTheDocument();
	});

	it("does not render when tenant not connected", () => {
		const { container } = render(
			<PmToolConnectedBanner
				projectId="p1"
				provider="gitlab"
				tenantConnected={false}
				projectSelected={false}
				onUseProvider={vi.fn()}
			/>,
		);
		expect(container).toBeEmptyDOMElement();
	});

	it("does not render when project already selected the provider", () => {
		const { container } = render(
			<PmToolConnectedBanner
				projectId="p1"
				provider="gitlab"
				tenantConnected={true}
				projectSelected={true}
				onUseProvider={vi.fn()}
			/>,
		);
		expect(container).toBeEmptyDOMElement();
	});

	it("calls onUseProvider when CTA clicked", async () => {
		const onUseProvider = vi.fn();
		render(
			<PmToolConnectedBanner
				projectId="p1"
				provider="gitlab"
				tenantConnected={true}
				projectSelected={false}
				onUseProvider={onUseProvider}
			/>,
		);
		await userEvent.click(
			screen.getByRole("button", { name: /use gitlab as pm tool/i }),
		);
		expect(onUseProvider).toHaveBeenCalledOnce();
	});

	it("does not render after dismiss persists in localStorage", async () => {
		const { rerender, container } = render(
			<PmToolConnectedBanner
				projectId="p1"
				provider="gitlab"
				tenantConnected={true}
				projectSelected={false}
				onUseProvider={vi.fn()}
			/>,
		);
		await userEvent.click(screen.getByRole("button", { name: /dismiss/i }));
		expect(container).toBeEmptyDOMElement();
		// Re-render fresh — should still be dismissed via localStorage
		rerender(
			<PmToolConnectedBanner
				projectId="p1"
				provider="gitlab"
				tenantConnected={true}
				projectSelected={false}
				onUseProvider={vi.fn()}
			/>,
		);
		expect(container).toBeEmptyDOMElement();
	});

	it("does not flash for previously-dismissed users", () => {
		localStorage.setItem("dismissedNudge_gitlab_p1", "1");
		const { container } = render(
			<PmToolConnectedBanner
				projectId="p1"
				provider="gitlab"
				tenantConnected={true}
				projectSelected={false}
				onUseProvider={vi.fn()}
			/>,
		);
		// Even on first render, banner should NOT appear (mounted gate hides it).
		expect(container).toBeEmptyDOMElement();
	});

	it("handles localStorage.setItem throwing gracefully", async () => {
		// Spy on Storage.prototype rather than the localStorage instance —
		// some jsdom configurations route the call through the prototype
		// and don't observe instance-level spies, which makes the
		// instance-spy approach flaky in CI.
		const setItemSpy = vi
			.spyOn(Storage.prototype, "setItem")
			.mockImplementation(() => {
				throw new Error("QuotaExceededError");
			});
		// Suppress the expected console.warn so it doesn't pollute test output.
		const consoleWarnSpy = vi
			.spyOn(console, "warn")
			.mockImplementation(() => {});
		render(
			<PmToolConnectedBanner
				projectId="p1"
				provider="gitlab"
				tenantConnected={true}
				projectSelected={false}
				onUseProvider={vi.fn()}
			/>,
		);
		await userEvent.click(screen.getByRole("button", { name: /dismiss/i }));
		// Core contract: even when setItem throws, the click handler must not
		// crash and the banner must hide (setDismissed(true) still runs).
		expect(
			screen.queryByText(/gitlab is connected/i),
		).not.toBeInTheDocument();
		setItemSpy.mockRestore();
		consoleWarnSpy.mockRestore();
	});

	it("is keyed per project — dismissing one project does not dismiss another", () => {
		localStorage.setItem("dismissedNudge_gitlab_p1", "1");
		render(
			<PmToolConnectedBanner
				projectId="p2"
				provider="gitlab"
				tenantConnected={true}
				projectSelected={false}
				onUseProvider={vi.fn()}
			/>,
		);
		expect(screen.getByText(/gitlab is connected/i)).toBeInTheDocument();
	});
});
