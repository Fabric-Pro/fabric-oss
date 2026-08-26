import {
	act,
	fireEvent,
	render,
	renderHook,
	screen,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readInsights, writeInsights } from "../../lib/personal-insights-cache";
import {
	PersonalMeetingsConsent,
	personalCacheConsentStorageKey,
	personalConsentStorageKey,
	usePersonalInsightsCacheConsent,
} from "../PersonalMeetingsConsent";

describe("personalConsentStorageKey", () => {
	it("scopes the key to the project", () => {
		expect(personalConsentStorageKey("p1")).toBe(
			"meeting-digest-personal:p1",
		);
	});
});

describe("PersonalMeetingsConsent", () => {
	beforeEach(() => {
		sessionStorage.clear();
		vi.clearAllMocks();
	});

	it("states all three privacy disclosures before consent (FR3)", () => {
		render(
			<PersonalMeetingsConsent
				consented={false}
				onEnable={vi.fn()}
				onDisable={vi.fn()}
			/>,
		);

		const text = screen.getByRole("region", {
			name: /personal meetings/i,
		}).textContent;

		// FR3a: not stored in the database
		expect(text).toMatch(/never stored/i);
		// FR3b: fetched on demand
		expect(text).toMatch(/fetched from your Microsoft calendar/i);
		// FR3c: not visible to other team members
		expect(text).toMatch(/only you can see them/i);
	});

	it("associates the disclosure with the enable button for screen readers", () => {
		render(
			<PersonalMeetingsConsent
				consented={false}
				onEnable={vi.fn()}
				onDisable={vi.fn()}
			/>,
		);

		const button = screen.getByRole("button", {
			name: /enable personal meetings/i,
		});
		const describedBy = button.getAttribute("aria-describedby");
		expect(describedBy).toBeTruthy();
		expect(document.getElementById(describedBy as string)).toBeTruthy();
	});

	it("calls onEnable when the user opts in", () => {
		const onEnable = vi.fn();
		render(
			<PersonalMeetingsConsent
				consented={false}
				onEnable={onEnable}
				onDisable={vi.fn()}
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", { name: /enable personal meetings/i }),
		);
		expect(onEnable).toHaveBeenCalledTimes(1);
	});

	it("collapses to a reminder with a turn-off control once consented (FR6)", () => {
		const onDisable = vi.fn();
		render(
			<PersonalMeetingsConsent
				consented={true}
				onEnable={vi.fn()}
				onDisable={onDisable}
			/>,
		);

		expect(
			screen.queryByRole("button", {
				name: /enable personal meetings/i,
			}),
		).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: /turn off/i }));
		expect(onDisable).toHaveBeenCalledTimes(1);
	});
});

describe("usePersonalInsightsCacheConsent (#2104)", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it("defaults to off", () => {
		const { result } = renderHook(() =>
			usePersonalInsightsCacheConsent("u1", "p1"),
		);
		expect(result.current.cacheEnabled).toBe(false);
	});

	it("persists the opt-in across hook instances", () => {
		const { result } = renderHook(() =>
			usePersonalInsightsCacheConsent("u1", "p1"),
		);
		act(() => result.current.enableCache());

		const second = renderHook(() =>
			usePersonalInsightsCacheConsent("u1", "p1"),
		);
		expect(second.result.current.cacheEnabled).toBe(true);
	});

	it("scopes the preference per user", () => {
		const { result } = renderHook(() =>
			usePersonalInsightsCacheConsent("u1", "p1"),
		);
		act(() => result.current.enableCache());

		const other = renderHook(() =>
			usePersonalInsightsCacheConsent("u2", "p1"),
		);
		expect(other.result.current.cacheEnabled).toBe(false);
	});

	it("purges cached insights when turned off", () => {
		writeInsights(
			"u1",
			"p1",
			"https://join/x",
			"2026-08-01T10:00:00.000Z",
			{
				summary: "s",
				actionItems: [],
			},
		);
		const { result } = renderHook(() =>
			usePersonalInsightsCacheConsent("u1", "p1"),
		);
		act(() => result.current.enableCache());
		act(() => result.current.disableCache());

		expect(
			readInsights(
				"u1",
				"p1",
				"https://join/x",
				"2026-08-01T10:00:00.000Z",
			),
		).toBeNull();
		expect(
			localStorage.getItem(personalCacheConsentStorageKey("u1", "p1")),
		).toBeNull();
	});

	// The data half is covered above. This is the consent half: disableCache
	// must remove the KEY as well, or a caller that erases data without
	// erasing consent leaves caching to resume on its own.
	it("clears the consent key when turned off, so re-enabling needs a fresh click", () => {
		const { result } = renderHook(() =>
			usePersonalInsightsCacheConsent("u1", "p1"),
		);

		act(() => result.current.enableCache());
		expect(
			localStorage.getItem(personalCacheConsentStorageKey("u1", "p1")),
		).toBe("true");

		act(() => result.current.disableCache());
		expect(result.current.cacheEnabled).toBe(false);
		expect(
			localStorage.getItem(personalCacheConsentStorageKey("u1", "p1")),
		).toBeNull();
	});
});

describe("PersonalMeetingsConsent cache toggle (#2104)", () => {
	it("hides the toggle when the flag is off", () => {
		render(
			<PersonalMeetingsConsent
				consented={true}
				onEnable={() => {}}
				onDisable={() => {}}
				showCacheToggle={false}
			/>,
		);
		expect(
			screen.queryByRole("button", { name: /remember summaries/i }),
		).toBeNull();
	});

	it("offers to remember summaries when caching is off", () => {
		render(
			<PersonalMeetingsConsent
				consented={true}
				onEnable={() => {}}
				onDisable={() => {}}
				showCacheToggle={true}
				cacheEnabled={false}
			/>,
		);
		expect(
			screen.getByRole("button", { name: /remember summaries/i }),
		).toBeTruthy();
	});

	it("offers to forget summaries when caching is on", () => {
		render(
			<PersonalMeetingsConsent
				consented={true}
				onEnable={() => {}}
				onDisable={() => {}}
				showCacheToggle={true}
				cacheEnabled={true}
			/>,
		);
		expect(
			screen.getByRole("button", { name: /forget summaries/i }),
		).toBeTruthy();
	});

	it("no longer claims personal meetings are never stored outright", () => {
		render(
			<PersonalMeetingsConsent
				consented={true}
				onEnable={() => {}}
				onDisable={() => {}}
			/>,
		);
		// The absolute claim now applies to transcripts only, because summaries
		// can be cached on device.
		expect(
			screen.queryByText(/visible only to you and are never stored/i),
		).toBeNull();
		expect(screen.getByText(/transcripts are never stored/i)).toBeTruthy();
	});
});
