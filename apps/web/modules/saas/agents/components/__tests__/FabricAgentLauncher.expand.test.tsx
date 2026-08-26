/**
 * Drawer-to-full-page expansion while a reply is streaming (#2040).
 *
 * The control used to be blocked for the whole time a reply was writing,
 * because the chat persisted a turn only on completion — navigating away
 * would have dropped the answer. Two things changed: the conversation is now
 * created when the turn starts, so there is a real id to navigate to, and the
 * drawer panel stays mounted when closed, so the stream finishes into that
 * same conversation.
 *
 * That only holds where the navigation keeps `AppWrapper` mounted. In
 * organization context it does — one wrapper from `[organizationSlug]/layout`
 * with the agents route a passthrough beneath it. Personal context mounts a
 * second wrapper under `app/agents/layout`, so the same navigation remounts
 * the shell and would take the stream with it; the block stays there, and
 * these tests pin both halves so the asymmetry cannot drift unnoticed.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FabricAgentLauncherProvider } from "../FabricAgentLauncher";

vi.mock("next/navigation", () => ({
	usePathname: () => "/app/projects/project_1",
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@tanstack/react-query")>();
	return {
		...actual,
		useQuery: vi.fn(() => ({ data: undefined, isLoading: false })),
		useQueryClient: vi.fn(() => ({ invalidateQueries: vi.fn() })),
	};
});

// jsdom cannot follow an href, and these assertions are about the drawer's own
// behaviour rather than the browser's. Keeps the anchor — and so the `link`
// role and `href` — while dropping the navigation attempt.
vi.mock("next/link", async () => {
	const React = await import("react");
	return {
		default: ({ children, onClick, ...rest }: React.ComponentProps<"a">) =>
			React.createElement(
				"a",
				{
					...rest,
					onClick: (event: React.MouseEvent<HTMLAnchorElement>) => {
						event.preventDefault();
						onClick?.(event);
					},
				},
				children,
			),
	};
});

const organizationContext = vi.hoisted(() => ({
	organizationId: "org_1" as string | null,
	basePath: "/app/acme",
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => organizationContext,
}));

/**
 * Stands in for the real chat and hands the test its two outward signals: the
 * conversation id the turn created, and whether a reply is in flight.
 */
vi.mock("next/dynamic", async () => {
	function MockDirectChat({
		onConversationCreated,
		onStreamingChange,
	}: {
		onConversationCreated?: (id: string) => void;
		onStreamingChange?: (streaming: boolean) => void;
	}) {
		return (
			<div>
				<button
					type="button"
					onClick={() => {
						onConversationCreated?.("conv_42");
						onStreamingChange?.(true);
					}}
				>
					start turn
				</button>
				<button
					type="button"
					onClick={() => onStreamingChange?.(false)}
				>
					finish turn
				</button>
			</div>
		);
	}

	return { default: () => MockDirectChat };
});

afterEach(() => {
	cleanup();
	organizationContext.organizationId = "org_1";
	organizationContext.basePath = "/app/acme";
});

function openDrawerAndStartTurn() {
	render(
		<FabricAgentLauncherProvider>
			<div>page content</div>
		</FabricAgentLauncherProvider>,
	);
	fireEvent.click(screen.getByRole("button", { name: /Fabric Agent/i }));
	fireEvent.click(screen.getByRole("button", { name: "start turn" }));
}

describe("FabricAgentLauncher — expand while streaming (#2040)", () => {
	it("stays available mid-reply in organization context, carrying the conversation", () => {
		openDrawerAndStartTurn();

		const expand = screen.getByRole("link", { name: "Expand" });
		expect(expand).toHaveAttribute(
			"href",
			"/app/acme/agents/fabric-ai?c=conv_42",
		);
	});

	it("holds the drawer open until the reply lands, then closes it", () => {
		openDrawerAndStartTurn();

		fireEvent.click(screen.getByRole("link", { name: /Expand/ }));

		// Still open: the page underneath can only render what is persisted, so
		// closing now would show the question alone, looking idle, and invite a
		// second send into a conversation already mid-turn.
		expect(screen.getByLabelText("Fabric Agent")).toHaveAttribute(
			"aria-hidden",
			"false",
		);
		expect(screen.getByRole("link", { name: /Expanding/ })).toBeVisible();

		fireEvent.click(screen.getByRole("button", { name: "finish turn" }));

		expect(screen.getByLabelText("Fabric Agent")).toHaveAttribute(
			"aria-hidden",
			"true",
		);
	});

	it("closes immediately when nothing is streaming", () => {
		render(
			<FabricAgentLauncherProvider>
				<div>page content</div>
			</FabricAgentLauncherProvider>,
		);
		fireEvent.click(screen.getByRole("button", { name: /Fabric Agent/i }));

		fireEvent.click(screen.getByRole("link", { name: "Expand" }));

		expect(screen.getByLabelText("Fabric Agent")).toHaveAttribute(
			"aria-hidden",
			"true",
		);
	});

	it("blocks mid-reply in personal context, where the navigation would remount the shell", () => {
		organizationContext.organizationId = null;
		organizationContext.basePath = "/app";

		openDrawerAndStartTurn();

		expect(screen.queryByRole("link", { name: "Expand" })).toBeNull();
		const blocked = screen.getByRole("button", { name: "Expand" });
		expect(blocked).toBeDisabled();
		// The reason has to reach a screen reader, not only a tooltip.
		expect(blocked).toHaveAttribute("aria-disabled", "true");
		expect(blocked.getAttribute("title")).toMatch(/reply/i);
	});

	it("comes back in personal context once the reply lands", () => {
		organizationContext.organizationId = null;
		organizationContext.basePath = "/app";

		openDrawerAndStartTurn();
		fireEvent.click(screen.getByRole("button", { name: "finish turn" }));

		expect(screen.getByRole("link", { name: "Expand" })).toHaveAttribute(
			"href",
			"/app/agents/fabric-ai?c=conv_42",
		);
	});

	it("points at a bare full page before any turn has created a conversation", () => {
		render(
			<FabricAgentLauncherProvider>
				<div>page content</div>
			</FabricAgentLauncherProvider>,
		);
		fireEvent.click(screen.getByRole("button", { name: /Fabric Agent/i }));

		expect(screen.getByRole("link", { name: "Expand" })).toHaveAttribute(
			"href",
			"/app/acme/agents/fabric-ai",
		);
	});
});
