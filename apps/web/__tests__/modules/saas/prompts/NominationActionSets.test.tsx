/**
 * A nomination covers a set of actions, and both ends of it are editable.
 *
 * FR22 — the nominator picks 1:N actions, pre-populated with the ones the
 * source prompt already serves. Someone proposing a prompt that already runs
 * three actions is almost always proposing it for those three; making them
 * re-tick each one by hand is where the fourth gets forgotten.
 *
 * FR23 — the reviewer may narrow or widen that set before approving, and
 * approval applies to what THEY settled on. The distinction that matters is
 * between "unedited" and "edited to the same thing": an unedited approval sends
 * no targets at all and lets the server read its own row, so the client and the
 * stored nomination can never disagree about what was approved.
 */

import { NominationQueue } from "@saas/prompts/components/NominationQueue";
import { SetAsDefaultDialog } from "@saas/prompts/components/SetAsDefaultDialog";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
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

const {
	bindSet,
	bindSetMany,
	listForPrompt,
	nominate,
	listPending,
	approve,
	sessionRole,
} = vi.hoisted(() => ({
	bindSet: vi.fn(),
	bindSetMany: vi.fn(),
	listForPrompt: vi.fn(),
	nominate: vi.fn(),
	listPending: vi.fn(),
	approve: vi.fn(),
	sessionRole: { current: null as string | null },
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		prompts: {
			bind: {
				set: (i: unknown) => bindSet(i),
				setMany: (i: unknown) => bindSetMany(i),
				listForPrompt: (i: unknown) => listForPrompt(i),
			},
			nominations: {
				create: (i: unknown) => nominate(i),
				listPending: (i: unknown) => listPending(i),
				approve: (i: unknown) => approve(i),
				decline: vi.fn(),
				withdraw: vi.fn(),
			},
		},
	},
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

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
	useActiveOrganization: () => ({ isOrganizationAdmin: false }),
}));

const REVISER = {
	targetKey: "test_case_step_reviser",
	documentType: "GENERAL",
	storyKind: null,
};

beforeEach(() => {
	bindSet.mockReset();
	bindSet.mockResolvedValue({ id: "b1" });
	bindSetMany.mockReset();
	bindSetMany.mockResolvedValue({ bound: 2 });
	listForPrompt.mockReset();
	listForPrompt.mockResolvedValue({ actions: [] });
	nominate.mockReset();
	nominate.mockResolvedValue({ id: "nom-1" });
	listPending.mockReset();
	listPending.mockResolvedValue([]);
	approve.mockReset();
	approve.mockResolvedValue({ supersededCount: 0 });
	sessionRole.current = null;
});

describe("FR22 — choosing the actions a nomination covers", () => {
	const openDialog = (promptId?: string) =>
		wrap(
			<SetAsDefaultDialog
				open
				onOpenChange={() => {}}
				promptName="Test prompt"
				promptVersionId="pv-1"
				promptId={promptId}
				initialDocumentType="GENERAL"
			/>,
		);

	const chooseSystemTier = async (
		user: ReturnType<typeof userEvent.setup>,
	) => {
		await user.click(
			await screen.findByRole("combobox", { name: /scope/i }),
		);
		await user.click(
			await screen.findByRole("option", { name: /^system /i }),
		);
	};

	it("pre-populates the actions the prompt already serves", async () => {
		listForPrompt.mockResolvedValue({ actions: [REVISER] });
		const user = userEvent.setup();
		openDialog("p-1");

		const also = await screen.findByRole("group", {
			name: /also apply to/i,
		});
		await waitFor(() =>
			expect(
				within(also).getByRole("checkbox", {
					name: /step reviser/i,
				}),
			).toBeChecked(),
		);

		await chooseSystemTier(user);
		await user.click(
			await screen.findByRole("button", { name: /propose as default/i }),
		);

		await waitFor(() => expect(nominate).toHaveBeenCalledTimes(1));
		expect(nominate.mock.calls[0][0].targets).toHaveLength(2);
	});

	it("lets the nominator remove a pre-filled action before submitting", async () => {
		// Pre-population is a starting point, not a decision.
		listForPrompt.mockResolvedValue({ actions: [REVISER] });
		const user = userEvent.setup();
		openDialog("p-1");

		const also = await screen.findByRole("group", {
			name: /also apply to/i,
		});
		const box = within(also).getByRole("checkbox", {
			name: /step reviser/i,
		});
		await waitFor(() => expect(box).toBeChecked());
		await user.click(box);

		await chooseSystemTier(user);
		await user.click(
			await screen.findByRole("button", { name: /propose as default/i }),
		);

		await waitFor(() => expect(nominate).toHaveBeenCalledTimes(1));
		expect(nominate.mock.calls[0][0].targets).toHaveLength(1);
	});

	it("does not ask for bindings when it has no prompt id", async () => {
		openDialog(undefined);

		await screen.findByRole("group", { name: /also apply to/i });
		expect(listForPrompt).not.toHaveBeenCalled();
	});

	it("binds several actions in one transaction when setting, not one call each", async () => {
		const user = userEvent.setup();
		openDialog("p-1");

		const also = await screen.findByRole("group", {
			name: /also apply to/i,
		});
		await user.click(
			within(also).getByRole("checkbox", { name: /step reviser/i }),
		);
		await user.click(
			await screen.findByRole("button", { name: /set as default/i }),
		);

		await waitFor(() => expect(bindSetMany).toHaveBeenCalledTimes(1));
		expect(bindSetMany.mock.calls[0][0].targets).toHaveLength(2);
		expect(bindSet).not.toHaveBeenCalled();
	});

	it("uses the single-action endpoint when only one action is selected", async () => {
		const user = userEvent.setup();
		openDialog("p-1");

		await screen.findByRole("group", { name: /also apply to/i });
		await user.click(
			await screen.findByRole("button", { name: /set as default/i }),
		);

		await waitFor(() => expect(bindSet).toHaveBeenCalledTimes(1));
		expect(bindSetMany).not.toHaveBeenCalled();
	});
});

