/**
 * Fizzy #2249: a `get.byId` failure of any kind used to render the same
 * "Prompt not found" copy as an absent prompt — no retry for a transport/5xx
 * failure that has nothing to do with the prompt being gone.
 *
 * Run with:
 *   pnpm --filter web test __tests__/modules/saas/prompts/PromptEnhancePage.test.tsx
 */

import { ORPCError } from "@orpc/client";
import { PromptEnhancePage } from "@saas/prompts/components/PromptEnhancePage";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getById } = vi.hoisted(() => ({ getById: vi.fn() }));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		prompts: {
			get: {
				byId: {
					queryOptions: ({ input }: { input: unknown }) => ({
						queryKey: ["prompts.get.byId", input],
						queryFn: () => getById(input),
					}),
					queryKey: ({ input }: { input: unknown }) => [
						"prompts.get.byId",
						input,
					],
				},
			},
		},
	},
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { prompts: { version: { create: vi.fn() } } },
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: null,
		basePath: "/app",
	}),
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

// None of these mount on the error/not-found branches under test, but their
// real modules pull in CopilotKit's own CSS and a streamdown/katex chain that
// vitest's jsdom environment cannot load — stubbed rather than exercised.
vi.mock("@copilotkit/react-core", () => ({
	CopilotKit: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@copilotkit/react-ui/styles.css", () => ({}));
vi.mock("@saas/shared/components/copilot/CopilotChatSessionProvider", () => ({
	CopilotChatSessionProvider: ({ children }: { children: React.ReactNode }) =>
		children,
}));
vi.mock("@saas/prompts/components/PromptContentEnhancer", () => ({
	PromptContentEnhancer: () => null,
}));

function wrap(ui: React.ReactElement) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>{ui}</QueryClientProvider>,
	);
}

describe("PromptEnhancePage — load failure vs not found", () => {
	beforeEach(() => {
		getById.mockReset();
	});

	it("says the prompt does not exist or is inaccessible on NOT_FOUND, with no alert or retry", async () => {
		getById.mockRejectedValue(new ORPCError("NOT_FOUND"));

		wrap(<PromptEnhancePage promptId="p-1" />);

		await screen.findByText(
			/does not exist, or you do not have access to it/i,
		);
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Try again" }),
		).not.toBeInTheDocument();
	});

	it("shows a retry alert for a transport/500 failure, not a not-found dead end", async () => {
		getById.mockRejectedValue(new Error("upstream 500"));

		wrap(<PromptEnhancePage promptId="p-1" />);

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("Could not load this prompt.");
		expect(alert).not.toHaveTextContent("upstream 500");
		expect(
			screen.queryByText(/does not exist, or you do not have access/i),
		).not.toBeInTheDocument();
	});

	it("retries the read when Try again is clicked", async () => {
		// Second call also fails (this time NOT_FOUND), so the assertion stays
		// inside the two error branches under test rather than depending on
		// the CopilotKit-wrapped success view, which is out of scope here.
		getById
			.mockRejectedValueOnce(new Error("upstream 500"))
			.mockRejectedValueOnce(new ORPCError("NOT_FOUND"));
		const user = userEvent.setup();

		wrap(<PromptEnhancePage promptId="p-1" />);

		const alert = await screen.findByRole("alert");
		await user.click(
			within(alert).getByRole("button", { name: "Try again" }),
		);

		await screen.findByText(
			/does not exist, or you do not have access to it/i,
		);
		expect(getById).toHaveBeenCalledTimes(2);
	});
});
