/**
 * Tests for `NotificationPreferencesForm` — the account-global notification
 * preference toggles (spec AC-7, DV-2).
 *
 * The form is a thin view over two hooks from
 * `@saas/notifications/hooks/use-notification-preferences`:
 *   - `useNotificationPreferences()` → `{ data, isLoading }` (the read)
 *   - `useUpdateNotificationPreferences()` → a react-query mutation object
 *     exposing `.mutate` + `.isPending` (the write)
 *
 * We mock the hook module wholesale so the test drives the view in isolation
 * — no react-query provider, no oRPC client, no tenant context. The mutate
 * spy is hoisted (`vi.hoisted`) so the `vi.mock` factory can close over it
 * while individual tests still read its calls.
 *
 * What we cover
 * ------------
 *   (a) Six category rows render, each a Radix `role="switch"` with its label.
 *   (b) Toggling an enabled switch calls `update.mutate` with ONLY that flag
 *       flipped (e.g. `{ mentions: false }`) — the partial-update contract.
 *   (c) `syncIntegrationAvailable === false` greys out the `syncProject`
 *       switch (`disabled`) AND surfaces the connect-an-integration tooltip
 *       copy in the DOM (it's mirrored onto the switch's `aria-label`, so it's
 *       reachable by screen readers without a hover, plus the loading state).
 *
 * Why fireEvent.click instead of userEvent
 * -----------------------------------------
 * Radix's `Switch` flips on a real pointer/click event. `fireEvent.click` on
 * the `role="switch"` element is the reliable way to trigger
 * `onCheckedChange` under jsdom; userEvent's pointer sequence is more
 * fragile here and adds nothing to these assertions.
 */

import type {
	NotificationPreferenceFlags,
	NotificationPreferences,
} from "@saas/notifications/hooks/use-notification-preferences";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockMutate } = vi.hoisted(() => ({
	mockMutate: vi.fn(),
}));

// Controllable hook return values. Tests mutate these refs before rendering
// to drive the loading / data / integration-availability branches.
const hookState: {
	data: NotificationPreferences | undefined;
	isLoading: boolean;
	isPending: boolean;
} = {
	data: undefined,
	isLoading: false,
	isPending: false,
};

vi.mock("@saas/notifications/hooks/use-notification-preferences", () => ({
	useNotificationPreferences: () => ({
		data: hookState.data,
		isLoading: hookState.isLoading,
	}),
	useUpdateNotificationPreferences: () => ({
		mutate: mockMutate,
		isPending: hookState.isPending,
	}),
}));

import { NotificationPreferencesForm } from "../../modules/saas/settings/components/NotificationPreferencesForm";

const SYNC_DISABLED_TOOLTIP =
	"Connect a project-management integration to receive sync notifications.";

/** All categories on, integration available — the happy default. */
function fullPreferences(
	overrides: Partial<NotificationPreferences> = {},
): NotificationPreferences {
	return {
		mentions: true,
		replies: true,
		assignments: true,
		status: true,
		syncProject: true,
		aiAgent: true,
		publishingSuggestions: true,
		reportEmails: true,
		reviewEmails: true,
		publishingEmails: true,
		syncIntegrationAvailable: true,
		// Display-only (#2117), not a delivery gate — and the one preference
		// here that defaults OFF, because the card style is opt-in.
		stackedCardStyle: false,
		...overrides,
	};
}

// Visible label text per category, in render order. Keep in sync with the
// component's TOGGLES table.
const CATEGORY_LABELS = [
	"Mentions",
	"Replies",
	"Assignments",
	"Status changes",
	"Sync & integrations",
	"AI & agents",
	"Publishing suggestions",
];

beforeEach(() => {
	mockMutate.mockReset();
	hookState.data = fullPreferences();
	hookState.isLoading = false;
	hookState.isPending = false;
});

describe("NotificationPreferencesForm — loading state", () => {
	it("shows a spinner while loading and renders no switches", () => {
		hookState.isLoading = true;
		hookState.data = undefined;
		render(<NotificationPreferencesForm />);

		expect(
			screen.getByLabelText("Loading notification preferences"),
		).toBeInTheDocument();
		expect(screen.queryAllByRole("switch")).toHaveLength(0);
	});

	it("also shows the spinner when data is absent even if not flagged loading", () => {
		// Defensive branch in the component: `isLoading || !data`.
		hookState.isLoading = false;
		hookState.data = undefined;
		render(<NotificationPreferencesForm />);

		expect(
			screen.getByLabelText("Loading notification preferences"),
		).toBeInTheDocument();
	});
});

