import { render, fireEvent } from "@testing-library/react";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock sonner at the boundary so we can assert exact toast invocations
// without rendering an actual Toaster (the Toaster mounts a portal that
// JSDOM does not lay out reliably). This is the same pattern used by
// `apps/web/__tests__/modules/saas/prompts/PickDefaultForStageDialog.test.tsx`.
vi.mock("sonner", () => ({
	toast: {
		error: vi.fn(),
		success: vi.fn(),
	},
}));

import { toast } from "sonner";
import {
	type AiUsageLimitExceededPayload,
	isAiUsageLimitExceededPayload,
	showAiUsageLimitToast,
	useShowAiUsageLimitToast,
} from "../ai-usage-limit-toast";

const toastError = vi.mocked(toast.error);

/**
 * Stub translator that mirrors the global next-intl mock in
 * `apps/web/vitest.setup.ts`: returns the translation key as the resolved
 * string and stringifies any ICU vars in stable form. Lets the assertions
 * pin both the exact i18n key the helper requested and the substituted
 * vars that key would receive.
 */
function makeTranslator() {
	return vi.fn((key: string, vars?: Record<string, string | number>) => {
		if (vars) {
			const varsStr = Object.entries(vars)
				.map(([k, v]) => `${k}=${v}`)
				.join(",");
			return `${key}(${varsStr})`;
		}
		return key;
	});
}

const PAYLOAD: AiUsageLimitExceededPayload = {
	limitId: "lim_abc123",
	dimension: "SPEND_USD",
	window: "MONTHLY",
	used: "5000000", // micro-USD as wire string
	max: "1000000",
	manageLimitsUrl: "/app/acme/settings/usage?limitId=lim_abc123",
};

/**
 * Helper that pulls the rendered `description` JSX out of the latest
 * `toast.error` call and renders it into JSDOM so we can assert on the
 * resulting DOM. The toast's description is the only place where the
 * action button and reset countdown live, so every UI-shape assertion
 * needs to go through here.
 */
function getRenderedDescription(): HTMLElement {
	const lastCall = toastError.mock.calls.at(-1);
	if (!lastCall) {
		throw new Error("toast.error has not been called");
	}
	const [, opts] = lastCall as [string, { description: ReactNode }];
	const { container } = render(opts.description);
	return container;
}

