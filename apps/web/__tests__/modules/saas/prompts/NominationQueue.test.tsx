/**
 * The review queue, and why it groups.
 *
 * FR18's requirement is not "list the pending nominations" — it is that two
 * people proposing different prompts for the SAME action are visible together.
 * A flat list sorted by date is exactly how an admin approves one without ever
 * seeing the other, and nothing about the resulting state looks wrong
 * afterwards. So the grouping is the behaviour under test, not the decoration.
 *
 * The second thing pinned here is the degraded-summary flag. A summary written
 * by the fallback and a summary written by the model read identically; if the
 * UI does not distinguish them, a reviewer weighs a character count as if it
 * were a reading of both prompts.
 */

import { NominationQueue } from "@saas/prompts/components/NominationQueue";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The prompt actions offered depend on the Proposal artifact gate (Fizzy
// #2946), read through `useFeatureFlag`, which throws without a provider.
const flags = vi.hoisted(() => ({ proposalArtifact: false }));
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: (key: string) =>
		key === "PROPOSAL_ARTIFACT" ? flags.proposalArtifact : false,
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

const { listPending, approve, decline, sessionRole } = vi.hoisted(() => ({
	listPending: vi.fn(),
	approve: vi.fn(),
	decline: vi.fn(),
	sessionRole: { current: null as string | null },
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		prompts: {
			nominations: {
				listPending: (input: unknown) => listPending(input),
				approve: (input: unknown) => approve(input),
				decline: (input: unknown) => decline(input),
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

const nomination = (
	id: string,
	targets: (typeof DRAFTER)[],
	overrides: Record<string, unknown> = {},
) => ({
	id,
	targets,
	changeSummary: "Adds preconditions to every case.",
	summaryDegraded: false,
	createdAt: "2026-08-20T00:00:00.000Z",
	nominatedBy: { id: "user-2", name: "A Teammate" },
	promptVersion: {
		id: `pv-${id}`,
		version: 3,
		prompt: { id: `p-${id}`, name: `Prompt ${id}` },
	},
	...overrides,
});

describe("NominationQueue", () => {
	beforeEach(() => {
		listPending.mockReset();
		listPending.mockResolvedValue([]);
		sessionRole.current = null;
	});

	it("says nothing is waiting when the queue is empty", async () => {
		wrap(<NominationQueue />);

		expect(
			await screen.findByText(/nothing waiting for review/i),
		).toBeInTheDocument();
	});

	it("shows two proposals for the same action as competing", async () => {
		listPending.mockResolvedValue([
			nomination("a", [DRAFTER]),
			nomination("b", [DRAFTER]),
		]);

		wrap(<NominationQueue />);

		expect(await screen.findByText(/2 competing/i)).toBeInTheDocument();
		// Both are on screen together — that is the whole point of the grouping.
		expect(await screen.findByText("Prompt a")).toBeInTheDocument();
		expect(await screen.findByText("Prompt b")).toBeInTheDocument();
		expect(
			await screen.findByText(
				/approving one of these closes the others/i,
			),
		).toBeInTheDocument();
	});

	it("does not call two proposals for different actions competing", async () => {
		listPending.mockResolvedValue([
			nomination("a", [DRAFTER]),
			nomination("b", [REVISER]),
		]);

		wrap(<NominationQueue />);

		expect(await screen.findByText("Prompt a")).toBeInTheDocument();
		expect(await screen.findByText("Prompt b")).toBeInTheDocument();
		expect(screen.queryByText(/competing/i)).not.toBeInTheDocument();
	});

	it("lists one nomination under each action it was proposed for", async () => {
		// A nomination naming two actions competes in both queues, so it has to
		// appear in both — showing it only under the first hides it from the
		// reviewer looking at the second.
		listPending.mockResolvedValue([
			nomination("a", [DRAFTER, REVISER]),
			nomination("b", [REVISER]),
		]);

		wrap(<NominationQueue />);

		expect(await screen.findByText(/2 competing/i)).toBeInTheDocument();
		expect(await screen.findAllByText("Prompt a")).toHaveLength(2);
	});

	it("marks a summary that came from the fallback", async () => {
		listPending.mockResolvedValue([
			nomination("a", [DRAFTER], {
				summaryDegraded: true,
				changeSummary: "Automatic summary unavailable.",
			}),
		]);

		wrap(<NominationQueue />);

		// The real fallback body also contains the word, so match on count
		// rather than uniqueness — what matters is that the "What changes"
		// framing is NOT applied to a summary the model never wrote.
		expect(
			(await screen.findAllByText(/summary unavailable/i)).length,
		).toBeGreaterThan(0);
		expect(screen.queryByText(/what changes/i)).not.toBeInTheDocument();
	});

	it("presents a model-written summary as such", async () => {
		listPending.mockResolvedValue([nomination("a", [DRAFTER])]);

		wrap(<NominationQueue />);

		expect(await screen.findByText(/what changes/i)).toBeInTheDocument();
		expect(
			screen.queryByText(/summary unavailable/i),
		).not.toBeInTheDocument();
	});

	it("offers withdraw, not approve, on your own proposal", async () => {
		listPending.mockResolvedValue([
			nomination("a", [DRAFTER], {
				nominatedBy: { id: "user-1", name: "Me" },
			}),
		]);

		wrap(<NominationQueue />);

		expect(
			await screen.findByRole("button", { name: /withdraw/i }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /approve/i }),
		).not.toBeInTheDocument();
	});

	it("offers the system queue only to a platform admin", async () => {
		listPending.mockResolvedValue([]);
		wrap(<NominationQueue />);

		expect(
			await screen.findByText(/nothing waiting for review/i),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("tab", { name: /system/i }),
		).not.toBeInTheDocument();

		sessionRole.current = "admin";
		wrap(<NominationQueue />);

		expect(
			await screen.findByRole("tab", { name: /system/i }),
		).toBeInTheDocument();
	});
});

describe("NominationQueue — the Proposal artifact gate (Fizzy #2946)", () => {
	// With the gate on, an organization default at a legacy Proposal action is
	// refused, so the organization queue never asks the server for one.
	const LEGACY = {
		targetKey: "project_document_generator",
		documentType: "PROPOSAL",
		storyKind: null,
	};

	beforeEach(() => {
		listPending.mockReset();
		approve.mockReset();
		approve.mockResolvedValue({ supersededCount: 0 });
		decline.mockReset();
		decline.mockResolvedValue({});
		sessionRole.current = null;
		flags.proposalArtifact = true;
	});
	afterEach(() => {
		flags.proposalArtifact = false;
	});

	it("lets a nomination for the legacy action alone be declined, not approved", async () => {
		listPending.mockResolvedValue([nomination("a", [LEGACY])]);
		const user = userEvent.setup();
		wrap(<NominationQueue />);

		expect(
			await screen.findByTestId("nomination-superseded-note"),
		).toHaveTextContent("actionNote");
		expect(screen.getByTestId("nomination-decline-only")).toHaveTextContent(
			"nominationDeclineOnly",
		);
		expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();

		await user.click(screen.getByRole("button", { name: "Decline" }));
		await waitFor(() =>
			expect(decline).toHaveBeenCalledWith(
				expect.objectContaining({ nominationId: "a" }),
			),
		);
		expect(approve).not.toHaveBeenCalled();
	});

	it("approves the rest of a nomination without the legacy action", async () => {
		listPending.mockResolvedValue([nomination("a", [LEGACY, DRAFTER])]);
		const user = userEvent.setup();
		wrap(<NominationQueue />);

		await screen.findByTestId("nomination-superseded-note");
		// Two groups, the legacy one and the drafter's; approve from the
		// drafter's, which is the second alphabetically.
		const approveButtons = screen.getAllByRole("button", {
			name: "Approve",
		});
		expect(approveButtons).toHaveLength(2);
		for (const button of approveButtons) {
			expect(button).toBeEnabled();
		}
		expect(
			screen.queryByTestId("nomination-decline-only"),
		).not.toBeInTheDocument();

		const drafterGroup = screen
			.getByRole("heading", { name: /^Test Case Drafter/ })
			.closest("section") as HTMLElement;
		await user.click(
			within(drafterGroup).getByRole("button", { name: "Approve" }),
		);

		await waitFor(() => expect(approve).toHaveBeenCalledTimes(1));
		expect(approve.mock.calls[0][0]).toEqual(
			expect.objectContaining({
				nominationId: "a",
				targets: [
					{
						targetKey: "test_case_drafter",
						documentType: "GENERAL",
						storyKind: null,
					},
				],
			}),
		);
	});

	it("approves a legacy-action nomination as proposed with the gate off", async () => {
		flags.proposalArtifact = false;
		listPending.mockResolvedValue([nomination("a", [LEGACY])]);
		const user = userEvent.setup();
		wrap(<NominationQueue />);

		const button = await screen.findByRole("button", { name: "Approve" });
		expect(button).toBeEnabled();
		expect(
			screen.queryByTestId("nomination-superseded-note"),
		).not.toBeInTheDocument();
		await user.click(button);

		await waitFor(() => expect(approve).toHaveBeenCalledTimes(1));
		expect(approve.mock.calls[0][0]).not.toHaveProperty("targets");
	});

	it("leaves the System queue unshaped by the gate", async () => {
		sessionRole.current = "admin";
		listPending.mockImplementation((input: { targetScope: string }) =>
			input.targetScope === "SYSTEM" ? [nomination("s", [LEGACY])] : [],
		);
		const user = userEvent.setup();
		wrap(<NominationQueue />);

		await user.click(await screen.findByRole("tab", { name: /system/i }));

		const button = await screen.findByRole("button", { name: "Approve" });
		expect(button).toBeEnabled();
		expect(
			screen.queryByTestId("nomination-superseded-note"),
		).not.toBeInTheDocument();
	});
});
