/**
 * Setting a shared default versus proposing one.
 *
 * FR15 gives a member without authority over a tier a way to put a prompt
 * forward for it. The dialog carries that: the tier options are offered to
 * everyone, and the verb changes based on what the caller may actually do.
 *
 * Two things this pins that are easy to get subtly wrong:
 *
 *   - The two admin fields are orthogonal. `User.role === "admin"` is the
 *     platform admin who may set a universal default; `Member.role` is the org
 *     admin who may set an organization one. Using either for the other's tier
 *     lets someone write a default they have no authority over — or, less
 *     visibly, forces an admin to go through review for their own tier.
 *   - A personal default is nobody else's to approve, so it must never route
 *     to the nomination endpoint no matter who is asking.
 */

import { SetAsDefaultDialog } from "@saas/prompts/components/SetAsDefaultDialog";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
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

const { bindSet, nominate, sessionRole, orgAdmin } = vi.hoisted(() => ({
	bindSet: vi.fn(),
	nominate: vi.fn(),
	sessionRole: { current: null as string | null },
	orgAdmin: { current: false },
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		prompts: {
			bind: { set: (input: unknown) => bindSet(input) },
			nominations: { create: (input: unknown) => nominate(input) },
		},
	},
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({ user: { id: "user-1", role: sessionRole.current } }),
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org-1",
		isOrgContext: true,
	}),
}));

vi.mock("@saas/organizations/hooks/use-active-organization", () => ({
	useActiveOrganization: () => ({
		isOrganizationAdmin: orgAdmin.current,
	}),
}));

const openDialog = () =>
	wrap(
		<SetAsDefaultDialog
			open
			onOpenChange={() => {}}
			promptName="Test prompt"
			promptVersionId="pv-1"
			initialDocumentType="GENERAL"
		/>,
	);

async function chooseScope(
	user: ReturnType<typeof userEvent.setup>,
	option: RegExp,
) {
	await user.click(await screen.findByRole("combobox", { name: /scope/i }));
	await user.click(await screen.findByRole("option", { name: option }));
}

const submit = async (user: ReturnType<typeof userEvent.setup>) => {
	const button = await screen.findByRole("button", {
		name: /(set|propose) as default/i,
	});
	await user.click(button);
	return button;
};

describe("SetAsDefaultDialog — set or propose", () => {
	beforeEach(() => {
		bindSet.mockReset();
		bindSet.mockResolvedValue({ id: "binding-1" });
		nominate.mockReset();
		nominate.mockResolvedValue({ id: "nom-1" });
		sessionRole.current = null;
		orgAdmin.current = false;
	});

	it("offers the system tier to a plain member", async () => {
		// Hiding it leaves a member no route to propose one, and no hint that
		// proposing is possible at all.
		const user = userEvent.setup();
		openDialog();

		await user.click(
			await screen.findByRole("combobox", { name: /scope/i }),
		);

		expect(
			await screen.findByRole("option", { name: /system/i }),
		).toBeInTheDocument();
	});

	it("proposes when a member picks the organization tier", async () => {
		const user = userEvent.setup();
		openDialog();

		// Anchored: "System (every organization)" also contains the word.
		await chooseScope(user, /^Organization \(/i);

		expect(
			await screen.findByRole("button", { name: /propose as default/i }),
		).toBeInTheDocument();

		await submit(user);

		await waitFor(() => expect(nominate).toHaveBeenCalledTimes(1));
		expect(nominate).toHaveBeenCalledWith(
			expect.objectContaining({
				targetScope: "ORG",
				organizationId: "org-1",
				promptVersionId: "pv-1",
			}),
		);
		expect(bindSet).not.toHaveBeenCalled();
	});

	it("sets directly when an org admin picks the organization tier", async () => {
		orgAdmin.current = true;
		const user = userEvent.setup();
		openDialog();

		// Anchored: "System (every organization)" also contains the word.
		await chooseScope(user, /^Organization \(/i);

		expect(
			await screen.findByRole("button", { name: /^set as default$/i }),
		).toBeInTheDocument();

		await submit(user);

		await waitFor(() => expect(bindSet).toHaveBeenCalledTimes(1));
		expect(bindSet).toHaveBeenCalledWith(
			expect.objectContaining({ scope: "ORG", isDefault: true }),
		);
		expect(nominate).not.toHaveBeenCalled();
	});

	it("still proposes for the system tier when an org admin asks", async () => {
		// Org authority is not platform authority. An owner of one tenant must
		// not thereby set the default every other tenant inherits.
		orgAdmin.current = true;
		const user = userEvent.setup();
		openDialog();

		await chooseScope(user, /system/i);

		await submit(user);

		await waitFor(() => expect(nominate).toHaveBeenCalledTimes(1));
		expect(nominate).toHaveBeenCalledWith(
			expect.objectContaining({
				targetScope: "SYSTEM",
				organizationId: null,
			}),
		);
		expect(bindSet).not.toHaveBeenCalled();
	});

	it("sets directly when a platform admin picks the system tier", async () => {
		sessionRole.current = "admin";
		const user = userEvent.setup();
		openDialog();

		await chooseScope(user, /system/i);

		await submit(user);

		await waitFor(() => expect(bindSet).toHaveBeenCalledTimes(1));
		expect(bindSet).toHaveBeenCalledWith(
			expect.objectContaining({ scope: "SYSTEM" }),
		);
		expect(nominate).not.toHaveBeenCalled();
	});

	it("still proposes for the organization tier when a platform admin asks", async () => {
		// The mirror of the case above: platform authority is not membership.
		sessionRole.current = "admin";
		const user = userEvent.setup();
		openDialog();

		// Anchored: "System (every organization)" also contains the word.
		await chooseScope(user, /^Organization \(/i);

		await submit(user);

		await waitFor(() => expect(nominate).toHaveBeenCalledTimes(1));
		expect(bindSet).not.toHaveBeenCalled();
	});

	it("never proposes a personal default", async () => {
		// USER is the default scope. Nobody approves your own prompt for you.
		const user = userEvent.setup();
		openDialog();

		await submit(user);

		await waitFor(() => expect(bindSet).toHaveBeenCalledTimes(1));
		expect(bindSet).toHaveBeenCalledWith(
			expect.objectContaining({ scope: "USER" }),
		);
		expect(nominate).not.toHaveBeenCalled();
	});
});
