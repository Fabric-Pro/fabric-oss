/**
 * #1898 — adding, excluding, and unlinking meetings from inside the digest.
 */

import { FeatureFlagProvider } from "@saas/shared/components/FeatureFlagProvider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MeetingDigestTab } from "../MeetingDigestTab";

const {
	unlinkMeetingMock,
	confirmMock,
	setIncludedMock,
	refreshAfterLinkMock,
	digestState,
} = vi.hoisted(() => ({
	unlinkMeetingMock: vi.fn(),
	confirmMock: vi.fn(),
	setIncludedMock: vi.fn(),
	refreshAfterLinkMock: vi.fn(),
	// Mutable so individual tests can force isLoading/isError without a
	// separate mock factory per scenario (Finding 1's reachability bug only
	// shows up when the digest query state and showConfig diverge).
	digestState: { isLoading: false, isError: false },
}));

vi.mock("../../hooks/use-meeting-digest", () => ({
	useMeetingDigest: () => ({
		meetings: [],
		configMeetings: [
			{
				linkedMeetingId: "lm1",
				subject: "DSU",
				includedInDigest: true,
				lastMeetingDate: null,
			},
		],
		seriesWithoutTranscripts: [],
		awaitingOccurrences: [],
		isLoading: digestState.isLoading,
		isError: digestState.isError,
		setIncluded: setIncludedMock,
		onActionItemToggled: vi.fn(),
		generateSummary: vi.fn(),
		generatingRefs: new Set(),
		summaryErrors: {},
		unlinkMeeting: unlinkMeetingMock,
		refreshAfterLink: refreshAfterLinkMock,
	}),
}));

vi.mock("../../hooks/use-linked-meeting-join-urls", () => ({
	LINKED_MEETINGS_QUERY_KEY: "meeting-transcript-sync-linked",
	useLinkedMeetingJoinUrls: () => ({ joinUrls: ["https://teams/a"] }),
}));

vi.mock("@saas/shared/components/ConfirmationAlertProvider", () => ({
	useConfirmationAlert: () => ({ confirm: confirmMock }),
}));

vi.mock("@saas/meetings/components", () => ({
	LinkedMeetingSelector: ({
		open,
		onLinked,
		onOpenChange,
		existingJoinUrls,
	}: {
		open: boolean;
		onLinked: () => void;
		onOpenChange: (open: boolean) => void;
		existingJoinUrls: string[];
	}) =>
		open ? (
			<div data-testid="meeting-picker">
				<span data-testid="existing-join-urls">
					{existingJoinUrls.join(",")}
				</span>
				<button type="button" onClick={() => onLinked()}>
					trigger-linked
				</button>
				<button type="button" onClick={() => onOpenChange(false)}>
					trigger-close
				</button>
			</div>
		) : null,
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

// FIX B (final review): the shared Button's own auto-loading guard
// (button.tsx: `if (disabled || loading || isAutoLoading) return;`, engaged
// whenever an onClick handler returns a promise-like, which is true for
// DigestConfigPanel's Exclude button) disables a button in flight
// regardless of the `disabled` prop DigestConfigPanel is given. That means
// a "disabled while in flight" assertion at the MeetingDigestTab level would
// stay green even if `pendingIncludeIds` were wired to the wrong key, or
// not wired at all — DigestConfigPanel.test.tsx already proves the
// prop→disabled wiring in isolation (using a synchronous onSetIncluded, so
// auto-loading never engages), but nothing proves MeetingDigestTab
// populates pendingIncludeIds with the *right* key. DigestConfigPanel
// doesn't expose a way to turn autoLoading off from its own props, so this
// forces it off for every Button rendered in this suite by wrapping the
// real component — the disabled-state assertions below can then only pass
// because of pendingIncludeIds.
vi.mock("@ui/components/button", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@ui/components/button")>();
	return {
		...actual,
		Button: (props: Parameters<typeof actual.Button>[0]) => (
			<actual.Button {...props} autoLoading={false} />
		),
	};
});

// MeetingDetailSheet and PersonalMeetingSheet are always mounted by
// MeetingDigestTab and call useQuery internally (gated by `enabled`, not by
// whether they're rendered at all), so any render needs a real orpcClient
// shape and a QueryClientProvider ancestor — mirrors the pattern already
// used by the sibling MeetingDigestTab.personal.test.tsx.
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			meetingDigest: {
				getMeeting: vi.fn(),
				getPersonalTranscript: vi.fn(),
			},
		},
	},
}));