describe("NotificationPreferencesForm — rendered categories", () => {
	it("renders a role=switch for each category with its label", () => {
		render(<NotificationPreferencesForm />);

		// Seven in-app category switches (incl. publishingSuggestions — Fizzy
		// #1850) + three email-channel switches (report runs, release-notes
		// awaiting review — #2172, and publishing suggestion emails — #1850
		// 1C-2c) + the display-style switch (#2117).
		const switches = screen.getAllByRole("switch");
		expect(switches).toHaveLength(11);

		for (const label of CATEGORY_LABELS) {
			expect(screen.getByText(label)).toBeInTheDocument();
		}
	});

	it("reflects the on/off state from data via aria-checked", () => {
		hookState.data = fullPreferences({ mentions: true, replies: false });
		render(<NotificationPreferencesForm />);

		// `mentions` is the first switch (aria-label "Mentions"), `replies`
		// the second (aria-label "Replies"). Radix mirrors checked state to
		// `aria-checked`.
		expect(
			screen
				.getByRole("switch", { name: "Mentions" })
				.getAttribute("aria-checked"),
		).toBe("true");
		expect(
			screen
				.getByRole("switch", { name: "Replies" })
				.getAttribute("aria-checked"),
		).toBe("false");
	});
});

describe("NotificationPreferencesForm — toggling", () => {
	it("calls mutate with the single flipped flag when an enabled switch is clicked", () => {
		// `mentions` starts ON → clicking it requests `{ mentions: false }`.
		hookState.data = fullPreferences({ mentions: true });
		render(<NotificationPreferencesForm />);

		fireEvent.click(screen.getByRole("switch", { name: "Mentions" }));

		expect(mockMutate).toHaveBeenCalledTimes(1);
		expect(mockMutate).toHaveBeenCalledWith({ mentions: false });
	});

	it("flips an OFF switch to ON with only that flag in the payload", () => {
		hookState.data = fullPreferences({ aiAgent: false });
		render(<NotificationPreferencesForm />);

		fireEvent.click(screen.getByRole("switch", { name: "AI & agents" }));

		expect(mockMutate).toHaveBeenCalledTimes(1);
		const payload = mockMutate.mock
			.calls[0][0] as Partial<NotificationPreferenceFlags>;
		expect(payload).toEqual({ aiAgent: true });
		// Partial-update contract: exactly one key in the payload.
		expect(Object.keys(payload)).toEqual(["aiAgent"]);
	});

	it("does not fire mutate when switches are merely rendered", () => {
		render(<NotificationPreferencesForm />);
		expect(mockMutate).not.toHaveBeenCalled();
	});

	it("calls mutate with { publishingSuggestions: false } when the publishing switch is flipped off", () => {
		hookState.data = fullPreferences({ publishingSuggestions: true });
		render(<NotificationPreferencesForm />);

		fireEvent.click(
			screen.getByRole("switch", { name: "Publishing suggestions" }),
		);

		expect(mockMutate).toHaveBeenCalledTimes(1);
		expect(mockMutate).toHaveBeenCalledWith({
			publishingSuggestions: false,
		});
	});
});