describe("showAiUsageLimitToast", () => {
	beforeEach(() => {
		toastError.mockReset();
	});

	it("renders a destructive toast with the correct title and i18n keys", () => {
		const t = makeTranslator();

		showAiUsageLimitToast(PAYLOAD, t);

		expect(toastError).toHaveBeenCalledTimes(1);
		const [title, opts] = toastError.mock.calls[0] as [
			string,
			{
				id: string;
				description: ReactNode;
				duration: number;
			},
		];

		expect(title).toBe("settings.aiUsage.limits.toast.blockedTitle");
		expect(opts.duration).toBe(8000);
		expect(opts.id).toBe(`ai-usage-limit-${PAYLOAD.limitId}`);
		expect(t).toHaveBeenCalledWith(
			"settings.aiUsage.limits.toast.blockedTitle",
		);
		expect(t).toHaveBeenCalledWith(
			"settings.aiUsage.limits.toast.blockedAction",
		);
		expect(t).toHaveBeenCalledWith(
			"settings.aiUsage.limits.toast.blockedActionAriaLabel",
		);
		expect(t).toHaveBeenCalledWith(
			"settings.aiUsage.limits.toast.window.monthly",
		);
	});

	it("renders SPEND_USD dimension copy with the {window} substitution", () => {
		const t = makeTranslator();

		showAiUsageLimitToast({ ...PAYLOAD, dimension: "SPEND_USD" }, t);

		const container = getRenderedDescription();
		// `blockedSpend` key with `window` ICU var resolved to the translated
		// `window.{lower}` value (the makeTranslator stub returns the key itself,
		// so we expect the resolved label to be the lowercase window key).
		expect(container.textContent).toContain(
			"settings.aiUsage.limits.toast.blockedSpend(window=settings.aiUsage.limits.toast.window.monthly)",
		);
		expect(t).toHaveBeenCalledWith(
			"settings.aiUsage.limits.toast.blockedSpend",
			{ window: "settings.aiUsage.limits.toast.window.monthly" },
		);
	});

	it("renders TOKENS dimension copy with the matching i18n key", () => {
		const t = makeTranslator();

		showAiUsageLimitToast(
			{ ...PAYLOAD, dimension: "TOKENS", window: "DAILY" },
			t,
		);

		const container = getRenderedDescription();
		expect(container.textContent).toContain(
			"settings.aiUsage.limits.toast.blockedTokens(window=settings.aiUsage.limits.toast.window.daily)",
		);
		expect(t).toHaveBeenCalledWith(
			"settings.aiUsage.limits.toast.blockedTokens",
			{ window: "settings.aiUsage.limits.toast.window.daily" },
		);
	});

	it("HOURLY window resolves to window.hourly", () => {
		const t = makeTranslator();

		showAiUsageLimitToast({ ...PAYLOAD, window: "HOURLY" }, t);

		expect(t).toHaveBeenCalledWith(
			"settings.aiUsage.limits.toast.window.hourly",
		);
	});

	it("renders the Manage-limits link with onClick that navigates to manageLimitsUrl", () => {
		const t = makeTranslator();
		// Stub window.location.assign — JSDOM throws on real navigation
		const assignSpy = vi.fn();
		const originalLocation = window.location;
		Object.defineProperty(window, "location", {
			configurable: true,
			value: { ...originalLocation, assign: assignSpy },
		});

		try {
			showAiUsageLimitToast(PAYLOAD, t);

			const container = getRenderedDescription();
			const button = container.querySelector(
				'button[aria-label="settings.aiUsage.limits.toast.blockedActionAriaLabel"]',
			);
			expect(button).not.toBeNull();
			expect(button?.textContent).toBe(
				"settings.aiUsage.limits.toast.blockedAction",
			);

			fireEvent.click(button as Element);

			expect(assignSpy).toHaveBeenCalledTimes(1);
			expect(assignSpy).toHaveBeenCalledWith(PAYLOAD.manageLimitsUrl);
		} finally {
			Object.defineProperty(window, "location", {
				configurable: true,
				value: originalLocation,
			});
		}
	});

	it("attaches an aria-label to the action button for accessibility", () => {
		const t = makeTranslator();

		showAiUsageLimitToast(PAYLOAD, t);

		const container = getRenderedDescription();
		const button = container.querySelector("button");
		expect(button?.getAttribute("aria-label")).toBe(
			"settings.aiUsage.limits.toast.blockedActionAriaLabel",
		);
	});

	it("does not throw and omits the action when manageLimitsUrl is empty", () => {
		const t = makeTranslator();

		expect(() =>
			showAiUsageLimitToast({ ...PAYLOAD, manageLimitsUrl: "" }, t),
		).not.toThrow();

		expect(toastError).toHaveBeenCalledTimes(1);
		const container = getRenderedDescription();
		// Manage-limits button must be omitted so users don't see a no-op
		// button when the server payload was malformed.
		expect(container.querySelector("button")).toBeNull();
	});

	it("does not throw and omits the action when manageLimitsUrl is whitespace", () => {
		const t = makeTranslator();

		expect(() =>
			showAiUsageLimitToast({ ...PAYLOAD, manageLimitsUrl: "   " }, t),
		).not.toThrow();

		const container = getRenderedDescription();
		expect(container.querySelector("button")).toBeNull();
	});

	it("renders the reset countdown using the {d,h} / {h,m} / {m} ladder", () => {
		// Lock system time to mid-month UTC so the MONTHLY reset boundary (the
		// 1st of next month) is comfortably >= 1 day away and the day+hour
		// ladder fires deterministically. Without this the test is
		// clock-dependent and fails on the LAST day of any month, when the next
		// reset is < 1 day away and the helper (correctly) takes the
		// hours-minutes branch. Mirrors the HOURLY test below.
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-15T12:00:00.000Z"));
		try {
			const t = makeTranslator();

			showAiUsageLimitToast(PAYLOAD, t);

			// We don't assert exact values; we only assert the helper called the
			// correct format key with the expected var shape.
			const callsForDaysHours = t.mock.calls.filter(
				([key]) =>
					key === "settings.aiUsage.limits.toast.resetsInDaysHours",
			);
			expect(callsForDaysHours.length).toBeGreaterThan(0);
			const callVars = callsForDaysHours[0][1] as Record<string, number>;
			expect(typeof callVars.d).toBe("number");
			expect(typeof callVars.h).toBe("number");
			expect(callVars.d).toBeGreaterThanOrEqual(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("HOURLY window resolves to the hours-minutes ladder for the reset countdown", () => {
		// Lock system time to a known UTC instant so the countdown branch
		// is deterministic. Without this the test is clock-dependent: in
		// the last 59 seconds of any hour the helper takes the
		// `resetsShortly` branch (totalMinutes < 1) and neither asserted
		// key fires. 12:00:00 UTC keeps the test inside the expected
		// hours-minutes / minutes-only ladder branches.
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
		try {
			const t = makeTranslator();

			showAiUsageLimitToast({ ...PAYLOAD, window: "HOURLY" }, t);

			// Next top of hour is < 1 hour away. Could be either minutes-only
			// (< 1h, common case) or hours-minutes (exactly at the boundary,
			// trivially small window). Both are acceptable.
			const minutesOnly = t.mock.calls.filter(
				([key]) =>
					key === "settings.aiUsage.limits.toast.resetsInMinutes",
			);
			const hoursMinutes = t.mock.calls.filter(
				([key]) =>
					key ===
					"settings.aiUsage.limits.toast.resetsInHoursMinutes",
			);
			expect(minutesOnly.length + hoursMinutes.length).toBeGreaterThan(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("dedupes per limit via toast id", () => {
		const t = makeTranslator();

		showAiUsageLimitToast(PAYLOAD, t);
		showAiUsageLimitToast(PAYLOAD, t);

		expect(toastError).toHaveBeenCalledTimes(2);
		// Both invocations carry the same id so sonner collapses them
		// into a single visible toast at runtime.
		const [, firstOpts] = toastError.mock.calls[0] as [
			string,
			{ id: string },
		];
		const [, secondOpts] = toastError.mock.calls[1] as [
			string,
			{ id: string },
		];
		expect(firstOpts.id).toBe(`ai-usage-limit-${PAYLOAD.limitId}`);
		expect(secondOpts.id).toBe(`ai-usage-limit-${PAYLOAD.limitId}`);
	});

	it("accepts BigInt used/max without throwing", () => {
		const t = makeTranslator();

		expect(() =>
			showAiUsageLimitToast(
				{ ...PAYLOAD, used: 5000000n, max: 1000000n },
				t,
			),
		).not.toThrow();
		expect(toastError).toHaveBeenCalledTimes(1);
	});
});

describe("isAiUsageLimitExceededPayload", () => {
	it("returns true for a well-formed payload", () => {
		expect(isAiUsageLimitExceededPayload(PAYLOAD)).toBe(true);
	});

	it("returns true when used/max are bigints", () => {
		expect(
			isAiUsageLimitExceededPayload({
				...PAYLOAD,
				used: 5000000n,
				max: 1000000n,
			}),
		).toBe(true);
	});

	it("returns false for null / non-objects", () => {
		expect(isAiUsageLimitExceededPayload(null)).toBe(false);
		expect(isAiUsageLimitExceededPayload(undefined)).toBe(false);
		expect(isAiUsageLimitExceededPayload("string")).toBe(false);
		expect(isAiUsageLimitExceededPayload(42)).toBe(false);
	});

	it("returns false when dimension is invalid", () => {
		expect(
			isAiUsageLimitExceededPayload({ ...PAYLOAD, dimension: "INVALID" }),
		).toBe(false);
	});

	it("returns false when window is invalid", () => {
		expect(
			isAiUsageLimitExceededPayload({ ...PAYLOAD, window: "YEARLY" }),
		).toBe(false);
	});

	it("accepts WEEKLY as a valid window", () => {
		expect(
			isAiUsageLimitExceededPayload({ ...PAYLOAD, window: "WEEKLY" }),
		).toBe(true);
	});

	it("returns false when manageLimitsUrl is missing", () => {
		const partial: Record<string, unknown> = { ...PAYLOAD };
		delete partial.manageLimitsUrl;
		expect(isAiUsageLimitExceededPayload(partial)).toBe(false);
	});

	it("returns false when limitId is missing", () => {
		const partial: Record<string, unknown> = { ...PAYLOAD };
		delete partial.limitId;
		expect(isAiUsageLimitExceededPayload(partial)).toBe(false);
	});

	it("returns false when used/max are wrong types", () => {
		expect(
			isAiUsageLimitExceededPayload({ ...PAYLOAD, used: 5_000_000 }),
		).toBe(false);
	});
});

describe("useShowAiUsageLimitToast", () => {
	beforeEach(() => {
		toastError.mockReset();
	});

	it("returns a callback that fires the toast with the bound translator", () => {
		const { result } = renderHook(() => useShowAiUsageLimitToast());

		result.current(PAYLOAD);

		expect(toastError).toHaveBeenCalledTimes(1);
		const [title, opts] = toastError.mock.calls[0] as [
			string,
			{ id: string; description: ReactNode; duration: number },
		];
		// The global next-intl mock returns keys verbatim, so this asserts
		// the helper actually called the bound `t` (not just rendered keys).
		expect(title).toBe("settings.aiUsage.limits.toast.blockedTitle");
		expect(opts.id).toBe(`ai-usage-limit-${PAYLOAD.limitId}`);
		expect(opts.duration).toBe(8000);
	});
});
