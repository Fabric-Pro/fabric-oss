/**
 * Living Documents auto-refresh masthead control.
 *
 * Pins the behaviours the enrollment + review surface has to keep:
 *   1. Opt-in default — an unenrolled document shows an "off" toggle and no
 *      settings popover.
 *   2. Enabling with no cadence chosen sends the BIWEEKLY default.
 *   3. The settings popover (cadence + "Apply automatically") only appears once
 *      enrolled, and changing either re-saves the enrollment.
 *   4. "Apply automatically" is OFF by default — nobody is defaulted into
 *      unattended AI rewrites of their document.
 *   5. A pending proposal is surfaced, and Accept / Discard resolve it.
 *   6. A STALE accept is reported honestly rather than silently succeeding.
 *   7. The client feature flag (`NEXT_PUBLIC_FABRIC_FEATURE_LIVING_DOCS_REFRESH`,
 *      opt-in, default OFF) renders the control away entirely — and, because the
 *      gate sits before any hook call, without firing its query.
 *
 * NOTE: the cadence select moved INSIDE the settings popover when the
 * "Apply automatically" switch was added — the two settings belong together, and
 * the masthead has no room for both inline. The cadence tests open the popover
 * first; their assertions are otherwise unchanged.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	getAutoRefreshMock,
	setAutoRefreshMock,
	applyProposalMock,
	discardProposalMock,
	toastErrorMock,
	toastSuccessMock,
} = vi.hoisted(() => {
	// The component reads the flag as a build-time literal
	// (`process.env.X === "true"`), so it is evaluated once at module load —
	// set it BEFORE the static import below. The flag-off case re-imports the
	// module under a stubbed env.
	process.env.NEXT_PUBLIC_FABRIC_FEATURE_LIVING_DOCS_REFRESH = "true";
	return {
		getAutoRefreshMock: vi.fn(),
		setAutoRefreshMock: vi.fn(),
		applyProposalMock: vi.fn(),
		discardProposalMock: vi.fn(),
		toastErrorMock: vi.fn(),
		toastSuccessMock: vi.fn(),
	};
});

vi.mock("sonner", () => ({
	toast: { error: toastErrorMock, success: toastSuccessMock },
}));

vi.mock("@shared/hooks/use-tenant-query", () => ({
	useTenantContext: () => ({
		organizationId: null,
		isOrgContext: false,
		queryKeyPrefix: ["tenant", null],
	}),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			documents: {
				getAutoRefresh: getAutoRefreshMock,
				setAutoRefresh: setAutoRefreshMock,
				applyAutoRefreshProposal: applyProposalMock,
				discardAutoRefreshProposal: discardProposalMock,
			},
		},
	},
}));

// Only the query KEYS are used (to invalidate the document body + its version
// list after an accept), so stable stand-ins are enough.
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			documents: {
				get: { queryKey: () => ["document", "doc-1"] },
				versions: {
					list: { queryKey: () => ["document", "doc-1", "versions"] },
				},
			},
		},
	},
}));

import { DocumentAutoRefreshToggle } from "../DocumentAutoRefreshToggle";

const DOCUMENT_ID = "doc-1";
const PROJECT_ID = "project-1";

function wrapper({ children }: { children: ReactNode }) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return (
		<QueryClientProvider client={queryClient}>
			{children}
		</QueryClientProvider>
	);
}

function renderToggle(
	Component: typeof DocumentAutoRefreshToggle = DocumentAutoRefreshToggle,
) {
	return render(
		<Component documentId={DOCUMENT_ID} projectId={PROJECT_ID} />,
		{ wrapper },
	);
}

function settings(overrides: Record<string, unknown> = {}) {
	return {
		enabled: false,
		cadence: "BIWEEKLY",
		autoApply: false,
		lastRefreshedAt: null,
		lastRefreshStatus: null,
		lastRefreshSummary: null,
		lastAttemptAt: null,
		pending: null,
		...overrides,
	};
}

const PROPOSAL = {
	content: "# Refreshed PRD",
	summary: "Updated the success metrics section.",
	proposedAt: new Date("2026-07-01T00:00:00.000Z").toISOString(),
	baselineVersion: 3,
};

/** Enrolled, with a proposal waiting for review. */
function enrolledWithProposal(overrides: Record<string, unknown> = {}) {
	return settings({ enabled: true, pending: PROPOSAL, ...overrides });
}

