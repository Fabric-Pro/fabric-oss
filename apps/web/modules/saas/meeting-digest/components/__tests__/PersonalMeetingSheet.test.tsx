import {
	focusManager,
	QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getPersonalTranscript, getPersonalInsights } = vi.hoisted(() => ({
	getPersonalTranscript: vi.fn(),
	getPersonalInsights: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			meetingDigest: { getPersonalTranscript, getPersonalInsights },
		},
	},
}));

import {
	entryId,
	readInsights,
	storageKey,
	writeInsights,
} from "../../lib/personal-insights-cache";
import { PersonalMeetingSheet } from "../PersonalMeetingSheet";

const MEETING = {
	id: "evt1",
	subject: "1:1 with Sam",
	startTime: "2026-07-14T09:00:00Z",
	organizer: "Sam Rivers",
	joinUrl: "https://teams.microsoft.com/l/meetup-join/AAA",
	linkedWithoutTranscript: false,
};

/** Linked project meeting with no synced transcript — shared, not private. */
const UNSYNCED_TEAM_MEETING = {
	...MEETING,
	id: "evt2",
	subject: "Fabric DSU",
	linkedWithoutTranscript: true,
};

function renderSheet(meeting = MEETING) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	return render(
		<PersonalMeetingSheet
			projectId="p1"
			organizationId={null}
			meeting={meeting}
			onClose={vi.fn()}
		/>,
		{ wrapper },
	);
}

describe("PersonalMeetingSheet", () => {
	beforeEach(() => vi.clearAllMocks());

	it("shows meeting metadata without fetching the transcript", () => {
		renderSheet();

		expect(screen.getByText("1:1 with Sam")).toBeTruthy();
		expect(screen.getByText(/Sam Rivers/)).toBeTruthy();
		// The transcript must not be fetched until explicitly requested — an
		// automatic fetch would pull private content on mere navigation.
		expect(getPersonalTranscript).not.toHaveBeenCalled();
	});

	it("offers no ticket-creation or insight affordances", () => {
		renderSheet();

		expect(screen.queryByText(/create ticket/i)).toBeNull();
		expect(screen.queryByText(/action items/i)).toBeNull();
		expect(screen.queryByText(/decisions/i)).toBeNull();
	});

	it("tells the user a personal meeting is private to them", () => {
		renderSheet();

		expect(screen.getByText(/visible only to you/i)).toBeTruthy();
	});

	// DEF-1. Radix defaults aria-describedby to an ID it only renders if a
	// Description exists; without one the dialog points at nothing and screen
	// readers announce no description. Assert the reference RESOLVES rather than
	// that the element exists — a description that nothing points at is the same
	// bug wearing a disguise.
	it("gives the dialog a description its aria-describedby resolves to", () => {
		renderSheet();

		const dialog = screen.getByRole("dialog");
		const describedBy = dialog.getAttribute("aria-describedby");

		expect(describedBy).toBeTruthy();
		expect(document.getElementById(describedBy as string)).toBeTruthy();
	});

	// DEF-0. The same sheet opens for a linked project meeting that has no
	// synced transcript. Repeating "visible only to you" there would tell the
	// user a meeting shared with their whole team is private.
	it("does not claim privacy for an unsynced project meeting", () => {
		renderSheet(UNSYNCED_TEAM_MEETING);

		expect(screen.queryByText(/visible only to you/i)).toBeNull();
		expect(screen.getByText(/shared with the project/i)).toBeTruthy();
	});

	it("fetches and renders the transcript on request", async () => {
		getPersonalTranscript.mockResolvedValue({
			content: "Ann: Morning.\nBob: Morning!",
		});

		renderSheet();
		fireEvent.click(
			screen.getByRole("button", { name: /load transcript/i }),
		);

		await waitFor(() =>
			expect(screen.getByText("Ann: Morning.")).toBeTruthy(),
		);
		expect(getPersonalTranscript).toHaveBeenCalledWith({
			projectId: "p1",
			organizationId: null,
			joinUrl: MEETING.joinUrl,
			startTime: MEETING.startTime,
		});
	});

	it("explains a missing transcript rather than showing an error", async () => {
		getPersonalTranscript.mockResolvedValue({
			content: null,
			reason: "no-transcript",
		});

		renderSheet();
		fireEvent.click(
			screen.getByRole("button", { name: /load transcript/i }),
		);

		await waitFor(() =>
			expect(
				screen.getByText(/no transcript is available/i),
			).toBeTruthy(),
		);
	});

	// DEF-6. Graph refuses the lookup for meetings a colleague organised. Before
	// the fix this threw a 500 and the sheet fell through to TranscriptBody's
	// generic error state, which reads as "something broke" for a situation that
	// is neither broken nor the user's fault.
	it("explains a meeting it cannot look up instead of showing a failure", async () => {
		getPersonalTranscript.mockResolvedValue({
			content: null,
			reason: "no-access",
		});

		renderSheet(UNSYNCED_TEAM_MEETING);
		fireEvent.click(
			screen.getByRole("button", { name: /load transcript/i }),
		);

		await waitFor(() =>
			expect(screen.getByText(/organiser|organizer/i)).toBeTruthy(),
		);
		expect(screen.queryByText(/failed/i)).toBeNull();
	});

	it("directs the user to their IT admin when consent is missing", async () => {
		getPersonalTranscript.mockResolvedValue({
			content: null,
			reason: "admin-consent-required",
		});

		renderSheet();
		fireEvent.click(
			screen.getByRole("button", { name: /load transcript/i }),
		);

		await waitFor(() => expect(screen.getByText(/IT admin/i)).toBeTruthy());
	});

	// #2553. The Teams tenant setting and a missing app permission both arrive as
	// a 403 with a helpUrl, but they are fixed in different admin surfaces — so
	// this must name the Teams admin center, not repeat the consent copy.
	it("names the Teams admin setting when the tenant has transcript access off", async () => {
		getPersonalTranscript.mockResolvedValue({
			content: null,
			reason: "transcript-access-disabled",
		});

		renderSheet();
		fireEvent.click(
			screen.getByRole("button", { name: /load transcript/i }),
		);

		await waitFor(() =>
			expect(screen.getByText(/Teams admin center/i)).toBeTruthy(),
		);
		expect(screen.queryByText(/failed/i)).toBeNull();
	});
});

