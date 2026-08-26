/**
 * Tier 3 of the catalog: the prompts bound to one action, and switching between
 * them.
 *
 * FR9 wants the variants visible, FR10 wants any of them selectable with each
 * one's tier legible, and FR8 leans on both — the "the default changed" notice
 * deep-links here, so a page that only names the winner strands the reader.
 *
 * The part worth pinning is WHICH tier a switch writes at. It is not offered as
 * a choice, because only one tier would actually take effect for the person
 * clicking: their own personal default in personal context, the organization's
 * if they may set it, and otherwise a proposal. Writing a personal override
 * inside an organization would create a row the runtime never reads.
 *
 * Run with:
 *   pnpm --filter web test __tests__/modules/saas/prompts/ActionPromptList.test.tsx
 */

import { ActionPromptList } from "@saas/prompts/components/ActionPromptList";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { bindSet, bindClear, nominate, orgCtx, isOrgAdmin } = vi.hoisted(() => ({
	bindSet: vi.fn(),
	bindClear: vi.fn(),
	nominate: vi.fn(),
	orgCtx: { organizationId: "org-1" as string | null, isOrgContext: true },
	isOrgAdmin: { current: false },
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		prompts: {
			bind: {
				set: (i: unknown) => bindSet(i),
				clear: (i: unknown) => bindClear(i),
			},
			nominations: { create: (i: unknown) => nominate(i) },
		},
	},
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => orgCtx,
}));

vi.mock("@saas/organizations/hooks/use-active-organization", () => ({
	useActiveOrganization: () => ({
		isOrganizationAdmin: isOrgAdmin.current,
	}),
}));

const variant = (
	name: string,
	scope: "SYSTEM" | "ORG" | "USER",
	isEffective = false,
) => ({
	promptId: `p-${name}`,
	promptName: name,
	promptVersionId: `pv-${name}`,
	scope,
	isDefault: isEffective,
	isEffective,
});

const onChanged = vi.fn();

function renderList(
	prompts = [
		variant("Baseline drafter", "SYSTEM", true),
		variant("Our tighter one", "ORG"),
	],
) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return render(
		<QueryClientProvider client={client}>
			<ActionPromptList
				targetKey="test_case_drafter"
				documentType="GENERAL"
				storyKind={null}
				prompts={prompts}
				basePath="/app/acme"
				onChanged={onChanged}
			/>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	bindSet.mockReset();
	bindSet.mockResolvedValue({ id: "b1" });
	bindClear.mockReset();
	bindClear.mockResolvedValue({ cleared: true });
	nominate.mockReset();
	nominate.mockResolvedValue({ id: "nom-1" });
	onChanged.mockReset();
	orgCtx.organizationId = "org-1";
	orgCtx.isOrgContext = true;
	isOrgAdmin.current = false;
});

describe("FR9 — the variants are visible", () => {
	it("lists every prompt bound to the action, not just the winner", async () => {
		renderList();

		expect(await screen.findByText("Baseline drafter")).toBeInTheDocument();
		expect(await screen.findByText("Our tighter one")).toBeInTheDocument();
	});

	it("labels each variant with its tier", async () => {
		renderList();

		// FR10's "clear visual labeling of each prompt's tier".
		expect(await screen.findByText(/fabric/i)).toBeInTheDocument();
		expect(await screen.findByText(/organization/i)).toBeInTheDocument();
	});

	it("marks which one is actually in force", async () => {
		renderList();

		expect(await screen.findByText(/in force/i)).toBeInTheDocument();
	});

	it("says so when the action has nothing bound", async () => {
		renderList([]);

		expect(
			await screen.findByText(/uses its built-in text/i),
		).toBeInTheDocument();
	});

	it("offers no switch on the prompt already in force", async () => {
		renderList();

		// The in-force row offers nothing; the other offers the two actions.
		expect(
			await screen.findByRole("button", { name: /use this/i }),
		).toBeInTheDocument();
		expect(
			screen.getAllByRole("button", { name: /use this/i }),
		).toHaveLength(1);
	});
});

