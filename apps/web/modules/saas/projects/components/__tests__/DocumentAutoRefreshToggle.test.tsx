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
 *   7. The feature flag — now the SERVER's answer, read from
 *      `FeatureFlagProvider`, never a build-time `NEXT_PUBLIC_` variable
 *      (Fizzy #2210) — renders the control away entirely, and because the gate
 *      sits before the inner component mounts, without firing its query.
 *   8. A failed settings READ is not silently rendered as "feature off with
 *      defaults". A denial hides the control, a first-load fault renders it
 *      inert with an explanation, and a failed background refetch leaves the
 *      control the user is looking at exactly where it is.
 *   9. A failed settings WRITE says what the server said, and says nothing at
 *      all when the rejection carries no message.
 *
 * NOTE: the cadence select moved INSIDE the settings popover when the
 * "Apply automatically" switch was added — the two settings belong together, and
 * the masthead has no room for both inline. The cadence tests open the popover
 * first; their assertions are otherwise unchanged.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	getAutoRefreshMock,
	setAutoRefreshMock,
	applyProposalMock,
	discardProposalMock,
	toastErrorMock,
	toastSuccessMock,
} = vi.hoisted(() => ({
	getAutoRefreshMock: vi.fn(),
	setAutoRefreshMock: vi.fn(),
	applyProposalMock: vi.fn(),
	discardProposalMock: vi.fn(),
	toastErrorMock: vi.fn(),
	toastSuccessMock: vi.fn(),
}));

// The flag now arrives from the server through `FeatureFlagProvider`, so it is
// per-render state and not a module-load constant — no `resetModules` / dynamic
// re-import dance. Same mock shape ~20 other suites in this repo already use.
let flagValue = true;
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => flagValue,
}));

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

function makeClient() {
	return new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
}

/**
 * Renders the control and hands the caller the `QueryClient` back, so a test
 * can drive a REFETCH (the only way to reach the "failed background refetch"
 * branch without also succeeding at something else first).
 */
function renderToggle(queryClient: QueryClient = makeClient()) {
	function wrapper({ children }: { children: ReactNode }) {
		return (
			<QueryClientProvider client={queryClient}>
				{children}
			</QueryClientProvider>
		);
	}
	return {
		...render(
			<DocumentAutoRefreshToggle
				documentId={DOCUMENT_ID}
				projectId={PROJECT_ID}
			/>,
			{ wrapper },
		),
		queryClient,
	};
}

