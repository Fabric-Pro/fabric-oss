/**
 * The Edit with instructions panels' store (Fizzy #2946).
 *
 * Pinned here:
 *   - a panel opened under a diagram's position-and-source key moves to its
 *     marker-id key, its typed request and its request in flight with it,
 *     and the request still answers as the current one and finishes there;
 *   - a panel already under the marker-id key is kept, and moving a panel
 *     that is not there does nothing;
 *   - the owning hook keeps only the current document's panels: moving to
 *     another document aborts and forgets the earlier one's.
 */

import {
	createVisualEditStore,
	useOwnedVisualEditStore,
	visualEditKey,
} from "@saas/projects/lib/mermaid-edit-visual-store";
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const CODE = "%% fabric-visual: v-example\nflowchart LR\n  A --> B";
const FENCE_KEY = visualEditKey("doc-1", { code: CODE, ordinal: 0 });
const MARKER_KEY = visualEditKey("doc-1", {
	code: CODE,
	ordinal: 0,
	visualId: "v-example",
});

describe("visual edit store: rekey", () => {
	it("moves a panel, what was typed and its request in flight to the marker-id key", () => {
		const store = createVisualEditStore();
		const listener = vi.fn();
		store.subscribe(listener);
		store.open(FENCE_KEY);
		store.update(FENCE_KEY, { instruction: "Add a review step." });
		const request = store.begin(FENCE_KEY);
		store.setHost(FENCE_KEY, {
			readTarget: () => null,
			renderCandidate: async () => "",
			announce: () => {},
		});

		expect(store.rekey(FENCE_KEY, MARKER_KEY)).toBe(true);

		expect(store.get(FENCE_KEY)).toBeUndefined();
		expect(store.get(MARKER_KEY)?.instruction).toBe("Add a review step.");
		expect(store.host(FENCE_KEY)).toBeUndefined();
		expect(listener).toHaveBeenCalled();
		// Still the panel's request, now under its new key.
		expect(request.signal.aborted).toBe(false);
		expect(request.current()).toBe(true);
		store.stop(MARKER_KEY);
		expect(request.signal.aborted).toBe(true);
		expect(request.current()).toBe(false);
	});

	it("finishes a moved request under its new key", () => {
		const store = createVisualEditStore();
		store.open(FENCE_KEY);
		const request = store.begin(FENCE_KEY);
		store.rekey(FENCE_KEY, MARKER_KEY);

		request.finish();
		expect(request.current()).toBe(false);
		// Finished, not aborted: a later stop has nothing to abort.
		store.stop(MARKER_KEY);
		expect(request.signal.aborted).toBe(false);
	});

	it("keeps a panel already under the new key, and moves nothing that is not there", () => {
		const store = createVisualEditStore();
		store.open(MARKER_KEY);
		store.update(MARKER_KEY, { instruction: "Kept." });
		store.open(FENCE_KEY);

		expect(store.rekey(FENCE_KEY, MARKER_KEY)).toBe(true);
		expect(store.get(MARKER_KEY)?.instruction).toBe("Kept.");

		const empty = createVisualEditStore();
		expect(empty.rekey(FENCE_KEY, MARKER_KEY)).toBe(false);
		expect(empty.get(MARKER_KEY)).toBeUndefined();
	});
});

describe("visual edit store: one document at a time", () => {
	it("aborts and forgets an earlier document's panels when the document changes", () => {
		const { result, rerender } = renderHook(
			({ documentId }) => useOwnedVisualEditStore(documentId),
			{ initialProps: { documentId: "doc-1" } },
		);
		const store = result.current;
		store.open(MARKER_KEY);
		const request = store.begin(MARKER_KEY);
		const otherKey = visualEditKey("doc-2", {
			code: CODE,
			ordinal: 0,
			visualId: "v-example",
		});

		rerender({ documentId: "doc-2" });
		expect(result.current).toBe(store);
		expect(store.get(MARKER_KEY)).toBeUndefined();
		expect(request.signal.aborted).toBe(true);

		// The new document's panels stay.
		store.open(otherKey);
		rerender({ documentId: "doc-2" });
		expect(store.get(otherKey)).toBeDefined();
	});
});
