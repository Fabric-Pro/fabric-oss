/**
 * Unit tests for the persistent-error-toast eviction tracker (Fizzy #1668
 * REQ-8 / AC-9). sonner's `visibleToasts` only HIDES overflow — it never
 * evicts — so `duration: Infinity` error toasts would accumulate unbounded.
 * `PersistentErrorToastCap` enforces a hard cap with replace-oldest (FIFO)
 * overflow, reconciling against sonner's live toasts so a slot freed by a
 * user-dismissed toast is reused before the oldest is evicted.
 *
 * The class is pure (no sonner import): it is handed a `listLiveToastIds`
 * reader and a `dismiss` sink, both faked here by a tiny in-memory harness
 * that mirrors how the real patch drives it (makeRoom → create → record).
 */

import { describe, expect, it } from "vitest";
import { PersistentErrorToastCap } from "../toast-error-cap";

/**
 * Mirrors the real choke point: `makeRoom` runs (reconcile + evict) BEFORE the
 * toast is created, then the created id is `record`ed — exactly the order the
 * patched `toast.error` uses.
 */
function makeHarness(cap: number) {
	let live: Array<string | number> = [];
	const dismissed: Array<string | number> = [];

	const tracker = new PersistentErrorToastCap(
		cap,
		() => live,
		(id) => {
			live = live.filter((x) => x !== id);
			dismissed.push(id);
		},
	);

	return {
		tracker,
		/** Show a (possibly repeat-id) persistent error toast. */
		show(id: string | number) {
			tracker.makeRoom(id);
			if (!live.includes(id)) {
				live.push(id); // sonner stores the newly-created toast
			}
			tracker.record(id);
		},
		/** Simulate the user clicking the close (×) button on a toast. */
		userDismiss(id: string | number) {
			live = live.filter((x) => x !== id);
		},
		get dismissed() {
			return dismissed;
		},
		get live() {
			return live;
		},
	};
}

describe("PersistentErrorToastCap", () => {
	it("records up to the cap without evicting anything", () => {
		const h = makeHarness(3);

		h.show("a");
		h.show("b");
		h.show("c");

		expect(h.dismissed).toEqual([]);
		expect(h.tracker.trackedCount).toBe(3);
		expect(h.live).toEqual(["a", "b", "c"]);
	});

	it("evicts the oldest when a new toast exceeds the cap", () => {
		const h = makeHarness(3);

		h.show("a");
		h.show("b");
		h.show("c");
		h.show("d"); // exceeds cap → oldest ("a") replaced

		expect(h.dismissed).toEqual(["a"]);
		expect(h.live).toEqual(["b", "c", "d"]);
		expect(h.tracker.trackedCount).toBe(3);
	});

	it("evicts in FIFO order across multiple overflows", () => {
		const h = makeHarness(3);

		for (const id of ["a", "b", "c", "d", "e"]) {
			h.show(id);
		}

		expect(h.dismissed).toEqual(["a", "b"]);
		expect(h.live).toEqual(["c", "d", "e"]);
	});

	it("treats a repeated same-id toast as a replacement (no new slot)", () => {
		const h = makeHarness(3);

		h.show("a");
		h.show("b");
		h.show("c");
		h.show("a"); // same id → updates in place, must not evict

		expect(h.dismissed).toEqual([]);
		expect(h.tracker.trackedCount).toBe(3);
		expect(h.live).toEqual(["a", "b", "c"]);
	});

	it("reuses a slot freed by a user-dismissed toast before evicting", () => {
		const h = makeHarness(3);

		h.show("a");
		h.show("b");
		h.show("c");
		h.userDismiss("b"); // user closed the middle toast
		h.show("d"); // there is now room → no eviction

		expect(h.dismissed).toEqual([]);
		expect(h.live).toEqual(["a", "c", "d"]);
		expect(h.tracker.trackedCount).toBe(3);
	});
});
