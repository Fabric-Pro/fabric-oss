/**
 * A nomination that covers several actions is rendered once per action group —
 * and the reviewer's edits must mean the same thing in every one of them.
 *
 * The queue groups by action so competing proposals sit together (FR18). A
 * nomination naming actions A and B therefore appears twice: under A's group
 * with A fixed, and under B's group with B fixed. Both rows are independently
 * approvable.
 *
 * That makes the edit state shared by nature. Keying it by nomination alone
 * while the "always included" action differs per row means the same array is
 * read against two different baselines, and the result is silent: the row shows
 * a plausible set of checkboxes, Approve succeeds, and the bound actions are
 * not what the reviewer configured. Nothing downstream reports it, because
 * approving a subset is a legitimate outcome (FR23).
 *
 * The invariant these pin: whichever row you approve from, the actions bound
 * are the set the reviewer last configured, plus the action that row is about.
 *
 * Run with:
 *   pnpm --filter web test __tests__/modules/saas/prompts/NominationQueueCrossGroup.test.tsx
 */

import { NominationQueue } from "@saas/prompts/components/NominationQueue";
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

const { listPending, approve } = vi.hoisted(() => ({
	listPending: vi.fn(),
	approve: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		prompts: {
			nominations: {
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
	useSession: () => ({ user: { id: "user-1", role: null } }),
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org-1",
		isOrgContext: true,
	}),
}));

const DRAFTER = {
	targetKey: "test_case_drafter",
	documentType: "GENERAL",
	storyKind: null,
};
const REVISER = {
	targetKey: "test_case_step_reviser",
	documentType: "GENERAL",
	storyKind: null,
};

/** One nomination covering both actions — so it renders under both groups. */
const twoActionNomination = [
	{
		id: "nom-1",
		targets: [DRAFTER, REVISER],
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

const keysOf = (call: { targets?: { targetKey: string }[] }) =>
	(call.targets ?? []).map((t) => t.targetKey).sort();

beforeEach(() => {
	listPending.mockReset();
	listPending.mockResolvedValue(twoActionNomination);
	approve.mockReset();
	approve.mockResolvedValue({ supersededCount: 0 });
});

describe("a nomination shown under two action groups", () => {
	it("renders once per action it covers", async () => {
		wrap(<NominationQueue />);

		const groups = await screen.findAllByRole("group", {
			name: /applies to/i,
		});
		expect(groups).toHaveLength(2);
		expect(await screen.findAllByText("Prompt A")).toHaveLength(2);
	});

	it("gives each row its own element id", async () => {
		// Two DOM nodes sharing an id is invalid, and it breaks the
		// label-to-group association that makes the checkboxes announceable.
		wrap(<NominationQueue />);

		const groups = await screen.findAllByRole("group", {
			name: /applies to/i,
		});
		const ids = groups.map((g) => g.getAttribute("id"));
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("keeps an edit made under one group when approving from that same group", async () => {
		const user = userEvent.setup();
		wrap(<NominationQueue />);

		const groups = await screen.findAllByRole("group", {
			name: /applies to/i,
		});
		// First group is the drafter (groups sort by label); its checkbox row
		// offers the reviser as the "extra".
		const box = within(groups[0]).getByRole("checkbox", {
			name: /step reviser/i,
		});
		await waitFor(() => expect(box).toBeChecked());
		await user.click(box);

		const approveButtons = await screen.findAllByRole("button", {
			name: /approve/i,
		});
		await user.click(approveButtons[0]);

		await waitFor(() => expect(approve).toHaveBeenCalledTimes(1));
		expect(keysOf(approve.mock.calls[0][0])).toEqual(["test_case_drafter"]);
	});

	it("does not let an edit under one group silently drop the other group's own action", async () => {
		// THE BUG: with edit state keyed by nomination alone, unchecking the
		// reviser under the drafter's row leaves an array that the reviser's row
		// reads against ITS baseline — where the drafter is the removable one.
		// Approving from the reviser's row then binds only the reviser, dropping
		// the drafter the reviewer never touched.
		const user = userEvent.setup();
		wrap(<NominationQueue />);

		const groups = await screen.findAllByRole("group", {
			name: /applies to/i,
		});
		const box = within(groups[0]).getByRole("checkbox", {
			name: /step reviser/i,
		});
		await waitFor(() => expect(box).toBeChecked());
		await user.click(box);

		// Approve from the OTHER row.
		const approveButtons = await screen.findAllByRole("button", {
			name: /approve/i,
		});
		await user.click(approveButtons[1]);

		await waitFor(() => expect(approve).toHaveBeenCalledTimes(1));
		// The row being approved from is always included, and the drafter — which
		// the reviewer left alone — must still be there.
		expect(keysOf(approve.mock.calls[0][0])).toEqual([
			"test_case_drafter",
			"test_case_step_reviser",
		]);
	});

	it("shows an edit made under one group in the other group's row", async () => {
		// The two rows describe ONE nomination, so they must not disagree about
		// which actions it covers.
		const user = userEvent.setup();
		wrap(<NominationQueue />);

		const groups = await screen.findAllByRole("group", {
			name: /applies to/i,
		});
		const reviserBox = within(groups[0]).getByRole("checkbox", {
			name: /step reviser/i,
		});
		await waitFor(() => expect(reviserBox).toBeChecked());
		await user.click(reviserBox);

		// The reviser's own row still shows the drafter as covered — the
		// reviewer removed the reviser, not the drafter.
		const drafterBox = within(groups[1]).getByRole("checkbox", {
			name: /drafter/i,
		});
		expect(drafterBox).toBeChecked();
	});
});
