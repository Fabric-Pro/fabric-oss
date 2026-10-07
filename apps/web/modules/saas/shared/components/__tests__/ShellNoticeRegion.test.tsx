import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const pathname = { current: "/app/example-org/start" };
vi.mock("next/navigation", () => ({
	usePathname: () => pathname.current,
}));

const securityVisible = { current: true };
const useMfaNoticeVisible = vi.fn(() => securityVisible.current);
vi.mock("@saas/shared/components/MfaSetupBanner", () => ({
	useMfaNoticeVisible: () => useMfaNoticeVisible(),
	MfaSetupBanner: () => <div data-testid="security-notice">Secure</div>,
}));

const chatgptPlanVisible = { current: false };
vi.mock("@saas/settings/components/chatgpt-plan/ChatgptPlanPrompt", () => ({
	useChatgptPlanPromptVisible: () => chatgptPlanVisible.current,
	ChatgptPlanPrompt: () => <div data-testid="chatgpt-plan-notice">Plan</div>,
}));

const chatgptPlanReconnectVisible = { current: false };
vi.mock(
	"@saas/settings/components/chatgpt-plan/ChatgptPlanReconnectActions",
	() => ({
		useChatgptPlanReconnectNoticeVisible: () =>
			chatgptPlanReconnectVisible.current,
		ChatgptPlanReconnectNotice: () => (
			<div data-testid="chatgpt-plan-reconnect-notice">Reconnect</div>
		),
	}),
);

const chatgptPlanSharedFallbackVisible = { current: false };
vi.mock(
	"@saas/settings/components/chatgpt-plan/ChatgptPlanSharedFallbackNotice",
	() => ({
		useChatgptPlanSharedFallbackVisible: () =>
			chatgptPlanSharedFallbackVisible.current,
		ChatgptPlanSharedFallbackNotice: () => (
			<div data-testid="chatgpt-plan-shared-fallback-notice">Shared</div>
		),
	}),
);

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) =>
		key === "app.shellNotices.ariaLabel"
			? "Account and setup notices"
			: key,
}));

import { ShellNoticeRegion, ShellNoticeStack } from "../ShellNoticeRegion";

beforeEach(() => {
	pathname.current = "/app/example-org/start";
	securityVisible.current = true;
	chatgptPlanVisible.current = false;
	chatgptPlanReconnectVisible.current = false;
	chatgptPlanSharedFallbackVisible.current = false;
	useMfaNoticeVisible.mockClear();
});

describe("ShellNoticeStack", () => {
	it("renders no element at all when it holds nothing", () => {
		// Not "renders an empty wrapper": a wrapper still occupies the DOM and
		// still carries its own padding. A React parent cannot see that a child
		// returned null, which is why membership is decided before render
		// rather than left to the children.
		const { container } = render(<ShellNoticeStack notices={[]} />);
		expect(container.firstChild).toBeNull();
	});

	it("renders members in the order it is given", () => {
		// The stack keeps whatever order the region hands it; the region's own
		// tier order is pinned in the "ShellNoticeRegion" cases below.
		render(
			<ShellNoticeStack
				notices={[
					{ id: "security", node: <div>security notice</div> },
					{ id: "onboarding", node: <div>onboarding notice</div> },
				]}
			/>,
		);

		const region = screen.getByRole("complementary");
		expect(region.textContent).toBe("security noticeonboarding notice");
	});

	it("owns the spacing rather than pushing it onto its members", () => {
		render(
			<ShellNoticeStack
				notices={[{ id: "security", node: <div>notice</div> }]}
			/>,
		);

		const region = screen.getByRole("complementary");
		expect(region.className).toContain("gap-3");
		// The full-height routes nest this column in `h-full overflow-hidden`,
		// where a shrinkable child is compressed instead of reserving height.
		expect(region.className).toContain("shrink-0");
	});

	it("carries no positioning of its own", () => {
		render(
			<ShellNoticeStack
				notices={[{ id: "security", node: <div>notice</div> }]}
			/>,
		);

		const region = screen.getByRole("complementary");
		for (const token of ["fixed", "absolute", "z-"]) {
			expect(region.className).not.toContain(token);
		}
	});

	it("exposes one labelled landmark and no assertive live region", () => {
		// `Alert` hardcodes role="alert", so a region full of Alerts would
		// announce once per member. Nothing in the region uses Alert today; a
		// future member that does must suppress its role here.
		render(
			<ShellNoticeStack
				notices={[
					{ id: "security", node: <div>a</div> },
					{ id: "onboarding", node: <div>b</div> },
				]}
			/>,
		);

		const regions = screen.getAllByRole("complementary");
		expect(regions).toHaveLength(1);
		expect(regions[0]).toHaveAccessibleName("Account and setup notices");
		expect(within(regions[0]).queryAllByRole("alert")).toHaveLength(0);
		expect(regions[0]).not.toHaveAttribute("aria-live");
	});
});

