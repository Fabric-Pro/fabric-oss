import { FeatureFlagProvider } from "@saas/shared/components/FeatureFlagProvider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { useMeetingDigest, usePersonalMeetings } = vi.hoisted(() => ({
	useMeetingDigest: vi.fn(),
	usePersonalMeetings: vi.fn(),
}));

vi.mock("../../hooks/use-meeting-digest", () => ({ useMeetingDigest }));
vi.mock("../../hooks/use-personal-meetings", () => ({ usePersonalMeetings }));
// Rendered outside the app's provider tree; the confirmation provider no longer
// supplies a no-op default (#1905), so the hook is mocked as the siblings do.
vi.mock("@saas/shared/components/ConfirmationAlertProvider", () => ({
	useConfirmationAlert: () => ({ confirm: vi.fn() }),
}));
vi.mock("@saas/get-started/components/PageTourButton", () => ({
	PageTourButton: () => null,
}));
// MeetingDetailSheet and PersonalMeetingSheet are always mounted by
// MeetingDigestTab and call useQuery internally (gated by `enabled`, not by
// whether they're rendered at all), so any render needs a real orpcClient
// shape and a QueryClientProvider ancestor — mirrors the pattern already
// used by the sibling MeetingDigestTab.test.tsx and PersonalMeetingSheet.test.tsx.
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

import { readInsights, writeInsights } from "../../lib/personal-insights-cache";
import { MeetingDigestTab } from "../MeetingDigestTab";
import { personalCacheConsentStorageKey } from "../PersonalMeetingsConsent";

const PERSONAL = [
	{
		id: "evt1",
		subject: "1:1 with Sam",
		startTime: "2026-07-14T09:00:00Z",
		organizer: "Sam Rivers",
		joinUrl: "https://teams.microsoft.com/l/meetup-join/AAA",
	},
];

function renderTab(personalMeetingsEnabled = true) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>
			<FeatureFlagProvider
				value={{ PERSONAL_MEETINGS: personalMeetingsEnabled }}
			>
				{children}
			</FeatureFlagProvider>
		</QueryClientProvider>
	);
	return render(
		<MeetingDigestTab
			projectId="p1"
			organizationId={null}
			canEdit={false}
		/>,
		{ wrapper },
	);
}

