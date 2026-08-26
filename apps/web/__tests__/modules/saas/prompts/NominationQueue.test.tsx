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
import { render, screen } from "@testing-library/react";
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

const { listPending, sessionRole } = vi.hoisted(() => ({
	listPending: vi.fn(),
	sessionRole: { current: null as string | null },
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		prompts: {
			nominations: {
				listPending: (input: unknown) => listPending(input),
				approve: vi.fn(),
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