describe("ShellNoticeRegion", () => {
	it("renders the security notice when it has something to say", () => {
		render(<ShellNoticeRegion />);
		expect(screen.getByTestId("security-notice")).toBeInTheDocument();
	});

	it("puts the ChatGPT plan prompt after the security notice", () => {
		chatgptPlanVisible.current = true;
		render(<ShellNoticeRegion />);
		expect(screen.getByRole("complementary").textContent).toBe(
			"SecurePlan",
		);
	});

	it("puts the ChatGPT plan reconnect notice after security and before the prompt", () => {
		chatgptPlanVisible.current = true;
		chatgptPlanReconnectVisible.current = true;
		render(<ShellNoticeRegion />);
		expect(screen.getByRole("complementary").textContent).toBe(
			"SecureReconnectPlan",
		);
	});

	// Fizzy #2770: the member's own plan is spent and the shared plan carries
	// their work. A warning with nothing to act on, so after the reconnect
	// notice and before the one-time prompt.
	it("puts the shared-plan warning after reconnect and before the prompt", () => {
		chatgptPlanVisible.current = true;
		chatgptPlanReconnectVisible.current = true;
		chatgptPlanSharedFallbackVisible.current = true;
		render(<ShellNoticeRegion />);
		expect(screen.getByRole("complementary").textContent).toBe(
			"SecureReconnectSharedPlan",
		);
	});

	it("renders nothing when no member is visible", () => {
		securityVisible.current = false;
		const { container } = render(<ShellNoticeRegion />);
		expect(container.firstChild).toBeNull();
	});

	/**
	 * These paint their own `fixed inset-y-0` chrome over the viewport, which
	 * would cover an in-flow notice. The region yields instead of competing —
	 * it holds no z-index to compete with.
	 */
	it.each([
		"/app/example-org/projects/proj-1/documents/doc-1",
		"/app/example-org/projects/proj-1/stories/story-1",
		"/app/example-org/agents/document-generator",
		"/app/example-org/agents/task-planner",
		"/app/example-org/agents/fabric-ai",
		"/app/example-org/agents/agent-1/try",
	])("yields on the full-bleed route %s", (route) => {
		pathname.current = route;
		const { container } = render(<ShellNoticeRegion />);
		expect(container.firstChild).toBeNull();
		// The route is gated before the members mount, so a route that can
		// never show a notice does not pay for the members' queries either.
		expect(useMfaNoticeVisible).not.toHaveBeenCalled();
	});

	/**
	 * AppWrapper's `isFullHeightRoute` covers these. They own their scrolling
	 * but stay inside the content column, so an in-flow notice is visible —
	 * swapping the two predicates would hide the notice on the wrong half of
	 * the app.
	 */
	it.each([
		"/app/example-org/workflows/wf-1",
		"/app/example-org/chatbot",
		"/app/example-org/nexus",
		"/app/example-org/projects/proj-1/kanban",
	])("still renders on the full-height route %s", (route) => {
		pathname.current = route;
		render(<ShellNoticeRegion />);
		expect(screen.getByTestId("security-notice")).toBeInTheDocument();
		expect(useMfaNoticeVisible).toHaveBeenCalled();
	});
});
