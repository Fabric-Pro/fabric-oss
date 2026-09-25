/**
 * Fizzy #2249: a failed `get.byId` read left the "Set as Default" submit
 * button silently disabled (`!latestVersion`) with no explanation and no
 * retry — indistinguishable from the dialog simply loading.
 *
 * Run with:
 *   pnpm --filter web test __tests__/modules/saas/prompts/PromptBindingManagerLoadFailure.test.tsx
 */

import { PromptBindingManager } from "@saas/prompts/components/PromptBindingManager";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getById, bindSet } = vi.hoisted(() => ({
	getById: vi.fn(),
	bindSet: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		prompts: {
			get: { byId: (input: unknown) => getById(input) },
			bindings: { set: (input: unknown) => bindSet(input) },
		},
	},
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({ user: { id: "user-1", role: null } }),
}));

function wrap(ui: React.ReactElement) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>{ui}</QueryClientProvider>,
	);
}

const openDialog = async (user: ReturnType<typeof userEvent.setup>) => {
	wrap(
		<PromptBindingManager
			promptId="prompt-1"
			promptKey="test_case_drafter"
			promptName="Test Case Drafter"
			promptScope="USER"
		/>,
	);
	await user.click(screen.getByRole("button", { name: /set as default/i }));
};

describe("PromptBindingManager — prompt-details load failure", () => {
	beforeEach(() => {
		getById.mockReset();
		bindSet.mockReset();
	});

	it("explains why Set as Default is disabled, with a retry", async () => {
		getById.mockRejectedValue(new Error("upstream 500"));
		const user = userEvent.setup();

		await openDialog(user);

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent(
			"Could not load this prompt's latest version, so it cannot be set as default yet.",
		);
		expect(alert).not.toHaveTextContent("upstream 500");

		const submit = screen.getByRole("button", {
			name: "Set as Default",
		});
		expect(submit).toBeDisabled();

		// Above the form, not under it: at the bottom of the scroll area it was
		// clipped out of view on a phone.
		const agentLabel = screen.getByText("Agent", { selector: "label" });
		expect(
			alert.compareDocumentPosition(agentLabel) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("retries the read from the notice", async () => {
		getById
			.mockRejectedValueOnce(new Error("upstream 500"))
			.mockResolvedValueOnce({
				id: "prompt-1",
				format: "HANDLEBARS",
				versions: [{ id: "v1", version: 1, content: "body" }],
			});
		const user = userEvent.setup();

		await openDialog(user);

		const alert = await screen.findByRole("alert");
		await user.click(
			within(alert).getByRole("button", { name: /try again/i }),
		);

		// The submit button also needs a document type picked, so this only
		// asserts what retrying actually changes: the read landed and the
		// notice cleared.
		await waitFor(() =>
			expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
		);
		expect(getById).toHaveBeenCalledTimes(2);
	});
});