/** Open the settings popover and wait for its contents. */
async function openSettings(user: ReturnType<typeof userEvent.setup>) {
	await user.click(
		await screen.findByRole("button", { name: "Auto-refresh settings" }),
	);
}

/** Open the pending-proposal popover. */
async function openProposal(user: ReturnType<typeof userEvent.setup>) {
	await user.click(
		await screen.findByRole("button", { name: /review update/i }),
	);
}

beforeEach(() => {
	getAutoRefreshMock.mockReset();
	setAutoRefreshMock.mockReset();
	applyProposalMock.mockReset();
	discardProposalMock.mockReset();
	toastErrorMock.mockReset();
	toastSuccessMock.mockReset();
	getAutoRefreshMock.mockResolvedValue(settings());
	setAutoRefreshMock.mockImplementation(
		async (input: Record<string, unknown>) => settings(input),
	);
	applyProposalMock.mockResolvedValue({ applied: true, version: 4 });
	discardProposalMock.mockResolvedValue({ discarded: true });
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.resetModules();
});

describe("DocumentAutoRefreshToggle — enrollment", () => {
	it("shows an unpressed toggle and no settings popover for an unenrolled document", async () => {
		renderToggle();

		const button = await screen.findByRole("button", {
			name: "Turn on scheduled auto-refresh",
		});
		await waitFor(() =>
			expect(button).toHaveAttribute("aria-pressed", "false"),
		);
		expect(
			screen.queryByRole("button", { name: "Auto-refresh settings" }),
		).toBeNull();
	});

	it("enrolls at the BIWEEKLY default when no cadence has been chosen", async () => {
		const user = userEvent.setup();
		renderToggle();

		const button = await screen.findByRole("button", {
			name: "Turn on scheduled auto-refresh",
		});
		await waitFor(() => expect(button).not.toBeDisabled());
		await user.click(button);

		await waitFor(() =>
			expect(setAutoRefreshMock).toHaveBeenCalledWith({
				id: DOCUMENT_ID,
				projectId: PROJECT_ID,
				organizationId: null,
				enabled: true,
				cadence: "BIWEEKLY",
				// Enrolling must never silently opt you into unattended rewrites.
				autoApply: false,
			}),
		);
	});

	it("marks the toggle pressed and offers the settings popover once enrolled", async () => {
		const user = userEvent.setup();
		getAutoRefreshMock.mockResolvedValue(
			settings({ enabled: true, cadence: "BIWEEKLY" }),
		);

		renderToggle();

		const button = await screen.findByRole("button", {
			name: "Turn off scheduled auto-refresh",
		});
		expect(button).toHaveAttribute("aria-pressed", "true");
		// Enrolled state is signalled by colour only — never a scale transform.
		expect(button.className).toContain("text-primary");

		await openSettings(user);
		expect(
			await screen.findByLabelText("Auto-refresh cadence"),
		).toHaveTextContent("Bi-weekly");
	});

	it("re-saves the enrollment when the cadence changes", async () => {
		const user = userEvent.setup();
		getAutoRefreshMock.mockResolvedValue(
			settings({ enabled: true, cadence: "BIWEEKLY" }),
		);

		renderToggle();

		await openSettings(user);
		await user.click(await screen.findByLabelText("Auto-refresh cadence"));
		await user.click(
			await screen.findByRole("option", { name: "Monthly" }),
		);

		await waitFor(() =>
			expect(setAutoRefreshMock).toHaveBeenCalledWith(
				expect.objectContaining({ enabled: true, cadence: "MONTHLY" }),
			),
		);
	});

	it("unenrolls without dropping the row when toggled off", async () => {
		const user = userEvent.setup();
		getAutoRefreshMock.mockResolvedValue(
			settings({ enabled: true, cadence: "WEEKLY" }),
		);

		renderToggle();

		await user.click(
			await screen.findByRole("button", {
				name: "Turn off scheduled auto-refresh",
			}),
		);

		await waitFor(() =>
			expect(setAutoRefreshMock).toHaveBeenCalledWith(
				expect.objectContaining({ enabled: false, cadence: "WEEKLY" }),
			),
		);
	});

	it("rolls back and warns when the save fails", async () => {
		const user = userEvent.setup();
		setAutoRefreshMock.mockRejectedValue(new Error("nope"));

		renderToggle();

		const button = await screen.findByRole("button", {
			name: "Turn on scheduled auto-refresh",
		});
		await waitFor(() => expect(button).not.toBeDisabled());
		await user.click(button);

		await waitFor(() => expect(toastErrorMock).toHaveBeenCalledTimes(1));
		expect(
			await screen.findByRole("button", {
				name: "Turn on scheduled auto-refresh",
			}),
		).toHaveAttribute("aria-pressed", "false");
	});
});

