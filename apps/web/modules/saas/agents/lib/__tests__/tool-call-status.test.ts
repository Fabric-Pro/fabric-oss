import { describe, expect, it } from "vitest";
import {
	persistedToToolCallStatus,
	toolCallToPersistedStatus,
} from "../tool-call-status";

describe("toolCallToPersistedStatus", () => {
	it("preserves error end-to-end (F-1171 regression)", () => {
		// Before the fix the catch-all branch silently mapped error -> pending,
		// which caused the reasoning trace to render historical failures as
		// running spinners after a page reload. Pin the correct mapping.
		expect(toolCallToPersistedStatus("error")).toBe("error");
	});

	it("maps complete to success", () => {
		expect(toolCallToPersistedStatus("complete")).toBe("success");
	});

	it("preserves running", () => {
		expect(toolCallToPersistedStatus("running")).toBe("running");
	});

	it("preserves pending", () => {
		expect(toolCallToPersistedStatus("pending")).toBe("pending");
	});
});

describe("persistedToToolCallStatus", () => {
	it("maps success back to complete", () => {
		expect(persistedToToolCallStatus("success")).toBe("complete");
	});

	it("preserves error", () => {
		expect(persistedToToolCallStatus("error")).toBe("error");
	});

	it("preserves running", () => {
		expect(persistedToToolCallStatus("running")).toBe("running");
	});

	it("preserves pending", () => {
		expect(persistedToToolCallStatus("pending")).toBe("pending");
	});
});

describe("status round-trip (live -> persisted -> rehydrated)", () => {
	it("round-trips error so the reasoning trace stays accurate after reload", () => {
		// Critical for F-1171 AC3 ("indicates which sources were skipped, with
		// reasons") composed with AC2 ("log persists after the session"): a
		// failed tool call surfaced live must still surface as a failure once
		// the conversation is reloaded.
		const persisted = toolCallToPersistedStatus("error");
		const rehydrated = persistedToToolCallStatus(persisted);
		expect(rehydrated).toBe("error");
	});

	it("round-trips complete", () => {
		const persisted = toolCallToPersistedStatus("complete");
		const rehydrated = persistedToToolCallStatus(persisted);
		expect(rehydrated).toBe("complete");
	});

	it("round-trips running", () => {
		const persisted = toolCallToPersistedStatus("running");
		const rehydrated = persistedToToolCallStatus(persisted);
		expect(rehydrated).toBe("running");
	});

	it("round-trips pending", () => {
		const persisted = toolCallToPersistedStatus("pending");
		const rehydrated = persistedToToolCallStatus(persisted);
		expect(rehydrated).toBe("pending");
	});
});