describe("FR23 — the reviewer edits the set before approving", () => {
	const DRAFTER = {
		targetKey: "test_case_drafter",
		documentType: "GENERAL",
		storyKind: null,
	};

	const pending = (targets = [DRAFTER]) => [
		{
			id: "nom-1",
			targets,
			changeSummary: "Adds preconditions.",
			summaryDegraded: false,
			createdAt: "2026-08-20T00:00:00.000Z",
			nominatedBy: { id: "user-2", name: "A Teammate" },
			promptVersion: {
				id: "pv-1",
				version: 2,
				prompt: { id: "p-1", name: "Prompt A" },
			},
		},
	];

	it("sends no targets when the reviewer changes nothing", async () => {
		// The server reads its own row, so the approved set cannot drift from
		// the stored one just because the client re-serialised it.
		listPending.mockResolvedValue(pending());
		const user = userEvent.setup();
		wrap(<NominationQueue />);

		await user.click(
			await screen.findByRole("button", { name: /approve/i }),
		);

		await waitFor(() => expect(approve).toHaveBeenCalledTimes(1));
		expect(approve.mock.calls[0][0]).not.toHaveProperty("targets");
	});

	it("sends the widened set when the reviewer adds an action", async () => {
		listPending.mockResolvedValue(pending());
		const user = userEvent.setup();
		wrap(<NominationQueue />);

		const applies = await screen.findByRole("group", {
			name: /applies to/i,
		});
		await user.click(
			within(applies).getByRole("checkbox", { name: /step reviser/i }),
		);
		await user.click(
			await screen.findByRole("button", { name: /approve/i }),
		);

		await waitFor(() => expect(approve).toHaveBeenCalledTimes(1));
		const { targets } = approve.mock.calls[0][0];
		// The action being reviewed is always included — it is the one the
		// group is about, and the multi-select renders it as fixed.
		expect(targets).toHaveLength(2);
		expect(targets).toContainEqual(
			expect.objectContaining({ targetKey: "test_case_drafter" }),
		);
		expect(targets).toContainEqual(
			expect.objectContaining({ targetKey: "test_case_step_reviser" }),
		);
	});

	it("sends the narrowed set when the reviewer removes a proposed action", async () => {
		listPending.mockResolvedValue(pending([DRAFTER, REVISER]));
		const user = userEvent.setup();
		wrap(<NominationQueue />);

		// Reviewed under the drafter group; the reviser arrives pre-ticked
		// because it was proposed.
		const applies = await screen.findAllByRole("group", {
			name: /applies to/i,
		});
		const drafterGroup = applies[0];
		const box = within(drafterGroup).getByRole("checkbox", {
			name: /step reviser/i,
		});
		await waitFor(() => expect(box).toBeChecked());
		await user.click(box);

		await user.click(
			(await screen.findAllByRole("button", { name: /approve/i }))[0],
		);

		await waitFor(() => expect(approve).toHaveBeenCalledTimes(1));
		expect(approve.mock.calls[0][0].targets).toHaveLength(1);
		expect(approve.mock.calls[0][0].targets[0].targetKey).toBe(
			"test_case_drafter",
		);
	});

	it("does not offer the editor on your own proposal", async () => {
		// You withdraw your own; you do not review it.
		listPending.mockResolvedValue([
			{ ...pending()[0], nominatedBy: { id: "user-1", name: "Me" } },
		]);
		wrap(<NominationQueue />);

		expect(
			await screen.findByRole("button", { name: /withdraw/i }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("group", { name: /applies to/i }),
		).not.toBeInTheDocument();
	});
});