describe("NotificationPreferencesForm — sync integration unavailable", () => {
	it("disables the syncProject switch when syncIntegrationAvailable is false", () => {
		hookState.data = fullPreferences({ syncIntegrationAvailable: false });
		render(<NotificationPreferencesForm />);

		// The disabled switch's aria-label is "<label> — <tooltip copy>".
		const syncSwitch = screen.getByRole("switch", {
			name: `Sync & integrations — ${SYNC_DISABLED_TOOLTIP}`,
		});
		expect(syncSwitch).toBeDisabled();

		// The other six in-app switches, all three email-channel switches and
		// the display-style switch stay interactive — a missing PM integration
		// gates delivery, never presentation.
		const enabled = screen
			.getAllByRole("switch")
			.filter((el) => !(el as HTMLButtonElement).disabled);
		expect(enabled).toHaveLength(10);
	});

	it("surfaces the connect-an-integration tooltip copy in the accessible DOM", () => {
		hookState.data = fullPreferences({ syncIntegrationAvailable: false });
		render(<NotificationPreferencesForm />);

		// The copy is mirrored onto the switch's aria-label so screen-reader
		// users get the reason without needing the hover-only TooltipContent.
		const syncSwitch = screen.getByRole("switch", {
			name: `Sync & integrations — ${SYNC_DISABLED_TOOLTIP}`,
		});
		expect(syncSwitch.getAttribute("aria-label")).toContain(
			SYNC_DISABLED_TOOLTIP,
		);
	});

	it("does not call mutate when the disabled syncProject switch is clicked", () => {
		hookState.data = fullPreferences({ syncIntegrationAvailable: false });
		render(<NotificationPreferencesForm />);

		fireEvent.click(
			screen.getByRole("switch", {
				name: `Sync & integrations — ${SYNC_DISABLED_TOOLTIP}`,
			}),
		);
		expect(mockMutate).not.toHaveBeenCalled();
	});

	it("keeps the syncProject switch enabled when an integration IS available", () => {
		hookState.data = fullPreferences({ syncIntegrationAvailable: true });
		render(<NotificationPreferencesForm />);

		const syncSwitch = screen.getByRole("switch", {
			name: "Sync & integrations",
		});
		expect(syncSwitch).toBeEnabled();
	});
});

describe("NotificationPreferencesForm — pending mutation", () => {
	it("disables every switch while a mutation is in flight", () => {
		hookState.isPending = true;
		render(<NotificationPreferencesForm />);

		const switches = screen.getAllByRole("switch");
		expect(switches).toHaveLength(11);
		for (const el of switches) {
			expect(el).toBeDisabled();
		}
	});
});

describe("NotificationPreferencesForm — email channel", () => {
	it("renders the report-run email toggle in its own subsection", () => {
		render(<NotificationPreferencesForm />);

		// Distinct "Email notifications" section heading, separate from the
		// always-on in-app category bell above.
		expect(screen.getByText("Email notifications")).toBeInTheDocument();
		expect(
			screen.getByRole("switch", { name: "Report run emails" }),
		).toBeInTheDocument();
	});

	it("calls mutate with { reportEmails: false } when the email toggle is flipped off", () => {
		hookState.data = fullPreferences({ reportEmails: true });
		render(<NotificationPreferencesForm />);

		fireEvent.click(
			screen.getByRole("switch", { name: "Report run emails" }),
		);

		expect(mockMutate).toHaveBeenCalledTimes(1);
		expect(mockMutate).toHaveBeenCalledWith({ reportEmails: false });
	});

	it("keeps the email toggle enabled regardless of integration availability", () => {
		hookState.data = fullPreferences({ syncIntegrationAvailable: false });
		render(<NotificationPreferencesForm />);

		expect(
			screen.getByRole("switch", { name: "Report run emails" }),
		).toBeEnabled();
	});

	it("renders the release-notes review email toggle beside it", () => {
		render(<NotificationPreferencesForm />);

		expect(
			screen.getByRole("switch", {
				name: "Release notes awaiting review",
			}),
		).toBeInTheDocument();
	});

	it("calls mutate with { reviewEmails: false } when the review toggle is flipped off", () => {
		// The partial-update contract: turning the review email off must not
		// carry any sibling flag along (Fizzy #2172).
		hookState.data = fullPreferences({ reviewEmails: true });
		render(<NotificationPreferencesForm />);

		fireEvent.click(
			screen.getByRole("switch", {
				name: "Release notes awaiting review",
			}),
		);

		expect(mockMutate).toHaveBeenCalledTimes(1);
		expect(mockMutate).toHaveBeenCalledWith({ reviewEmails: false });
	});

	it("renders the publishing suggestion email toggle beside the others", () => {
		render(<NotificationPreferencesForm />);

		expect(
			screen.getByRole("switch", {
				name: "Publishing suggestion emails",
			}),
		).toBeInTheDocument();
	});

	it("calls mutate with { publishingEmails: false } when the publishing email switch is flipped off", () => {
		hookState.data = fullPreferences({ publishingEmails: true });
		render(<NotificationPreferencesForm />);

		fireEvent.click(
			screen.getByRole("switch", {
				name: "Publishing suggestion emails",
			}),
		);

		expect(mockMutate).toHaveBeenCalledTimes(1);
		expect(mockMutate).toHaveBeenCalledWith({
			publishingEmails: false,
		});
	});
});
