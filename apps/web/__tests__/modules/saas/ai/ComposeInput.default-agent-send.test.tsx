/**
 * Regression test for the Nexus composer dead end (staging finding 2026-07-06).
 *
 * With text typed and NO agent selected, the Send button stayed disabled and
 * Enter silently no-op'd — even though the send pipeline explicitly falls
 * back to the built-in "Nexus" assistant when the selection is empty (see
 * `agentsToUse` in `CopilotPage`'s send handler) and the placeholder promises
 * "or just ask anything". The composer must allow sending with an empty
 * agent selection so that fallback is actually reachable.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@shared/lib/orpc-client", () => ({ orpcClient: {} }));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useBasePath: () => "/app",
	useOrganizationContext: () => ({ organizationId: null }),
}));
vi.mock("@analytics", () => ({
	useAnalytics: () => ({ trackEvent: vi.fn() }),
}));
vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({ user: { id: "u1", name: "Test User" } }),
}));
vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { ComposeInput } from "@saas/ai/components/CopilotPage";

function wrap(ui: ReactElement) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>{ui}</QueryClientProvider>,
	);
}

function renderComposer(value: string) {
	const onSend = vi.fn();
	wrap(
		<ComposeInput
			value={value}
			onChange={vi.fn()}
			onSend={onSend}
			isLoading={false}
			selectedAgents={[]}
			onRemoveAgent={vi.fn()}
			onOpenAgentPicker={vi.fn()}
		/>,
	);
	return { onSend };
}

describe("ComposeInput — sending without an explicit agent selection", () => {
	it("enables Send with text and no agent selected (default-assistant fallback)", async () => {
		const { onSend } = renderComposer("hello");

		const send = screen.getByRole("button", { name: "Send" });
		expect(send).not.toBeDisabled();

		await userEvent.click(send);
		expect(onSend).toHaveBeenCalledWith(
			expect.objectContaining({ message: "hello", files: [] }),
		);
	});

	it("sends on Enter with text and no agent selected", async () => {
		const { onSend } = renderComposer("hello");

		const textarea = screen.getByRole("textbox");
		textarea.focus();
		await userEvent.keyboard("{Enter}");

		expect(onSend).toHaveBeenCalledWith(
			expect.objectContaining({ message: "hello", files: [] }),
		);
	});

	it("keeps Send disabled when there is no content", () => {
		renderComposer("   ");

		expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
	});
});
