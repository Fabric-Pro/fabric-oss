/**
 * Fizzy #2249: a `get.byId` failure used to render the sheet as if a prompt
 * with no content existed — title fell back to "Prompt", body read "No
 * content available". Neither is true on a failed read.
 *
 * Run with:
 *   pnpm --filter web test __tests__/modules/saas/prompts/PromptPreviewSheetLoadFailure.test.tsx
 */

import { ORPCError } from "@orpc/client";
import { PromptPreviewSheet } from "@saas/prompts/components/PromptPreviewSheet";
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
				},
			},
		},
	},
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		prompts: { version: { create: vi.fn() }, fork: { fork: vi.fn() } },
	},
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: null,
		basePath: "/app",
	}),
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

function wrap(ui: React.ReactElement) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>{ui}</QueryClientProvider>,
	);
}

describe("PromptPreviewSheet — load failure vs not found", () => {
	beforeEach(() => {
		getById.mockReset();
	});

	it("shows not-found copy and title on NOT_FOUND, never the empty-content body", async () => {
		getById.mockRejectedValue(new ORPCError("NOT_FOUND"));

		wrap(
			<PromptPreviewSheet
				open
				onOpenChange={vi.fn()}
				promptId="p-1"
				promptScope="USER"
			/>,
		);

		await screen.findByText(
			/does not exist, or you do not have access to it/i,
		);
		expect(screen.getByText("Prompt not found")).toBeInTheDocument();
		expect(
			screen.queryByText("No content available"),
		).not.toBeInTheDocument();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("shows a LoadFailure alert and title on a transport/500 failure, never the empty-content body", async () => {
		getById.mockRejectedValue(new Error("upstream 500"));

		wrap(
			<PromptPreviewSheet
				open
				onOpenChange={vi.fn()}
				promptId="p-1"
				promptScope="USER"
			/>,
		);

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("Could not load this prompt.");
		expect(alert).not.toHaveTextContent("upstream 500");
		expect(screen.getByText("Could not load prompt")).toBeInTheDocument();
		expect(
			screen.queryByText("No content available"),
		).not.toBeInTheDocument();
	});

	it("retries the read from the alert", async () => {
		getById
			.mockRejectedValueOnce(new Error("upstream 500"))
			.mockRejectedValueOnce(new ORPCError("NOT_FOUND"));
		const user = userEvent.setup();

		wrap(
			<PromptPreviewSheet
				open
				onOpenChange={vi.fn()}
				promptId="p-1"
				promptScope="USER"
			/>,
		);

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