describe("FR10 — switching to a variant", () => {
	it("'Use this' sets a personal default, even inside an organization", async () => {
		// FR3: a personal default overrides the organization's for whoever set
		// it, so this is the action that takes effect immediately — and it is
		// available to a plain member, who previously had only the proposal.
		const user = userEvent.setup();
		renderList();

		await user.click(
			await screen.findByRole("button", { name: /use this/i }),
		);

		await waitFor(() => expect(bindSet).toHaveBeenCalledTimes(1));
		expect(bindSet).toHaveBeenCalledWith(
			expect.objectContaining({
				scope: "USER",
				organizationId: null,
				targetKey: "test_case_drafter",
				documentType: "GENERAL",
				storyKind: null,
				promptVersionId: "pv-Our tighter one",
				isDefault: true,
			}),
		);
		expect(nominate).not.toHaveBeenCalled();
	});

	it("'Set for org' writes the organization default for an admin", async () => {
		isOrgAdmin.current = true;
		const user = userEvent.setup();
		renderList();

		await user.click(
			await screen.findByRole("button", { name: /set for org/i }),
		);

		await waitFor(() => expect(bindSet).toHaveBeenCalledTimes(1));
		expect(bindSet).toHaveBeenCalledWith(
			expect.objectContaining({
				scope: "ORG",
				organizationId: "org-1",
			}),
		);
		expect(nominate).not.toHaveBeenCalled();
	});

	it("'Propose for org' is what a plain member gets instead", async () => {
		// Changing it for everyone is still the admin's decision.
		const user = userEvent.setup();
		renderList();

		expect(
			screen.queryByRole("button", { name: /set for org/i }),
		).not.toBeInTheDocument();

		await user.click(
			await screen.findByRole("button", { name: /propose for org/i }),
		);

		await waitFor(() => expect(nominate).toHaveBeenCalledTimes(1));
		expect(nominate).toHaveBeenCalledWith(
			expect.objectContaining({
				targetScope: "ORG",
				organizationId: "org-1",
			}),
		);
	});

	it("offers no organization action in personal context", async () => {
		orgCtx.organizationId = null;
		orgCtx.isOrgContext = false;
		const user = userEvent.setup();
		renderList();

		expect(
			screen.queryByRole("button", { name: /for org/i }),
		).not.toBeInTheDocument();

		await user.click(
			await screen.findByRole("button", { name: /use this/i }),
		);

		await waitFor(() => expect(bindSet).toHaveBeenCalledTimes(1));
		expect(bindSet).toHaveBeenCalledWith(
			expect.objectContaining({ scope: "USER", organizationId: null }),
		);
	});

	it("refreshes the catalog after a switch lands", async () => {
		// Otherwise the row keeps showing the old winner and the user clicks again.
		const user = userEvent.setup();
		renderList();

		await user.click(
			await screen.findByRole("button", { name: /use this/i }),
		);

		await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
	});
});

/**
 * FR11: clearing an override, from a surface that covers every action.
 *
 * The capability already existed, but the only place it was wired was the
 * Feature drafting-stage panel — one agent, four document types. For every
 * other action in the catalog there was no way to stand an override down at
 * all. The catalog is the surface that lists all of them, so it is where this
 * belongs.
 *
 * Clearing changes what everyone at and below the tier receives, so it carries
 * the same authority as setting it — and it is only meaningful when there is a
 * lower tier to reveal.
 */
describe("FR11 — clearing an override", () => {
	const withOrgOverride = [
		variant("Baseline drafter", "SYSTEM"),
		variant("Our override", "ORG", true),
	];

	it("offers it to an org admin on the organization's own override", async () => {
		isOrgAdmin.current = true;
		renderList(withOrgOverride);

		expect(
			await screen.findByRole("button", { name: /clear override/i }),
		).toBeInTheDocument();
	});

	it("does not offer it to a plain member", async () => {
		// Same authority as setting it: otherwise a member reaches the same
		// outcome by removing the admin's row instead of replacing it.
		renderList(withOrgOverride);

		await screen.findByText("Our override");
		expect(
			screen.queryByRole("button", { name: /clear override/i }),
		).not.toBeInTheDocument();
	});

	it("lets you clear your own personal override inside an organization", async () => {
		// The gate used to read "personal overrides only matter outside an
		// organization", which was true until they started winning inside one.
		// Left alone it strands the user: they can set a personal default here
		// and then have no way to stand it down from this surface.
		renderList([
			variant("Baseline drafter", "SYSTEM"),
			variant("My own", "USER", true),
		]);

		expect(
			await screen.findByRole("button", { name: /clear override/i }),
		).toBeInTheDocument();
	});

	it("still lets you clear a personal override in personal context", async () => {
		orgCtx.organizationId = null;
		orgCtx.isOrgContext = false;
		renderList([
			variant("Baseline drafter", "SYSTEM"),
			variant("My own", "USER", true),
		]);

		expect(
			await screen.findByRole("button", { name: /clear override/i }),
		).toBeInTheDocument();
	});

	it("never offers it on a system prompt", async () => {
		// Nothing sits beneath SYSTEM, so there is no tier to revert to —
		// clearing would leave the action with no prompt rather than reverting.
		isOrgAdmin.current = true;
		renderList([variant("Baseline drafter", "SYSTEM", true)]);

		await screen.findByText("Baseline drafter");
		expect(
			screen.queryByRole("button", { name: /clear override/i }),
		).not.toBeInTheDocument();
	});

	it("does not offer it when the override is the only prompt bound", async () => {
		isOrgAdmin.current = true;
		renderList([variant("Our override", "ORG", true)]);

		await screen.findByText("Our override");
		expect(
			screen.queryByRole("button", { name: /clear override/i }),
		).not.toBeInTheDocument();
	});

	it("clears the tier's own binding, leaving the prompt itself alone", async () => {
		isOrgAdmin.current = true;
		const user = userEvent.setup();
		renderList(withOrgOverride);

		await user.click(
			await screen.findByRole("button", { name: /clear override/i }),
		);

		await waitFor(() => expect(bindClear).toHaveBeenCalledTimes(1));
		expect(bindClear).toHaveBeenCalledWith(
			expect.objectContaining({
				targetType: "AGENT",
				targetKey: "test_case_drafter",
				documentType: "GENERAL",
				storyKind: null,
				scope: "ORG",
				organizationId: "org-1",
			}),
		);
		expect(onChanged).toHaveBeenCalled();
	});
});