describe("DocumentAutoRefreshToggle — apply automatically", () => {
	it("is OFF for an enrolled document that never opted in, and says the AI only proposes", async () => {
		const user = userEvent.setup();
		getAutoRefreshMock.mockResolvedValue(
			settings({ enabled: true, autoApply: false }),
		);

		renderToggle();
		await openSettings(user);

		const switchEl = await screen.findByRole("switch", {
			name: "Apply automatically",
		});
		expect(switchEl).toHaveAttribute("aria-checked", "false");
		expect(
			screen.getByText(/Nothing is written to this document until you/i),
		).toBeInTheDocument();
	});

	it("persists the opt-in when switched on", async () => {
		const user = userEvent.setup();
		getAutoRefreshMock.mockResolvedValue(
			settings({ enabled: true, cadence: "WEEKLY", autoApply: false }),
		);

		renderToggle();
		await openSettings(user);
		await user.click(
			await screen.findByRole("switch", { name: "Apply automatically" }),
		);

		await waitFor(() =>
			expect(setAutoRefreshMock).toHaveBeenCalledWith(
				expect.objectContaining({
					enabled: true,
					cadence: "WEEKLY",
					autoApply: true,
				}),
			),
		);
	});

	it("warns plainly, when on, that the AI writes without asking", async () => {
		const user = userEvent.setup();
		getAutoRefreshMock.mockResolvedValue(
			settings({ enabled: true, autoApply: true }),
		);

		renderToggle();
		await openSettings(user);

		expect(
			await screen.findByRole("switch", { name: "Apply automatically" }),
		).toHaveAttribute("aria-checked", "true");
		expect(
			screen.getByText(/you are not asked first/i),
		).toBeInTheDocument();
	});
});

describe("DocumentAutoRefreshToggle — pending proposal", () => {
	it("surfaces the proposal with its summary and when it was drafted", async () => {
		const user = userEvent.setup();
		getAutoRefreshMock.mockResolvedValue(enrolledWithProposal());

		renderToggle();
		await openProposal(user);

		expect(
			await screen.findByText("Updated the success metrics section."),
		).toBeInTheDocument();
		expect(screen.getByText(/drafted/i)).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /^apply$/i }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /^discard$/i }),
		).toBeInTheDocument();
	});

	it("shows no proposal affordance when there is nothing pending", async () => {
		getAutoRefreshMock.mockResolvedValue(settings({ enabled: true }));

		renderToggle();

		await screen.findByRole("button", {
			name: "Turn off scheduled auto-refresh",
		});
		expect(
			screen.queryByRole("button", { name: /review update/i }),
		).toBeNull();
	});

	it("applies the proposal and hides it once accepted", async () => {
		const user = userEvent.setup();
		// First read has the proposal; the refetch after the accept does not —
		// the server cleared it.
		getAutoRefreshMock
			.mockResolvedValueOnce(enrolledWithProposal())
			.mockResolvedValue(settings({ enabled: true }));

		renderToggle();
		await openProposal(user);
		await user.click(
			await screen.findByRole("button", { name: /^apply$/i }),
		);

		await waitFor(() =>
			expect(applyProposalMock).toHaveBeenCalledWith({
				id: DOCUMENT_ID,
				projectId: PROJECT_ID,
				organizationId: null,
			}),
		);
		await waitFor(() =>
			expect(
				screen.queryByRole("button", { name: /review update/i }),
			).toBeNull(),
		);
		expect(toastSuccessMock).toHaveBeenCalledTimes(1);
	});

	it("reports a STALE accept honestly instead of claiming success", async () => {
		const user = userEvent.setup();
		// The document moved after the AI drafted this, so the server refused to
		// write it. The user must be told — not shown a success toast over a
		// document that never changed.
		applyProposalMock.mockResolvedValue({
			applied: false,
			reason: "stale",
		});
		getAutoRefreshMock
			.mockResolvedValueOnce(enrolledWithProposal())
			.mockResolvedValue(settings({ enabled: true }));

		renderToggle();
		await openProposal(user);
		await user.click(
			await screen.findByRole("button", { name: /^apply$/i }),
		);

		await waitFor(() => expect(toastErrorMock).toHaveBeenCalledTimes(1));
		expect(toastSuccessMock).not.toHaveBeenCalled();
		expect(toastErrorMock.mock.calls[0]?.[0]).toMatch(/changed/i);
		// The dead proposal is gone — the server cleared it on this path too.
		await waitFor(() =>
			expect(
				screen.queryByRole("button", { name: /review update/i }),
			).toBeNull(),
		);
	});

	it("discards the proposal and hides it, without touching the document", async () => {
		const user = userEvent.setup();
		getAutoRefreshMock
			.mockResolvedValueOnce(enrolledWithProposal())
			.mockResolvedValue(settings({ enabled: true }));

		renderToggle();
		await openProposal(user);
		await user.click(
			await screen.findByRole("button", { name: /^discard$/i }),
		);

		await waitFor(() =>
			expect(discardProposalMock).toHaveBeenCalledWith({
				id: DOCUMENT_ID,
				projectId: PROJECT_ID,
				organizationId: null,
			}),
		);
		expect(applyProposalMock).not.toHaveBeenCalled();
		await waitFor(() =>
			expect(
				screen.queryByRole("button", { name: /review update/i }),
			).toBeNull(),
		);
	});
});