describe("PersonalMeetingSheet — ephemeral insights", () => {
	beforeEach(() => vi.clearAllMocks());

	it("does not summarise until the user asks", () => {
		renderSheet();

		expect(getPersonalInsights).not.toHaveBeenCalled();
		expect(screen.getByText("Summarise meeting")).toBeTruthy();
	});

	it("shows the summary and action items once generated", async () => {
		getPersonalInsights.mockResolvedValue({
			summary: "- Agreed to ship Friday",
			actionItems: [
				{ text: "Cut the release branch", tentativeOwnerName: "Erin" },
			],
		});

		renderSheet();
		fireEvent.click(screen.getByText("Summarise meeting"));

		await waitFor(() =>
			expect(screen.getByText(/Agreed to ship Friday/)).toBeTruthy(),
		);
		expect(screen.getByText(/Cut the release branch/)).toBeTruthy();
		expect(screen.getByText(/Erin/)).toBeTruthy();
	});

	// The privacy promise is the reason insights are ephemeral; the UI has to
	// say so, or a user will reasonably expect them to still be here tomorrow.
	it("states that the summary is not saved", async () => {
		getPersonalInsights.mockResolvedValue({
			summary: "- Something",
			actionItems: [],
		});

		renderSheet();
		fireEvent.click(screen.getByText("Summarise meeting"));

		await waitFor(() =>
			expect(screen.getByText(/isn't saved|not saved/i)).toBeTruthy(),
		);
	});

	it("explains when there is no transcript to summarise", async () => {
		getPersonalInsights.mockResolvedValue({
			summary: null,
			actionItems: [],
			reason: "no-transcript",
		});

		renderSheet();
		fireEvent.click(screen.getByText("Summarise meeting"));

		await waitFor(() =>
			expect(screen.getByText(/no transcript/i)).toBeTruthy(),
		);
	});

	/**
	 * A transcript that exists but says nothing is not the same state as no
	 * transcript at all, and neither is an error. Staging QA of #2104 hit this
	 * as a bare "Couldn't summarise this meeting. Try again." on a meeting
	 * whose whole transcript was nine lines of greetings — advice that could
	 * never work, since trying again re-runs the same impossible request.
	 */
	it("explains when the transcript holds nothing worth summarising", async () => {
		getPersonalInsights.mockResolvedValue({
			summary: null,
			actionItems: [],
			reason: "insufficient-content",
		});

		renderSheet();
		fireEvent.click(screen.getByText("Summarise meeting"));

		await waitFor(() =>
			expect(screen.getByText(/wasn't enough/i)).toBeTruthy(),
		);
		expect(screen.queryByText(/Try again/i)).toBeNull();
		expect(
			screen.queryByText(/no transcript for this meeting/i),
		).toBeNull();
	});

	it("tells the user to ask their IT admin when consent is missing", async () => {
		getPersonalInsights.mockResolvedValue({
			summary: null,
			actionItems: [],
			reason: "admin-consent-required",
		});

		renderSheet();
		fireEvent.click(screen.getByText("Summarise meeting"));

		await waitFor(() => expect(screen.getByText(/IT admin/i)).toBeTruthy());
	});

	it("names the Teams admin setting when the tenant has transcript access off", async () => {
		getPersonalInsights.mockResolvedValue({
			summary: null,
			actionItems: [],
			reason: "transcript-access-disabled",
		});

		renderSheet();
		fireEvent.click(screen.getByText("Summarise meeting"));

		await waitFor(() =>
			expect(screen.getByText(/Teams admin center/i)).toBeTruthy(),
		);
	});
});

describe("PersonalMeetingSheet — insight state does not leak between meetings", () => {
	beforeEach(() => vi.clearAllMocks());

	/**
	 * Found in live QA on staging: summarising meeting A and then opening
	 * meeting B showed B already summarised, with no "Summarise meeting"
	 * button — the sheet had auto-fetched B's transcript on mere navigation.
	 *
	 * That is the precise thing this component's header forbids: private
	 * content must never be pulled into the page without an explicit ask.
	 */
	it("asks again on a different meeting instead of auto-summarising it", async () => {
		getPersonalInsights.mockResolvedValue({
			summary: "- Something from meeting A",
			actionItems: [],
		});

		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={client}>
				{children}
			</QueryClientProvider>
		);
		const props = {
			projectId: "p1",
			organizationId: null,
			onClose: vi.fn(),
		};

		const { rerender } = render(
			<PersonalMeetingSheet {...props} meeting={MEETING} />,
			{ wrapper },
		);

		fireEvent.click(screen.getByText("Summarise meeting"));
		await waitFor(() =>
			expect(screen.getByText(/Something from meeting A/)).toBeTruthy(),
		);
		expect(getPersonalInsights).toHaveBeenCalledTimes(1);

		const OTHER = {
			...MEETING,
			id: "evt-other",
			subject: "1:1 with Dana",
			joinUrl: "https://teams.microsoft.com/l/meetup-join/BBB",
		};
		// Mirrors the real flow: the parent nulls `meeting` on close, then sets
		// the next one. The component stays mounted throughout, which is exactly
		// how the state survived into the next meeting on staging.
		rerender(<PersonalMeetingSheet {...props} meeting={null} />);
		rerender(<PersonalMeetingSheet {...props} meeting={OTHER} />);

		// The button is back, and nothing was fetched for the new meeting.
		expect(screen.getByText("Summarise meeting")).toBeTruthy();
		expect(getPersonalInsights).toHaveBeenCalledTimes(1);
	});

	it("also re-asks before loading a different meeting's transcript", async () => {
		getPersonalTranscript.mockResolvedValue({ content: "A: hello" });

		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={client}>
				{children}
			</QueryClientProvider>
		);
		const props = {
			projectId: "p1",
			organizationId: null,
			onClose: vi.fn(),
		};

		const { rerender } = render(
			<PersonalMeetingSheet {...props} meeting={MEETING} />,
			{ wrapper },
		);

		fireEvent.click(screen.getByText("Load transcript"));
		await waitFor(() =>
			expect(getPersonalTranscript).toHaveBeenCalledTimes(1),
		);

		const OTHER = {
			...MEETING,
			id: "evt-other",
			joinUrl: "https://teams.microsoft.com/l/meetup-join/BBB",
		};
		rerender(<PersonalMeetingSheet {...props} meeting={null} />);
		rerender(<PersonalMeetingSheet {...props} meeting={OTHER} />);

		expect(screen.getByText("Load transcript")).toBeTruthy();
		expect(getPersonalTranscript).toHaveBeenCalledTimes(1);
	});
});

describe("insights caching (#2104)", () => {
	const USER = "u1";

	function renderCaching(cacheEnabled: boolean, meeting = MEETING) {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={client}>
				{children}
			</QueryClientProvider>
		);
		return render(
			<PersonalMeetingSheet
				projectId="p1"
				organizationId={null}
				meeting={meeting}
				onClose={vi.fn()}
				userId={USER}
				cacheEnabled={cacheEnabled}
			/>,
			{ wrapper },
		);
	}

	beforeEach(() => {
		vi.clearAllMocks();
		localStorage.clear();
	});

	it("writes nothing to storage when caching is off", async () => {
		getPersonalInsights.mockResolvedValue({
			summary: "We agreed to ship on Friday.",
			actionItems: [],
		});
		renderCaching(false);
		fireEvent.click(screen.getByText("Summarise meeting"));

		await screen.findByText(/We agreed to ship on Friday/);
		expect(
			readInsights(USER, "p1", MEETING.joinUrl, MEETING.startTime),
		).toBeNull();
	});

	it("keeps the not-saved disclosure when caching is off", async () => {
		getPersonalInsights.mockResolvedValue({
			summary: "We agreed to ship on Friday.",
			actionItems: [],
		});
		renderCaching(false);
		fireEvent.click(screen.getByText("Summarise meeting"));

		await screen.findByText(/We agreed to ship on Friday/);
		expect(screen.getByText(/isn't saved/i)).toBeTruthy();
	});

	it("stores the summary on device when caching is on", async () => {
		getPersonalInsights.mockResolvedValue({
			summary: "We agreed to ship on Friday.",
			actionItems: [{ text: "Send the deck" }],
		});
		renderCaching(true);
		fireEvent.click(screen.getByText("Summarise meeting"));

		await screen.findByText(/We agreed to ship on Friday/);
		await waitFor(() =>
			expect(
				readInsights(USER, "p1", MEETING.joinUrl, MEETING.startTime)
					?.summary,
			).toMatch(/We agreed to ship on Friday/),
		);
	});

	it("tells the user the summary is saved when caching is on", async () => {
		getPersonalInsights.mockResolvedValue({
			summary: "We agreed to ship on Friday.",
			actionItems: [],
		});
		renderCaching(true);
		fireEvent.click(screen.getByText("Summarise meeting"));

		await screen.findByText(/We agreed to ship on Friday/);
		expect(screen.getByText(/saved in this browser/i)).toBeTruthy();
		expect(screen.queryByText(/isn't saved/i)).toBeNull();
	});

	it("serves a cached summary without calling the API", async () => {
		writeInsights(USER, "p1", MEETING.joinUrl, MEETING.startTime, {
			summary: "Cached summary",
			actionItems: [],
		});
		renderCaching(true);
		fireEvent.click(screen.getByText("Summarise meeting"));

		expect(await screen.findByText("Cached summary")).toBeTruthy();
		expect(getPersonalInsights).not.toHaveBeenCalled();
	});

	it("still requires an explicit click even when a summary is cached", () => {
		writeInsights(USER, "p1", MEETING.joinUrl, MEETING.startTime, {
			summary: "Cached summary",
			actionItems: [],
		});
		renderCaching(true);

		// A cache hit removes the wait, never the click. Auto-rendering private
		// content on mere navigation is the exact failure this guards.
		expect(screen.queryByText("Cached summary")).toBeNull();
	});

	it("does not cache a no-transcript reason response", async () => {
		getPersonalInsights.mockResolvedValue({
			summary: null,
			actionItems: [],
			reason: "no-transcript",
		});
		renderCaching(true);
		fireEvent.click(screen.getByText("Summarise meeting"));

		await screen.findByText(/no transcript for this meeting/i);
		expect(
			readInsights(USER, "p1", MEETING.joinUrl, MEETING.startTime),
		).toBeNull();
	});

	it("does not cache an insufficient-content reason response", async () => {
		getPersonalInsights.mockResolvedValue({
			summary: null,
			actionItems: [],
			reason: "insufficient-content",
		});
		renderCaching(true);
		fireEvent.click(screen.getByText("Summarise meeting"));

		await screen.findByText(/wasn't enough/i);
		expect(
			readInsights(USER, "p1", MEETING.joinUrl, MEETING.startTime),
		).toBeNull();
	});

	it("does not write a shared meeting's summary to the device", async () => {
		getPersonalInsights.mockResolvedValue({
			summary: "We agreed to ship on Friday.",
			actionItems: [],
		});
		renderCaching(true, UNSYNCED_TEAM_MEETING);
		fireEvent.click(screen.getByText("Summarise meeting"));

		await screen.findByText(/We agreed to ship on Friday/);
		expect(
			readInsights(
				USER,
				"p1",
				UNSYNCED_TEAM_MEETING.joinUrl,
				UNSYNCED_TEAM_MEETING.startTime,
			),
		).toBeNull();
	});

	// Guarding only the write would leave entries written BEFORE this change
	// being served for the rest of the 7-day TTL.
	it("does not serve a pre-existing entry for a meeting that is now shared", async () => {
		writeInsights(
			USER,
			"p1",
			UNSYNCED_TEAM_MEETING.joinUrl,
			UNSYNCED_TEAM_MEETING.startTime,
			{ summary: "stale device copy", actionItems: [] },
		);
		getPersonalInsights.mockResolvedValue({
			summary: "freshly generated summary.",
			actionItems: [],
		});

		renderCaching(true, UNSYNCED_TEAM_MEETING);
		fireEvent.click(screen.getByText("Summarise meeting"));

		await screen.findByText(/freshly generated summary/);
		expect(screen.queryByText("stale device copy")).toBeNull();
	});

	// The disclosure is load-bearing: guard the write but leave this, and the
	// panel promises a save that no longer happens.
	it("does not claim a shared meeting's summary was saved to the browser", async () => {
		getPersonalInsights.mockResolvedValue({
			summary: "We agreed to ship on Friday.",
			actionItems: [],
		});
		renderCaching(true, UNSYNCED_TEAM_MEETING);
		fireEvent.click(screen.getByText("Summarise meeting"));

		await screen.findByText(/We agreed to ship on Friday/);
		expect(screen.queryByText(/saved in this browser/i)).toBeNull();
		expect(screen.getByText(/isn't saved/i)).toBeTruthy();
	});

	// Guarding only the read leaves a pre-existing entry outliving its TTL: no
	// site ever calls `readInsights` for a shared meeting again, so the TTL
	// check embedded in it never runs — the entry would sit on disk until the
	// LRU cap evicts it or the user purges. "Not served" is not "gone", so
	// assert on the actual storage, not on what renders.
	it("removes a pre-existing entry from storage once its meeting is shared", async () => {
		writeInsights(
			USER,
			"p1",
			UNSYNCED_TEAM_MEETING.joinUrl,
			UNSYNCED_TEAM_MEETING.startTime,
			{ summary: "stale device copy", actionItems: [] },
		);
		const key = storageKey(USER, "p1");
		const id = entryId(
			UNSYNCED_TEAM_MEETING.joinUrl,
			UNSYNCED_TEAM_MEETING.startTime,
		);
		const before = JSON.parse(localStorage.getItem(key) as string);
		expect(before.entries[id]).toBeDefined();

		renderCaching(true, UNSYNCED_TEAM_MEETING);

		await waitFor(() => {
			const raw = localStorage.getItem(key);
			const after = raw ? JSON.parse(raw) : { entries: {} };
			expect(after.entries[id]).toBeUndefined();
		});
	});

	// The sibling case, so the eager drop cannot be "fixed" by clearing the
	// whole blob: only the one entry for the now-shared meeting goes.
	it("leaves a sibling personal entry in the same blob untouched", async () => {
		// UNSYNCED_TEAM_MEETING otherwise shares MEETING's joinUrl/startTime,
		// so the sibling needs a distinct one or the two writes collide into
		// a single entry.
		const OTHER_JOIN_URL = "https://teams.microsoft.com/l/meetup-join/CCC";
		writeInsights(
			USER,
			"p1",
			UNSYNCED_TEAM_MEETING.joinUrl,
			UNSYNCED_TEAM_MEETING.startTime,
			{ summary: "stale device copy", actionItems: [] },
		);
		writeInsights(USER, "p1", OTHER_JOIN_URL, MEETING.startTime, {
			summary: "still mine",
			actionItems: [],
		});
		const key = storageKey(USER, "p1");
		const sharedId = entryId(
			UNSYNCED_TEAM_MEETING.joinUrl,
			UNSYNCED_TEAM_MEETING.startTime,
		);
		const personalId = entryId(OTHER_JOIN_URL, MEETING.startTime);

		renderCaching(true, UNSYNCED_TEAM_MEETING);

		await waitFor(() => {
			const after = JSON.parse(localStorage.getItem(key) as string);
			expect(after.entries[sharedId]).toBeUndefined();
		});
		const after = JSON.parse(localStorage.getItem(key) as string);
		expect(after.entries[personalId]).toBeDefined();
	});

	// The counterpart, so the guard cannot be "fixed" by disabling caching
	// wholesale: a genuinely personal meeting must still be cached.
	it("still writes a genuinely personal meeting's summary", async () => {
		getPersonalInsights.mockResolvedValue({
			summary: "We agreed to ship on Friday.",
			actionItems: [],
		});
		renderCaching(true, MEETING);
		fireEvent.click(screen.getByText("Summarise meeting"));

		await screen.findByText(/We agreed to ship on Friday/);
		expect(
			readInsights(USER, "p1", MEETING.joinUrl, MEETING.startTime),
		).not.toBeNull();
	});

	// Nothing in this app overrides TanStack's `refetchOnWindowFocus` default
	// of true. A shared meeting is excluded from the cache entirely
	// (`cacheActive` false), so before this fix it ran at `staleTime: 0` —
	// every alt-tab back into the tab re-ran `getPersonalInsights`: a fresh
	// Graph transcript fetch plus a fresh LLM summarise, changing the
	// displayed summary under the user while the sheet stayed open.
	it("does not re-summarise a shared meeting when the window regains focus", async () => {
		getPersonalInsights.mockResolvedValue({
			summary: "We agreed to ship on Friday.",
			actionItems: [],
		});
		renderCaching(true, UNSYNCED_TEAM_MEETING);
		fireEvent.click(screen.getByText("Summarise meeting"));

		await screen.findByText(/We agreed to ship on Friday/);
		expect(getPersonalInsights).toHaveBeenCalledTimes(1);

		// Simulate losing and regaining window focus without the sheet
		// closing — the alt-tab-and-back scenario.
		act(() => {
			focusManager.setFocused(false);
		});
		act(() => {
			focusManager.setFocused(true);
		});
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(getPersonalInsights).toHaveBeenCalledTimes(1);
	});
});
