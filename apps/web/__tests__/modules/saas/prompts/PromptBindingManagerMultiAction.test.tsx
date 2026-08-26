/**
 * Binding one prompt to several actions from the dialog (FR19).
 *
 * Two things worth pinning. The common case must keep using the single-bind
 * endpoint, so adding this feature does not quietly route every existing bind
 * through a transaction. And the action the user came to bind is always
 * included — unticking it should not be a way to bind nothing.
 */

import { PromptBindingManager } from "@saas/prompts/components/PromptBindingManager";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getById, bindSet, bindSetMany } = vi.hoisted(() => ({
	getById: vi.fn(),
	bindSet: vi.fn(),
	bindSetMany: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		prompts: {
			get: { byId: (i: unknown) => getById(i) },
			bind: {
				set: (i: unknown) => bindSet(i),
				setMany: (i: unknown) => bindSetMany(i),
			},
		},
	},
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({ user: { id: "user-1", role: null } }),
}));

function wrap(ui: React.ReactElement) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return render(
		<QueryClientProvider client={client}>{ui}</QueryClientProvider>,
	);
}

/** Open the dialog and choose the one document type a GENERAL-only agent has. */
async function openAndPickGeneral() {
	const user = userEvent.setup();
	await user.click(screen.getByRole("button", { name: /set as default/i }));
	await user.click(
		await screen.findByRole("combobox", { name: /document type/i }),
	);
	await user.click(screen.getByRole("option", { name: /general/i }));
	return user;
}

describe("PromptBindingManager — binding to several actions", () => {
	beforeEach(() => {
		getById.mockReset();
		bindSet.mockReset();
		bindSetMany.mockReset();
		getById.mockResolvedValue({
			id: "prompt-1",
			format: "HANDLEBARS",
			versions: [{ id: "pv-1", version: 1, content: "body" }],
		});
		bindSet.mockResolvedValue({ id: "binding-1" });
		bindSetMany.mockResolvedValue({ bound: 2 });
	});

	it("uses the single-bind endpoint when only one action is chosen", async () => {
		wrap(
			<PromptBindingManager
				promptId="prompt-1"
				promptName="Test prompt"
				promptScope="USER"
				promptKey="test_case_drafter"
			/>,
		);

		const user = await openAndPickGeneral();
		await user.click(
			screen.getByRole("button", { name: /^set as default$/i }),
		);

		expect(bindSet).toHaveBeenCalledTimes(1);
		expect(bindSetMany).not.toHaveBeenCalled();
	});

	it("offers other actions to apply the same prompt to", async () => {
		wrap(
			<PromptBindingManager
				promptId="prompt-1"
				promptName="Test prompt"
				promptScope="USER"
				promptKey="test_case_drafter"
			/>,
		);

		await openAndPickGeneral();

		expect(await screen.findByText(/also apply to/i)).toBeInTheDocument();
		// Another agent's action is on offer...
		expect(screen.getByText("Test Case Step Reviser")).toBeInTheDocument();
		// ...and the one already selected is not repeated as a tick-box.
		const checkboxLabels = screen
			.getAllByRole("checkbox")
			.map((c) => c.closest("label")?.textContent ?? "");
		expect(checkboxLabels).not.toContain("Test Case Drafter");
	});

	it("sends every chosen action in one batch, primary included", async () => {
		wrap(
			<PromptBindingManager
				promptId="prompt-1"
				promptName="Test prompt"
				promptScope="USER"
				promptKey="test_case_drafter"
			/>,
		);

		const user = await openAndPickGeneral();
		await user.click(screen.getByText("Test Case Step Reviser"));
		await user.click(
			screen.getByRole("button", { name: /^set as default$/i }),
		);

		expect(bindSet).not.toHaveBeenCalled();
		expect(bindSetMany).toHaveBeenCalledWith(
			expect.objectContaining({
				promptVersionId: "pv-1",
				targets: expect.arrayContaining([
					expect.objectContaining({
						targetKey: "test_case_drafter",
					}),
					expect.objectContaining({
						targetKey: "test_case_step_reviser",
					}),
				]),
			}),
		);
		expect(bindSetMany.mock.calls[0][0].targets).toHaveLength(2);
	});
});
