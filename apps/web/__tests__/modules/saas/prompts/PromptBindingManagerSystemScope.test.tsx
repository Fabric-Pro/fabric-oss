/**
 * Who is offered the universal tier in the binding dialog.
 *
 * FR1 of card 2068: a Fabric Admin sets the universal default from the UI,
 * rather than through a seed script. The gate is the platform role
 * (`User.role === "admin"`), which is a different field from an organization
 * member's role — an org admin must not see this option.
 *
 * The API enforces the same rule; this covers the surface that offers it.
 */

import { PromptBindingManager } from "@saas/prompts/components/PromptBindingManager";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getById, bindSet, sessionUser } = vi.hoisted(() => ({
	getById: vi.fn(),
	bindSet: vi.fn(),
	sessionUser: { current: { id: "user-1", role: null as string | null } },
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		prompts: {
			get: { byId: (input: unknown) => getById(input) },
			bind: { set: (input: unknown) => bindSet(input) },
		},
	},
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({ user: sessionUser.current }),
}));

function wrap(ui: React.ReactElement) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>{ui}</QueryClientProvider>,
	);
}

/**
 * Open the dialog, then the Binding Scope select.
 *
 * `combobox` never takes its accessible name from its own content, so this
 * only resolves because each trigger is associated with its label — which is
 * also what a screen reader needs to announce the control.
 */
async function openScopeSelect() {
	const user = userEvent.setup();
	await user.click(screen.getByRole("button", { name: /set as default/i }));
	await user.click(await screen.findByLabelText(/binding scope/i));
	return user;
}

describe("PromptBindingManager — universal tier option", () => {
	beforeEach(() => {
		getById.mockReset();
		bindSet.mockReset();
		getById.mockResolvedValue({
			id: "prompt-1",
			format: "HANDLEBARS",
			versions: [{ id: "pv-1", version: 1, content: "body" }],
		});
		sessionUser.current = { id: "user-1", role: null };
	});

	it("does not offer the universal tier to a non-admin", async () => {
		wrap(
			<PromptBindingManager
				promptId="prompt-1"
				promptName="Test prompt"
				promptScope="SYSTEM"
				organizationId="org-1"
			/>,
		);

		await openScopeSelect();

		expect(
			screen.queryByRole("option", { name: /system/i }),
		).not.toBeInTheDocument();
		expect(
			screen.getByRole("option", { name: /personal/i }),
		).toBeInTheDocument();
	});

	it("offers the system tier to a platform admin", async () => {
		sessionUser.current = { id: "user-1", role: "admin" };

		wrap(
			<PromptBindingManager
				promptId="prompt-1"
				promptName="Test prompt"
				promptScope="SYSTEM"
				organizationId="org-1"
			/>,
		);

		await openScopeSelect();

		expect(
			screen.getByRole("option", { name: /system/i }),
		).toBeInTheDocument();
	});

	it("sends scope SYSTEM when the admin picks the system tier", async () => {
		sessionUser.current = { id: "user-1", role: "admin" };
		bindSet.mockResolvedValue({ id: "binding-1" });

		wrap(
			<PromptBindingManager
				promptId="prompt-1"
				promptName="Test prompt"
				promptScope="SYSTEM"
				promptKey="test_case_drafter"
				organizationId="org-1"
			/>,
		);

		const user = await openScopeSelect();
		await user.click(screen.getByRole("option", { name: /system/i }));

		// test_case_drafter is a non-stage agent, so GENERAL is its only
		// document type — pick it so the submit button enables.
		await user.click(
			await screen.findByRole("combobox", { name: /document type/i }),
		);
		await user.click(screen.getByRole("option", { name: /general/i }));

		await user.click(
			screen.getByRole("button", { name: /^set as default$/i }),
		);

		expect(bindSet).toHaveBeenCalledWith(
			expect.objectContaining({
				scope: "SYSTEM",
				targetKey: "test_case_drafter",
				documentType: "GENERAL",
				// A universal binding is not an org binding, whatever org the
				// admin happens to be viewing from.
				organizationId: null,
			}),
		);
	});
});
