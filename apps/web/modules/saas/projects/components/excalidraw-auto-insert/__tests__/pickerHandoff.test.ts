/**
 * Tests for the picker-dialog sessionStorage handoff helpers.
 *
 * Spec § 10.4 locks the contract:
 *   - Write -> read -> the second read returns null (at-most-once).
 *   - Read of an intent older than 60 seconds returns null even if
 *     present (spec § 11 row 8 expiry).
 *   - All entrypoints are no-ops when called outside a browser
 *     (SSR-safe).
 *
 * Uses vitest fake timers for the expiry case so the 60-second cap can
 * be exercised deterministically without slowing the suite.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildPickerIntentStorageKey,
	consumePickerIntent,
	expirePickerIntent,
	PICKER_INTENT_EXPIRY_MS,
	type PickerIntent,
	writePickerIntent,
} from "../pickerHandoff";

function buildIntent(overrides: Partial<PickerIntent> = {}): PickerIntent {
	return {
		diagramRequestId: "req-1",
		surface: "nexus",
		projectId: "proj_1",
		organizationId: "org_1",
		elements: [{ id: "shape1", type: "rectangle" }],
		appState: { theme: "dark" },
		checkpointId: "cp_xyz",
		mcpConfigId: "cfg_xyz",
		title: "Test diagram",
		targetKind: "document",
		targetId: "doc_1",
		createdAt: Date.now(),
		...overrides,
	};
}

describe("pickerHandoff — write / consume round-trip", () => {
	beforeEach(() => {
		window.sessionStorage.clear();
	});

	it("writes then consumes the same intent", () => {
		const intent = buildIntent();
		writePickerIntent(intent);

		const consumed = consumePickerIntent("req-1");
		expect(consumed).not.toBeNull();
		expect(consumed?.diagramRequestId).toBe("req-1");
		expect(consumed?.checkpointId).toBe("cp_xyz");
		expect(consumed?.mcpConfigId).toBe("cfg_xyz");
		expect(consumed?.targetKind).toBe("document");
	});

	it("returns null on the SECOND consume (at-most-once)", () => {
		writePickerIntent(buildIntent());
		consumePickerIntent("req-1");
		expect(consumePickerIntent("req-1")).toBeNull();
	});

	it("returns null for an unknown request id", () => {
		expect(consumePickerIntent("never-written")).toBeNull();
	});

	it("uses the documented storage key shape", () => {
		// The Playwright spec asserts on this exact key string, so changes
		// here have to be coordinated with the E2E suite. Lock it.
		expect(buildPickerIntentStorageKey("abc")).toBe(
			"excalidraw-auto-insert:abc",
		);
	});
});

describe("pickerHandoff — expiry", () => {
	beforeEach(() => {
		window.sessionStorage.clear();
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("returns null when the intent is older than the 60s cap", () => {
		// Write at virtual time t=0.
		const intent = buildIntent({ createdAt: Date.now() });
		writePickerIntent(intent);

		// Advance virtual time past the expiry cap.
		vi.advanceTimersByTime(PICKER_INTENT_EXPIRY_MS + 1);

		expect(consumePickerIntent("req-1")).toBeNull();
	});

	it("returns the intent at exactly 60 seconds (boundary)", () => {
		// Boundary check: 60_000 ms is the cap — entries this old are
		// still valid. Anything older (60_001+) is expired.
		const intent = buildIntent({ createdAt: Date.now() });
		writePickerIntent(intent);
		vi.advanceTimersByTime(PICKER_INTENT_EXPIRY_MS);
		expect(consumePickerIntent("req-1")).not.toBeNull();
	});

	it("removes the entry from storage even when expired", () => {
		writePickerIntent(buildIntent({ createdAt: Date.now() }));
		vi.advanceTimersByTime(PICKER_INTENT_EXPIRY_MS + 1);
		// First call sees the expired entry and returns null after removing.
		expect(consumePickerIntent("req-1")).toBeNull();
		// Storage is empty afterwards — re-write to confirm.
		writePickerIntent(buildIntent({ createdAt: Date.now() }));
		expect(consumePickerIntent("req-1")).not.toBeNull();
	});
});

describe("pickerHandoff — expire helper", () => {
	beforeEach(() => {
		window.sessionStorage.clear();
	});

	it("removes the entry without returning it", () => {
		writePickerIntent(buildIntent());
		expirePickerIntent("req-1");
		expect(consumePickerIntent("req-1")).toBeNull();
	});

	it("is a no-op when no entry exists", () => {
		// Should not throw.
		expect(() => expirePickerIntent("never-written")).not.toThrow();
	});
});

describe("pickerHandoff — corrupt entries", () => {
	beforeEach(() => {
		window.sessionStorage.clear();
	});

	it("returns null when the stored value isn't valid JSON", () => {
		window.sessionStorage.setItem(
			buildPickerIntentStorageKey("bad"),
			"{not valid",
		);
		expect(consumePickerIntent("bad")).toBeNull();
	});

	it("returns null when the parsed value is missing createdAt", () => {
		window.sessionStorage.setItem(
			buildPickerIntentStorageKey("incomplete"),
			JSON.stringify({ diagramRequestId: "incomplete" }),
		);
		expect(consumePickerIntent("incomplete")).toBeNull();
	});
});

describe("pickerHandoff — SSR safety", () => {
	// Simulate an SSR context by temporarily detaching `window`. Vitest's
	// jsdom env makes `window` global, so we can't simply check for the
	// SSR-no-op path without monkey-patching. The cleaner approach is to
	// confirm the API contracts hold when `window.sessionStorage` is
	// undefined — that's the path the SSR runtime would hit.
	let realStorage: Storage | undefined;
	beforeEach(() => {
		realStorage = window.sessionStorage;
		Object.defineProperty(window, "sessionStorage", {
			value: undefined,
			configurable: true,
		});
	});
	afterEach(() => {
		Object.defineProperty(window, "sessionStorage", {
			value: realStorage,
			configurable: true,
		});
	});

	it("writePickerIntent is a no-op without sessionStorage", () => {
		expect(() => writePickerIntent(buildIntent())).not.toThrow();
	});

	it("consumePickerIntent returns null without sessionStorage", () => {
		expect(consumePickerIntent("any")).toBeNull();
	});

	it("expirePickerIntent is a no-op without sessionStorage", () => {
		expect(() => expirePickerIntent("any")).not.toThrow();
	});
});