function renderTab(canEdit = true) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	// PERSONAL_MEETINGS is off here: these are #1898 linking tests and none of
	// them touch the All-meetings filter, so `false` reproduces exactly what the
	// previously-unset NEXT_PUBLIC mirror gave this file. The provider is
	// required rather than optional — useFeatureFlag throws without one, by
	// design, so a missing provider can never read as a disabled feature.
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>
			<FeatureFlagProvider value={{ PERSONAL_MEETINGS: false }}>
				{children}
			</FeatureFlagProvider>
		</QueryClientProvider>
	);
	return render(
		<MeetingDigestTab
			projectId="p1"
			organizationId="o1"
			canEdit={canEdit}
		/>,
		{ wrapper },
	);
}

describe("MeetingDigestTab linking (#1898)", () => {
	beforeEach(() => {
		digestState.isLoading = false;
		digestState.isError = false;
	});

	// Test-hygiene fix (final review): the Exclude/unlink double-click tests
	// below install never-resolving `mockImplementation`s and used to undo
	// them with an explicit `mockReset()` on the test's last line. If either
	// test failed before reaching that line, the never-resolving promise
	// leaked into every later test in this file, producing a cascade of
	// unrelated-looking timeouts. `resetAllMocks` in `afterEach` always runs
	// (even on failure/throw) and clears both call history and
	// implementations, so nothing set inside a test body can survive past
	// it. None of this file's mocks are given an implementation at module
	// scope (every `.mockImplementation`/`.mockRejectedValueOnce` happens
	// inside a test body or `beforeEach`), so resetting is safe here.
	afterEach(() => {
		vi.resetAllMocks();
	});

	it("opens the meeting picker from the empty state, without navigating away", async () => {
		renderTab();
		expect(screen.queryByTestId("meeting-picker")).not.toBeInTheDocument();
		await userEvent.click(
			screen.getByRole("button", { name: /add meeting/i }),
		);
		expect(await screen.findByTestId("meeting-picker")).toBeInTheDocument();
	});

	it("no longer tells the user to go to project settings", () => {
		renderTab();
		expect(
			screen.queryByText(/in project settings/i),
		).not.toBeInTheDocument();
	});

	it("hides the add affordance when the user cannot edit", () => {
		renderTab(false);
		expect(
			screen.queryByRole("button", { name: /add meeting/i }),
		).not.toBeInTheDocument();
	});

	it("shows a single Add meeting affordance when the config panel is open, not a duplicate of the header's", async () => {
		renderTab();
		await userEvent.click(
			screen.getByRole("button", { name: /configure meetings/i }),
		);
		expect(
			screen.getAllByRole("button", { name: /add meeting/i }),
		).toHaveLength(1);
	});

	it("routes unlink through a destructive confirmation instead of unlinking immediately", async () => {
		renderTab();
		await userEvent.click(
			screen.getByRole("button", { name: /configure meetings/i }),
		);
		await userEvent.click(
			screen.getByRole("button", { name: /meeting options for dsu/i }),
		);
		await userEvent.click(await screen.findByText(/unlink meeting/i));

		expect(unlinkMeetingMock).not.toHaveBeenCalled();
		expect(confirmMock).toHaveBeenCalledTimes(1);

		const options = confirmMock.mock.calls[0][0];
		expect(options.destructive).toBe(true);
		expect(options.message).toMatch(/transcript/i);

		await options.onConfirm();
		await waitFor(() =>
			expect(unlinkMeetingMock).toHaveBeenCalledWith("lm1"),
		);
	});

	it("keeps exactly one Add meeting control reachable when showConfig is toggled on while the digest is still loading", async () => {
		// Regression for #1898 review finding 1: the header button used to be
		// gated on `!showConfig` instead of whether the config panel actually
		// renders, so an editor who opens "Configure meetings" while the
		// digest query is still loading (or errored) saw zero add controls —
		// the panel doesn't render (isLoading), the header button was hidden
		// (showConfig), and the empty state doesn't render either (isLoading).
		digestState.isLoading = true;
		renderTab();
		await userEvent.click(
			screen.getByRole("button", { name: /configure meetings/i }),
		);
		expect(
			screen.getAllByRole("button", { name: /add meeting/i }),
		).toHaveLength(1);
	});

	it("wires the picker's onLinked/onOpenChange/existingJoinUrls to the hook's refresh, close, and join-url state", async () => {
		renderTab();
		await userEvent.click(
			screen.getByRole("button", { name: /add meeting/i }),
		);
		expect(await screen.findByTestId("meeting-picker")).toBeInTheDocument();

		expect(screen.getByTestId("existing-join-urls")).toHaveTextContent(
			"https://teams/a",
		);

		await userEvent.click(
			screen.getByRole("button", { name: /trigger-linked/i }),
		);
		expect(refreshAfterLinkMock).toHaveBeenCalledTimes(1);

		await userEvent.click(
			screen.getByRole("button", { name: /trigger-close/i }),
		);
		expect(screen.queryByTestId("meeting-picker")).not.toBeInTheDocument();
	});

	it("shows a toast error when unlinking fails, without letting the confirmation's onConfirm reject", async () => {
		unlinkMeetingMock.mockRejectedValueOnce(new Error("boom"));
		renderTab();
		await userEvent.click(
			screen.getByRole("button", { name: /configure meetings/i }),
		);
		await userEvent.click(
			screen.getByRole("button", { name: /meeting options for dsu/i }),
		);
		await userEvent.click(await screen.findByText(/unlink meeting/i));

		const options = confirmMock.mock.calls[0][0];

		// The ConfirmationAlertProvider awaits onConfirm directly, so it must
		// never reject even when the underlying unlink call fails.
		await expect(options.onConfirm()).resolves.toBeUndefined();

		expect(toast.error).toHaveBeenCalledWith(
			"Failed to unlink meeting",
			expect.objectContaining({
				description: expect.stringMatching(/still linked/i),
			}),
		);
	});

	it("shows a toast error (not a silent failure) when Exclude's setIncluded call rejects (FIX 2)", async () => {
		setIncludedMock.mockRejectedValueOnce(new Error("boom"));
		renderTab();
		await userEvent.click(
			screen.getByRole("button", { name: /configure meetings/i }),
		);
		await userEvent.click(
			screen.getByRole("button", { name: /^exclude$/i }),
		);

		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith(
				"Failed to update meeting digest setting",
				expect.objectContaining({
					description: expect.stringMatching(
						/digest setting was not changed/i,
					),
				}),
			),
		);
	});

	it("disables the Exclude button while its setIncluded call is in flight, via MeetingDigestTab's own pendingIncludeIds guard, so a second click can't reverse the user's intent (FIX 3)", async () => {
		// The module-level Button mock above forces autoLoading off, so
		// Button's own in-flight guard cannot be what disables this button —
		// only DigestConfigPanel's `disabled={pendingIncludeIds?.has(...)}`,
		// fed by MeetingDigestTab's pendingIncludeIds state, can. That makes
		// the assertions below prove MeetingDigestTab tracks "lm1" (this
		// meeting's own linkedMeetingId) as pending, not just some prop that
		// happens to exist.
		let resolveSetIncluded: (() => void) | undefined;
		setIncludedMock.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					resolveSetIncluded = resolve;
				}),
		);
		renderTab();
		await userEvent.click(
			screen.getByRole("button", { name: /configure meetings/i }),
		);
		const excludeButton = screen.getByRole("button", {
			name: /^exclude$/i,
		});

		await userEvent.click(excludeButton);
		expect(setIncludedMock).toHaveBeenCalledTimes(1);
		await waitFor(() => expect(excludeButton).toBeDisabled());

		// Second click while the first is still in flight: the row is
		// disabled, so this must not fire a second setIncluded call (and
		// must not send the opposite `included` value, reversing intent).
		await userEvent.click(excludeButton);
		expect(setIncludedMock).toHaveBeenCalledTimes(1);

		resolveSetIncluded?.();
		await waitFor(() => expect(excludeButton).not.toBeDisabled());
	});

	it("guards against a second onConfirm invocation while an unlink is already in flight for that meeting (FIX 4)", async () => {
		let resolveUnlink: (() => void) | undefined;
		unlinkMeetingMock.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					resolveUnlink = resolve;
				}),
		);
		renderTab();
		await userEvent.click(
			screen.getByRole("button", { name: /configure meetings/i }),
		);
		await userEvent.click(
			screen.getByRole("button", { name: /meeting options for dsu/i }),
		);
		await userEvent.click(await screen.findByText(/unlink meeting/i));

		const options = confirmMock.mock.calls[0][0];

		// Simulate a double-click on the AlertDialog's confirm button: the
		// dialog stays open and clickable for the whole round trip, so a
		// second click before the first resolves re-invokes this same
		// onConfirm closure.
		const firstCall = options.onConfirm();
		const secondCall = options.onConfirm();

		// The second (overlapping) invocation must be a no-op — it resolves
		// immediately without calling unlinkMeeting again.
		await secondCall;
		expect(unlinkMeetingMock).toHaveBeenCalledTimes(1);

		resolveUnlink?.();
		await firstCall;
		expect(toast.success).toHaveBeenCalledWith("Meeting unlinked");
	});
});