/**
 * A schedule whose results are invisible is a schedule nobody can trust. These
 * pin the distinction the document page could not previously make: "the AI
 * looked and nothing needed changing" and "the AI could not run at all" are
 * different news, and only one of them is the owner's problem.
 */
describe("DocumentAutoRefreshToggle — last-refresh outcome", () => {
	it("reports a failed cycle, and reports it before the popover is opened", async () => {
		getAutoRefreshMock.mockResolvedValue(
			settings({
				enabled: true,
				lastRefreshStatus: "FAILED",
				lastRefreshSummary: "Project context could not be retrieved.",
				lastAttemptAt: new Date(
					"2026-07-14T00:00:00.000Z",
				).toISOString(),
			}),
		);

		const user = userEvent.setup();
		renderToggle();

		// Legible from the masthead — nobody goes looking for bad news.
		const trigger = await screen.findByRole("button", {
			name: /auto-refresh settings — last refresh failed/i,
		});
		expect(trigger.className).toContain("text-destructive");

		await user.click(trigger);
		expect(await screen.findByText("Last refresh failed")).toBeTruthy();
		expect(
			screen.getByText("Project context could not be retrieved."),
		).toBeTruthy();
	});

	it("distinguishes a quiet fortnight from a broken one", async () => {
		getAutoRefreshMock.mockResolvedValue(
			settings({
				enabled: true,
				lastRefreshStatus: "NO_CHANGES",
				lastRefreshedAt: new Date(
					"2026-07-14T00:00:00.000Z",
				).toISOString(),
			}),
		);

		const user = userEvent.setup();
		renderToggle();

		// A successful no-op is not an error, and must not be dressed as one.
		const trigger = await screen.findByRole("button", {
			name: "Auto-refresh settings",
		});
		expect(trigger.className).not.toContain("text-destructive");

		await user.click(trigger);
		expect(await screen.findByText("No changes needed")).toBeTruthy();
	});

	it("does not repeat a pending proposal as a last-refresh line", async () => {
		getAutoRefreshMock.mockResolvedValue(
			enrolledWithProposal({
				lastRefreshStatus: "PROPOSED",
				lastRefreshedAt: new Date(
					"2026-07-14T00:00:00.000Z",
				).toISOString(),
			}),
		);

		const user = userEvent.setup();
		renderToggle();
		await openSettings(user);

		// The proposal has its own affordance; saying it twice is noise.
		expect(screen.queryByText("Last refresh")).toBeNull();
	});
});

describe("DocumentAutoRefreshToggle — feature flag", () => {
	it("renders nothing — and never queries — when the feature flag is off", async () => {
		vi.resetModules();
		vi.stubEnv("NEXT_PUBLIC_FABRIC_FEATURE_LIVING_DOCS_REFRESH", "false");

		const { DocumentAutoRefreshToggle: FlaggedOff } = await import(
			"../DocumentAutoRefreshToggle"
		);

		const { container } = renderToggle(FlaggedOff);

		expect(container).toBeEmptyDOMElement();
		expect(getAutoRefreshMock).not.toHaveBeenCalled();
	});
});