/** An oRPC client error: an `Error` carrying the procedure's `code`. */
function orpcError(code: string, message: string) {
	return Object.assign(new Error(message), { code });
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
	flagValue = true;
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

/**
 * The flag is the SERVER's answer, delivered on the RSC payload through
 * `FeatureFlagProvider`. Previously the client read its own build-time
 * `NEXT_PUBLIC_` twin under a different parser, which could disagree with the
 * runtime variable the API enforced — and when it disagreed in the direction
 * that SHOWED the control, every click failed (Fizzy #2210).
 */
describe("DocumentAutoRefreshToggle — feature flag", () => {
	it("renders the control when the server says the flag is on", async () => {
		renderToggle();

		expect(
			await screen.findByRole("button", {
				name: "Turn on scheduled auto-refresh",
			}),
		).toBeInTheDocument();
	});

	it("renders nothing — and never queries — when the feature flag is off", async () => {
		flagValue = false;

		const { container } = renderToggle();

		expect(container).toBeEmptyDOMElement();
		expect(getAutoRefreshMock).not.toHaveBeenCalled();
	});

	it("reads no environment variable at all — the source carries no process.env", () => {
		// R4. The build-time twin is gone; leaving one behind would recreate the
		// two-authorities split this ticket exists to end. A source scan rather
		// than a behavioural assertion, because a build-time read is invisible
		// to a test that runs the already-inlined module.
		const source = readFileSync(
			path.resolve(__dirname, "../DocumentAutoRefreshToggle.tsx"),
			"utf8",
		);

		expect(source).not.toMatch(/process\.env/);
		expect(source).toMatch(/useFeatureFlag\("LIVING_DOCS_REFRESH"\)/);
	});

	it("reads the flag from the provider, not from a build-time env var", async () => {
		// The runtime answer flips between renders — impossible for a value
		// Next.js inlined at build time, which is the whole point of the move.
		const { unmount } = renderToggle();
		expect(
			await screen.findByRole("button", {
				name: "Turn on scheduled auto-refresh",
			}),
		).toBeInTheDocument();
		unmount();

		flagValue = false;
		const { container } = renderToggle();
		expect(container).toBeEmptyDOMElement();
	});
});

/**
 * `query.data?.enabled ?? false` used to make a FAILED read indistinguishable
 * from "the feature is off" — the control rendered against fallback defaults
 * and every click went to an API that had already declined to answer. These pin
 * the three outcomes apart.
 */
describe("DocumentAutoRefreshToggle — unreadable settings", () => {
	it("renders no control when the settings read is refused as NOT_FOUND", async () => {
		getAutoRefreshMock.mockRejectedValue(
			orpcError("NOT_FOUND", "Procedure not found"),
		);

		const { container } = renderToggle();

		await waitFor(() => expect(container).toBeEmptyDOMElement());
		expect(setAutoRefreshMock).not.toHaveBeenCalled();
	});

	it("renders no control when the settings read is refused as FORBIDDEN", async () => {
		getAutoRefreshMock.mockRejectedValue(
			orpcError("FORBIDDEN", "Not a member of this project"),
		);

		const { container } = renderToggle();

		await waitFor(() => expect(container).toBeEmptyDOMElement());
	});

	it("renders an inert control explaining itself when the first read faults", async () => {
		const user = userEvent.setup();
		// No oRPC code: a transport fault, not an answer. The capability may well
		// exist — hiding the control here would be a lie about the product.
		getAutoRefreshMock.mockRejectedValue(new Error("Failed to fetch"));

		renderToggle();

		const button = await screen.findByRole("button", {
			name: "Auto-refresh unavailable — settings could not be loaded",
		});
		// `aria-disabled`, not `disabled`: a natively disabled button takes no
		// pointer or keyboard events, so the tooltip explaining WHY it cannot be
		// used would never open for anyone.
		expect(button).toHaveAttribute("aria-disabled", "true");

		await user.click(button);
		expect(setAutoRefreshMock).not.toHaveBeenCalled();
	});

	it("keeps the control mounted when a background refetch fails after data was shown", async () => {
		getAutoRefreshMock
			.mockResolvedValueOnce(
				settings({ enabled: true, cadence: "WEEKLY" }),
			)
			.mockRejectedValue(new Error("Gateway timeout"));

		const { queryClient } = renderToggle();

		const button = await screen.findByRole("button", {
			name: "Turn off scheduled auto-refresh",
		});
		expect(button).toHaveAttribute("aria-pressed", "true");

		await act(async () => {
			await queryClient.refetchQueries();
		});

		// Still there, still showing what it last knew — unmounting mid-
		// interaction would drop focus out of an open popover, and a vanished
		// control is indistinguishable from an absent capability.
		expect(
			screen.getByRole("button", {
				name: "Turn off scheduled auto-refresh",
			}),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Auto-refresh settings" }),
		).toBeInTheDocument();

		await waitFor(() => expect(toastErrorMock).toHaveBeenCalledTimes(1));
		expect(toastErrorMock.mock.calls[0]?.[1]).toEqual({
			description: "Gateway timeout",
		});
	});

	it("renders the control disabled — not absent — while the read is still in flight", async () => {
		getAutoRefreshMock.mockImplementation(() => new Promise(() => {}));

		renderToggle();

		const button = await screen.findByRole("button", {
			name: "Turn on scheduled auto-refresh",
		});
		expect(button).toBeDisabled();
		expect(toastErrorMock).not.toHaveBeenCalled();
	});

	it("renders the stored cadence once the read lands, not the default", async () => {
		const user = userEvent.setup();
		getAutoRefreshMock.mockResolvedValue(
			settings({ enabled: true, cadence: "MONTHLY" }),
		);

		renderToggle();
		await openSettings(user);

		expect(
			await screen.findByLabelText("Auto-refresh cadence"),
		).toHaveTextContent("Monthly");
	});
});

describe("DocumentAutoRefreshToggle — unwritable settings", () => {
	it("surfaces the server's own reason in the toast description", async () => {
		const user = userEvent.setup();
		setAutoRefreshMock.mockRejectedValue(
			orpcError("NOT_FOUND", "Auto-refresh is not available."),
		);

		renderToggle();

		const button = await screen.findByRole("button", {
			name: "Turn on scheduled auto-refresh",
		});
		await waitFor(() => expect(button).not.toBeDisabled());
		await user.click(button);

		await waitFor(() => expect(toastErrorMock).toHaveBeenCalledTimes(1));
		expect(toastErrorMock.mock.calls[0]?.[0]).toBe(
			"Could not update auto-refresh for this document.",
		);
		expect(toastErrorMock.mock.calls[0]?.[1]).toEqual({
			description: "Auto-refresh is not available.",
		});
	});

	it("shows the title alone — never the string 'undefined' — for a rejection with no message", async () => {
		const user = userEvent.setup();
		// Not an `Error`: there is no message to show, and the old
		// `String(error)` habit would have printed "undefined" into the toast.
		setAutoRefreshMock.mockRejectedValue({ notAnError: true });

		renderToggle();

		const button = await screen.findByRole("button", {
			name: "Turn on scheduled auto-refresh",
		});
		await waitFor(() => expect(button).not.toBeDisabled());
		await user.click(button);

		await waitFor(() => expect(toastErrorMock).toHaveBeenCalledTimes(1));
		expect(toastErrorMock.mock.calls[0]?.[1]).toEqual({
			description: undefined,
		});
		expect(JSON.stringify(toastErrorMock.mock.calls[0])).not.toContain(
			"undefined",
		);
	});
});
