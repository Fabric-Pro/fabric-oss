import { describe, expect, it, vi } from "vitest";

// The module reaches the oRPC client only through `use-test-cases-view`; the
// pure capture helper under test never touches it.
vi.mock("@shared/lib/orpc-query-utils", () => ({ orpc: {} }));

import { captureView, SAVED_VIEW_LIMIT } from "../use-saved-views";

describe("captureView", () => {
	it("keeps the params the view owns", () => {
		expect(captureView("?q=login&state=READY&page=3")).toBe(
			"q=login&state=READY&page=3",
		);
	});

	/**
	 * The trap this helper exists for. `?case=<id>` deep-links one case's editor
	 * OPEN — a saved view called "Failing, critical" that also reopens someone's
	 * half-read case every time it is applied is a trap, not a shortcut.
	 */
	it("drops the deep-link that opens a case editor", () => {
		expect(captureView("?q=login&case=tc_123")).toBe("q=login");
	});

	/**
	 * Whitelisted, not blacklisted: a param some other feature adds next month
	 * must not silently become part of everybody's saved views.
	 */
	it("drops params it does not recognise", () => {
		expect(
			captureView("?state=READY&somethingNew=1&utm_source=email"),
		).toBe("state=READY");
	});

	it("is empty for an unfiltered view", () => {
		expect(captureView("")).toBe("");
		expect(captureView("?case=tc_1")).toBe("");
	});

	/**
	 * Two readers arriving at the same view by different routes must produce the
	 * same string, or "is this the view I saved?" compares unequal and the menu
	 * never highlights the active one.
	 */
	it("normalises param order so identical views compare equal", () => {
		expect(captureView("?state=READY&q=login")).toBe(
			captureView("?q=login&state=READY"),
		);
	});

	it("drops empty values rather than saving q= with nothing after it", () => {
		expect(captureView("?q=&state=READY")).toBe("state=READY");
	});

	it("caps the stored list at a number a menu can still show", () => {
		expect(SAVED_VIEW_LIMIT).toBeGreaterThan(0);
		expect(SAVED_VIEW_LIMIT).toBeLessThanOrEqual(20);
	});
});