describe("MeetingDigestTab personal meetings", () => {
	beforeEach(() => {
		// PERSONAL[0].startTime is a fixed July 2026 date, and monthDate
		// initialises to the real `new Date()`. CalendarCanvas only renders
		// days within the current month grid, so without a frozen clock this
		// suite silently breaks the moment the wall clock crosses into
		// August 2026. Freeze it to match the fixture.
		vi.useFakeTimers({ shouldAdvanceTime: true });
		vi.setSystemTime(new Date("2026-07-14T12:00:00Z"));
		sessionStorage.clear();
		vi.clearAllMocks();
		useMeetingDigest.mockReturnValue({
			meetings: [],
			configMeetings: [],
			seriesWithoutTranscripts: [],
			awaitingOccurrences: [],
			isLoading: false,
			isError: false,
			setIncluded: vi.fn(),
			onActionItemToggled: vi.fn(),
			generateSummary: vi.fn(),
			generatingRefs: new Set(),
			summaryErrors: {},
		});
		usePersonalMeetings.mockReturnValue({
			personalMeetings: PERSONAL,
			isLoading: false,
			isError: false,
			notConnected: false,
		});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("hides the filter entirely when the feature flag is off", () => {
		renderTab(false);

		expect(
			screen.queryByRole("button", { name: /all meetings/i }),
		).toBeNull();
	});

	it("defaults to Team with personal fetching disabled (FR2)", () => {
		renderTab();

		expect(screen.getByRole("button", { name: /^team$/i })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		expect(usePersonalMeetings).toHaveBeenCalledWith(
			expect.objectContaining({ enabled: false }),
		);
	});

	it("prompts for consent instead of loading data when All is selected", async () => {
		renderTab();
		fireEvent.click(screen.getByRole("button", { name: /all meetings/i }));

		await waitFor(() =>
			expect(
				screen.getByRole("button", {
					name: /enable personal meetings/i,
				}),
			).toBeTruthy(),
		);
		// Still disabled: selecting the filter is not consent.
		expect(usePersonalMeetings).toHaveBeenLastCalledWith(
			expect.objectContaining({ enabled: false }),
		);
	});

	it("loads personal meetings once consent is given", async () => {
		renderTab();
		fireEvent.click(screen.getByRole("button", { name: /all meetings/i }));
		fireEvent.click(
			screen.getByRole("button", { name: /enable personal meetings/i }),
		);

		await waitFor(() =>
			expect(usePersonalMeetings).toHaveBeenLastCalledWith(
				expect.objectContaining({ enabled: true }),
			),
		);
		expect(screen.getByText("1:1 with Sam")).toBeTruthy();
	});

	it("reverts to team-only when personal meetings are turned off (FR6)", async () => {
		renderTab();
		fireEvent.click(screen.getByRole("button", { name: /all meetings/i }));
		fireEvent.click(
			screen.getByRole("button", { name: /enable personal meetings/i }),
		);
		await waitFor(() => screen.getByText("1:1 with Sam"));

		fireEvent.click(screen.getByRole("button", { name: /turn off/i }));

		await waitFor(() =>
			expect(screen.queryByText("1:1 with Sam")).toBeNull(),
		);
		expect(usePersonalMeetings).toHaveBeenLastCalledWith(
			expect.objectContaining({ enabled: false }),
		);
	});

	it("shows a connect prompt instead of the generic empty state when Microsoft isn't connected", async () => {
		usePersonalMeetings.mockReturnValue({
			personalMeetings: [],
			isLoading: false,
			isError: false,
			notConnected: true,
		});
		renderTab();
		fireEvent.click(screen.getByRole("button", { name: /all meetings/i }));
		fireEvent.click(
			screen.getByRole("button", { name: /enable personal meetings/i }),
		);

		await waitFor(() =>
			expect(
				screen.getByText(/connect your microsoft account/i),
			).toBeTruthy(),
		);
		expect(screen.queryByText(/no meetings in the digest yet/i)).toBeNull();
	});

	it("shows an error line instead of the generic empty state when personal meetings fail to load", async () => {
		usePersonalMeetings.mockReturnValue({
			personalMeetings: [],
			isLoading: false,
			isError: true,
			notConnected: false,
		});
		renderTab();
		fireEvent.click(screen.getByRole("button", { name: /all meetings/i }));
		fireEvent.click(
			screen.getByRole("button", { name: /enable personal meetings/i }),
		);

		await waitFor(() =>
			expect(
				screen.getByText(/failed to load your personal meetings/i),
			).toBeTruthy(),
		);
		expect(screen.queryByText(/no meetings in the digest yet/i)).toBeNull();
	});

	it("shows a loading line instead of the generic empty state while personal meetings are in flight", async () => {
		usePersonalMeetings.mockReturnValue({
			personalMeetings: [],
			isLoading: true,
			isError: false,
			notConnected: false,
		});
		renderTab();
		fireEvent.click(screen.getByRole("button", { name: /all meetings/i }));
		fireEvent.click(
			screen.getByRole("button", { name: /enable personal meetings/i }),
		);

		await waitFor(() =>
			expect(
				screen.getByText(/loading your personal meetings/i),
			).toBeTruthy(),
		);
		expect(screen.queryByText(/no meetings in the digest yet/i)).toBeNull();
	});
});

describe("MeetingDigestTab insights cache wiring (#2104)", () => {
	const USER = "u1";

	function renderCacheTab(insightsCacheEnabled: boolean) {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={client}>
				<FeatureFlagProvider
					value={{
						PERSONAL_MEETINGS: true,
						PERSONAL_INSIGHTS_CACHE: insightsCacheEnabled,
					}}
				>
					{children}
				</FeatureFlagProvider>
			</QueryClientProvider>
		);
		return render(
			<MeetingDigestTab
				projectId="p1"
				organizationId={null}
				canEdit={false}
				userId={USER}
			/>,
			{ wrapper },
		);
	}

	/** Select "All meetings" and grant the #1899 consent. */
	function consentToPersonal() {
		fireEvent.click(screen.getByText("All meetings"));
		fireEvent.click(screen.getByText("Enable personal meetings"));
	}

	beforeEach(() => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		vi.setSystemTime(new Date("2026-07-14T12:00:00Z"));
		sessionStorage.clear();
		localStorage.clear();
		vi.clearAllMocks();
		useMeetingDigest.mockReturnValue({
			meetings: [],
			configMeetings: [],
			seriesWithoutTranscripts: [],
			awaitingOccurrences: [],
			isLoading: false,
			isError: false,
			setIncluded: vi.fn(),
			onActionItemToggled: vi.fn(),
			generateSummary: vi.fn(),
			generatingRefs: new Set(),
			summaryErrors: {},
		});
		usePersonalMeetings.mockReturnValue({
			personalMeetings: PERSONAL,
			isLoading: false,
			isError: false,
			notConnected: false,
		});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("hides the cache toggle when the #2104 flag is off", () => {
		renderCacheTab(false);
		consentToPersonal();

		expect(screen.queryByText("Remember summaries")).toBeNull();
	});

	it("shows the cache toggle when the #2104 flag is on", () => {
		renderCacheTab(true);
		consentToPersonal();

		expect(screen.getByText("Remember summaries")).toBeTruthy();
	});

	/**
	 * Turning the flag off is the feature's kill switch, and a kill switch that
	 * only hides the control is not one: staging QA of #2104 found that with
	 * the flag off, summaries and the opt-in key both stayed on the device
	 * while "Forget summaries" — the only way to erase them — disappeared with
	 * the toggle. Same invariant as every other revocation path here: cached
	 * personal data never outlives the consent that created it.
	 */
	it("erases cached summaries and the opt-in when the #2104 flag is turned off", () => {
		localStorage.setItem(
			personalCacheConsentStorageKey(USER, "p1"),
			"true",
		);
		writeInsights(USER, "p1", PERSONAL[0].joinUrl, PERSONAL[0].startTime, {
			summary: "Cached summary",
			actionItems: [],
		});

		renderCacheTab(false);

		expect(
			readInsights(
				USER,
				"p1",
				PERSONAL[0].joinUrl,
				PERSONAL[0].startTime,
			),
		).toBeNull();
		expect(
			localStorage.getItem(personalCacheConsentStorageKey(USER, "p1")),
		).toBeNull();
	});

	it("leaves the cache alone while the #2104 flag is on", () => {
		localStorage.setItem(
			personalCacheConsentStorageKey(USER, "p1"),
			"true",
		);
		writeInsights(USER, "p1", PERSONAL[0].joinUrl, PERSONAL[0].startTime, {
			summary: "Cached summary",
			actionItems: [],
		});

		renderCacheTab(true);

		expect(
			readInsights(
				USER,
				"p1",
				PERSONAL[0].joinUrl,
				PERSONAL[0].startTime,
			),
		).not.toBeNull();
	});

	it("purges cached summaries when personal meetings are turned off", () => {
		writeInsights(USER, "p1", PERSONAL[0].joinUrl, PERSONAL[0].startTime, {
			summary: "Cached summary",
			actionItems: [],
		});
		renderCacheTab(true);
		consentToPersonal();

		fireEvent.click(screen.getByText("Turn off"));

		// Cached personal data must never outlive the consent that created it.
		expect(
			readInsights(
				USER,
				"p1",
				PERSONAL[0].joinUrl,
				PERSONAL[0].startTime,
			),
		).toBeNull();
	});

	it("clears the device cache consent key when personal meetings are turned off (#2104)", () => {
		renderCacheTab(true);
		consentToPersonal();
		fireEvent.click(screen.getByText("Remember summaries"));

		// The device-cache opt-in must actually be recorded before this test
		// can prove anything about clearing it.
		expect(
			localStorage.getItem(personalCacheConsentStorageKey(USER, "p1")),
		).toBe("true");

		fireEvent.click(screen.getByText("Turn off"));

		// The consent key, not just the cached data, must never outlive the
		// personal-meetings consent that authorised it.
		expect(
			localStorage.getItem(personalCacheConsentStorageKey(USER, "p1")),
		).toBeNull();
	});

	it("purges cached summaries when the user forgets summaries", () => {
		renderCacheTab(true);
		consentToPersonal();
		fireEvent.click(screen.getByText("Remember summaries"));

		writeInsights(USER, "p1", PERSONAL[0].joinUrl, PERSONAL[0].startTime, {
			summary: "Cached summary",
			actionItems: [],
		});
		fireEvent.click(screen.getByText("Forget summaries"));

		expect(
			readInsights(
				USER,
				"p1",
				PERSONAL[0].joinUrl,
				PERSONAL[0].startTime,
			),
		).toBeNull();
	});
});
