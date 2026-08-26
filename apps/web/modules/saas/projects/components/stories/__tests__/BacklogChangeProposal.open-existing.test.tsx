/**
 * BacklogChangeProposal — "open existing ticket" affordance.
 *
 * Covers the external-link icon button added to resolved "Update" proposal
 * rows (spec `2026-06-25-open-existing-features-from-ai-update-panels` §9.1),
 * mapped case-by-case to AC-1..AC-8. The affordance lives in the shared
 * change-row renderer, so a single `panel` discriminator prop covers both the
 * AI Update panel and the Feature Proposals panel.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	BacklogChangeProposal,
	type ChangeItem,
} from "../BacklogChangeProposal";

// Mutable, hoisted test doubles referenced by the module mocks below. A
// hoisted record lets the (hoisted) `vi.mock` factories close over values we
// can still mutate per-test — e.g. switching the XOR base path.
const h = vi.hoisted(() => ({
	trackEvent: vi.fn(),
	basePath: "/app/acme",
}));

// orpc-client is imported at module load for PM-sync conflict checks.
vi.mock("../../../../../shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			stories: {
				checkPmSyncConflicts: vi
					.fn()
					.mockResolvedValue({ results: [] }),
				retryPmSyncBatch: vi.fn(),
			},
		},
	},
}));

// `@analytics` is NOT globally mocked, and the real `trackEvent` no-ops
// unless cookie consent is granted — mock it so we can assert emissions.
vi.mock("@analytics", () => ({
	useAnalytics: () => ({ trackEvent: h.trackEvent }),
}));

// Switchable XOR base path: "/app/acme" (org) vs "/app" (personal).
vi.mock("@saas/organizations/hooks/use-organization-context", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	useBasePath: () => h.basePath,
}));

// Override the global next-intl key-passthrough mock so the affordance's
// interpolated aria-label / tooltip / "Ticket not found" copy resolve to the
// real en.json strings — this is what lets us assert the descriptive AC-4
// label format (`Open existing ticket: {identifier} — {title}`). Unknown keys
// fall through to the key, matching the global mock for the rest of the tree.
vi.mock("next-intl", () => ({
	useTranslations: () => (key: string, params?: Record<string, unknown>) => {
		if (key === "openExisting") {
			return `Open existing ticket: ${params?.identifier ?? ""} — ${params?.title ?? ""}`;
		}
		if (key === "openExistingTooltip") {
			return "Open this existing feature in a new tab to review its current content.";
		}
		if (key === "ticketNotFound") {
			return "Ticket not found";
		}
		return key;
	},
	useLocale: () => "en",
	useFormatter: () => ({
		dateTime: (d: Date) => d.toISOString(),
		number: (n: number) => String(n),
		relativeTime: (d: Date) => d.toISOString(),
	}),
	useMessages: () => ({}),
	NextIntlClientProvider: ({ children }: { children: React.ReactNode }) =>
		children,
}));

const RESOLVED_LABEL = "Open existing ticket: F-2 — Login";
const OPEN_BUTTON = { name: /Open existing ticket/ } as const;

function buildChange(overrides: Partial<ChangeItem> = {}): ChangeItem {
	return {
		type: "feature",
		action: "create",
		title: { to: "Login page improvements" },
		reasoning: "Reviewer needs to inspect the current ticket.",
		sourceContext: "teams_messages",
		...overrides,
	};
}

// A resolved Update: action "update", a real `existingId`, and a backend
// `targetResolution` stamp matching that id — the only state that gets a
// working open affordance.
function resolvedUpdate(overrides: Partial<ChangeItem> = {}): ChangeItem {
	return buildChange({
		action: "update",
		existingId: "story_1",
		targetResolution: {
			status: "resolved",
			resolvedIdentifier: "F-2",
			resolvedTitle: "Login",
		},
		...overrides,
	});
}

function renderProposal(
	props: Partial<React.ComponentProps<typeof BacklogChangeProposal>> = {},
) {
	return render(
		<BacklogChangeProposal
			summary="Test proposal"
			contextSummary="Captured from a Teams thread"
			changes={props.changes ?? [resolvedUpdate()]}
			projectId="proj_1"
			hasPMTool={false}
			onApprove={vi.fn()}
			onReject={vi.fn()}
			{...props}
		/>,
	);
}

let openSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	h.basePath = "/app/acme";
	h.trackEvent.mockClear();
	openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
});

afterEach(() => {
	openSpy.mockRestore();
});

describe("BacklogChangeProposal — open existing ticket affordance", () => {
	it("renders the open affordance on a resolved update row (AC-1)", () => {
		renderProposal({ changes: [resolvedUpdate()] });

		expect(
			screen.getByRole("button", { name: RESOLVED_LABEL }),
		).toBeInTheDocument();
	});

	it("opens the existing ticket in a new tab with noopener,noreferrer (AC-1)", async () => {
		const user = userEvent.setup();
		renderProposal({ changes: [resolvedUpdate()] });

		await user.click(screen.getByRole("button", { name: RESOLVED_LABEL }));

		expect(openSpy).toHaveBeenCalledTimes(1);
		expect(openSpy).toHaveBeenCalledWith(
			"/app/acme/projects/proj_1/stories/story_1",
			"_blank",
			"noopener,noreferrer",
		);
	});

	it("builds the deep link from the tenant XOR base path (NFR-3, AC-1)", async () => {
		const user = userEvent.setup();
		h.basePath = "/app"; // personal context
		renderProposal({ changes: [resolvedUpdate()] });

		await user.click(screen.getByRole("button", { name: RESOLVED_LABEL }));

		expect(openSpy).toHaveBeenCalledWith(
			"/app/projects/proj_1/stories/story_1",
			"_blank",
			"noopener,noreferrer",
		);
	});

	it("shows no affordance and no 'Ticket not found' on a create row (AC-2, AC-5)", () => {
		renderProposal({ changes: [buildChange({ action: "create" })] });

		expect(
			screen.queryByRole("button", OPEN_BUTTON),
		).not.toBeInTheDocument();
		expect(screen.queryByText("Ticket not found")).not.toBeInTheDocument();
	});

	it("shows 'Ticket not found' and never navigates for an unresolved update (AC-3, AC-5)", () => {
		renderProposal({
			changes: [
				buildChange({
					action: "update",
					targetResolution: { status: "unresolved" },
				}),
			],
		});

		expect(screen.getByText("Ticket not found")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", OPEN_BUTTON),
		).not.toBeInTheDocument();
		expect(openSpy).not.toHaveBeenCalled();
	});

	it("shows the demoted badge and 'Ticket not found' for a demoted update (AC-3)", () => {
		renderProposal({
			changes: [
				buildChange({
					action: "update",
					targetResolution: {
						status: "unresolved",
						demotedFromUpdate: true,
					},
				}),
			],
		});

		expect(
			screen.getByText(/New item — no existing match/),
		).toBeInTheDocument();
		expect(screen.getByText("Ticket not found")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", OPEN_BUTTON),
		).not.toBeInTheDocument();
	});

	it("treats a resolved status with no existingId as not-found (FR-6)", () => {
		renderProposal({
			changes: [
				buildChange({
					action: "update",
					existingId: undefined,
					targetResolution: {
						status: "resolved",
						resolvedIdentifier: "F-3",
						resolvedTitle: "Reset password",
					},
				}),
			],
		});

		// No existingId → nothing to open: no "Updates" badge, no button.
		expect(screen.queryByText(/Updates F-3/)).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", OPEN_BUTTON),
		).not.toBeInTheDocument();
		expect(screen.getByText("Ticket not found")).toBeInTheDocument();
	});

	it("shows the affordance for an inbox update with existingId and no targetResolution (regression)", async () => {
		// Real channel-monitor inbox shape: the target is carried via
		// existingId/existingIdentifier with NO targetResolution stamp —
		// the icon must still render (the original bug showed "Ticket not found").
		const user = userEvent.setup();
		renderProposal({
			changes: [
				buildChange({
					action: "update",
					existingId: "story_feat8",
					existingIdentifier: "FEAT-008",
				}),
			],
		});

		const button = screen.getByRole("button", {
			name: /Open existing ticket: FEAT-008/,
		});
		expect(button).toBeInTheDocument();
		expect(screen.getByText(/Updates FEAT-008/)).toBeInTheDocument();
		expect(screen.queryByText("Ticket not found")).not.toBeInTheDocument();

		await user.click(button);
		expect(openSpy).toHaveBeenCalledWith(
			"/app/acme/projects/proj_1/stories/story_feat8",
			"_blank",
			"noopener,noreferrer",
		);
	});

	it("is keyboard reachable and activates on Enter and Space (AC-4)", async () => {
		const user = userEvent.setup();
		const { unmount } = renderProposal({ changes: [resolvedUpdate()] });

		const button = screen.getByRole("button", { name: RESOLVED_LABEL });
		// Native <button> → in the tab order and focusable.
		button.focus();
		expect(button).toHaveFocus();

		await user.keyboard("{Enter}");
		expect(openSpy).toHaveBeenCalledTimes(1);

		// Space on a fresh render also activates (native button semantics).
		unmount();
		openSpy.mockClear();
		renderProposal({ changes: [resolvedUpdate()] });
		screen.getByRole("button", { name: RESOLVED_LABEL }).focus();
		await user.keyboard(" ");
		expect(openSpy).toHaveBeenCalledTimes(1);
	});

	it("keeps reject functional in an unresolved row (FR-10)", async () => {
		const user = userEvent.setup();
		const onReject = vi.fn();
		renderProposal({
			changes: [
				buildChange({
					action: "update",
					targetResolution: { status: "unresolved" },
				}),
			],
			onReject,
		});

		await user.click(
			screen.getByRole("button", { name: "Reject all proposed changes" }),
		);
		expect(onReject).toHaveBeenCalledTimes(1);
	});

	it("keeps approve functional in an unresolved row (FR-10)", async () => {
		const user = userEvent.setup();
		const onApprove = vi.fn();
		renderProposal({
			changes: [
				buildChange({
					action: "update",
					targetResolution: { status: "unresolved" },
				}),
			],
			onApprove,
		});

		await user.click(
			screen.getByRole("button", { name: /Apply Selected/ }),
		);
		expect(onApprove).toHaveBeenCalledTimes(1);
	});

	it("emits the panel-discriminated analytics event (AC-8, AC-7)", async () => {
		const user = userEvent.setup();

		// Defaults to "ai-update" when no panel prop is passed.
		const { unmount } = renderProposal({ changes: [resolvedUpdate()] });
		await user.click(screen.getByRole("button", { name: RESOLVED_LABEL }));
		expect(h.trackEvent).toHaveBeenCalledWith(
			"backlog.proposal.openExistingTicket",
			{ panel: "ai-update" },
		);
		unmount();
		h.trackEvent.mockClear();

		// Feature Proposals panel sets the discriminator explicitly.
		renderProposal({
			changes: [resolvedUpdate()],
			panel: "feature-proposals",
		});
		await user.click(screen.getByRole("button", { name: RESOLVED_LABEL }));
		expect(h.trackEvent).toHaveBeenCalledWith(
			"backlog.proposal.openExistingTicket",
			{ panel: "feature-proposals" },
		);
	});

	it("renders an identical affordance and URL regardless of mounting panel (AC-7)", async () => {
		const user = userEvent.setup();

		for (const panel of ["ai-update", "feature-proposals"] as const) {
			const { unmount } = renderProposal({
				changes: [resolvedUpdate()],
				panel,
			});

			await user.click(
				screen.getByRole("button", { name: RESOLVED_LABEL }),
			);
			expect(openSpy).toHaveBeenCalledWith(
				"/app/acme/projects/proj_1/stories/story_1",
				"_blank",
				"noopener,noreferrer",
			);

			openSpy.mockClear();
			unmount();
		}
	});
});
