/**
 * Which document type the dialog actually persists.
 *
 * Two different predicates live near each other here and read almost the same:
 *
 *   - "never resolves a storyKind" — true of any agent with no drafting stages,
 *     and the reason the kind selector is locked for it.
 *   - "resolves exactly one binding, documentType GENERAL" — true only of an
 *     agent whose *sole* document type is GENERAL, and the reason the submitted
 *     documentType is overridden.
 *
 * `document_generator` satisfies the first and not the second: it has no stages,
 * but it binds GENERAL, PRD, PROPOSAL and ARCHITECTURE. Using the first
 * predicate to drive the override silently writes GENERAL when the user picked
 * PRD, which the dropdown still shows as selected. That is what this pins.
 */

import { SetAsDefaultDialog } from "@saas/prompts/components/SetAsDefaultDialog";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

const { bindSet } = vi.hoisted(() => ({ bindSet: vi.fn() }));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		prompts: { bind: { set: (input: unknown) => bindSet(input) } },
	},
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({ user: { id: "user-1", role: null } }),
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org-1",
		isOrgContext: true,
	}),
}));

async function pick(
	user: ReturnType<typeof userEvent.setup>,
	label: RegExp,
	option: RegExp,
) {
	await user.click(await screen.findByRole("combobox", { name: label }));
	await user.click(await screen.findByRole("option", { name: option }));
}

describe("SetAsDefaultDialog — persisted document type", () => {
	beforeEach(() => {
		bindSet.mockReset();
		bindSet.mockResolvedValue({ id: "binding-1" });
	});

	it("keeps the chosen document type for a multi-type agent", async () => {
		const user = userEvent.setup();
		wrap(
			<SetAsDefaultDialog
				open
				onOpenChange={() => {}}
				promptName="Test prompt"
				promptVersionId="pv-1"
			/>,
		);

		await pick(user, /agent/i, /^document generator$/i);
		await pick(user, /document type/i, /^prd$/i);

		await user.click(
			screen.getByRole("button", { name: /^set as default$/i }),
		);

		expect(bindSet).toHaveBeenCalledWith(
			expect.objectContaining({
				targetKey: "document_generator",
				documentType: "PRD",
			}),
		);
	});

	it("offers only stage-capable agents when opened from a stage panel", async () => {
		// A kind-scoped card passes storyKind through, so the whole
		// surrounding page is about one drafting stage. An agent with no stages
		// cannot bind to it; offering one invites a binding that silently has
		// nothing to do with the stage the user was configuring.
		const user = userEvent.setup();
		wrap(
			<SetAsDefaultDialog
				open
				onOpenChange={() => {}}
				promptName="Test prompt"
				promptVersionId="pv-1"
				storyKind="FEATURE"
			/>,
		);

		await user.click(
			await screen.findByRole("combobox", { name: /agent/i }),
		);

		expect(
			screen.getByRole("option", { name: /project document generator/i }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("option", { name: /meeting agenda generator/i }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("option", { name: /work item classifier/i }),
		).not.toBeInTheDocument();
	});

	it("forces GENERAL for an agent that only ever binds GENERAL", async () => {
		const user = userEvent.setup();
		wrap(
			<SetAsDefaultDialog
				open
				onOpenChange={() => {}}
				promptName="Test prompt"
				promptVersionId="pv-1"
			/>,
		);

		await pick(user, /agent/i, /^work item classifier$/i);

		await user.click(
			screen.getByRole("button", { name: /^set as default$/i }),
		);

		expect(bindSet).toHaveBeenCalledWith(
			expect.objectContaining({
				targetKey: "work_item_classifier",
				documentType: "GENERAL",
			}),
		);
	});
});
