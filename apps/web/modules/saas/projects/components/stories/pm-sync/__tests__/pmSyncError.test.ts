import { describe, expect, it } from "vitest";
import { type PmSyncErrorKind, pmSyncErrorCopy } from "../pmSyncError";

describe("pmSyncErrorCopy", () => {
	it("MISSING frames it as 'connect your account' (per-user model), not a permission error", () => {
		const copy = pmSyncErrorCopy("MISSING", "azure-devops");
		expect(copy.action).toBe("settings");
		expect(copy.title.toLowerCase()).toContain("connect");
		// Never implies the user lacks a role/permission — the connection is
		// each member's own.
		expect(copy.body.toLowerCase()).not.toContain("permission");
	});

	it("EXPIRED prompts a reconnect via settings", () => {
		const copy = pmSyncErrorCopy("EXPIRED", "jira");
		expect(copy.action).toBe("settings");
		expect(copy.title.toLowerCase()).toContain("reconnect");
	});

	it("NO_ACCESS tells the user to use a different account (strict per-user isolation)", () => {
		const copy = pmSyncErrorCopy("NO_ACCESS", "azure-devops");
		expect(copy.body.toLowerCase()).toContain("access");
		expect(copy.action).toBe("settings");
	});

	it("TRANSIENT offers a retry, not a settings link", () => {
		const copy = pmSyncErrorCopy("TRANSIENT", "azure-devops");
		expect(copy.action).toBe("retry");
	});

	it("NOT_CONFIGURED offers no action", () => {
		const copy = pmSyncErrorCopy("NOT_CONFIGURED", null);
		expect(copy.action).toBe("none");
	});

	it("falls back to a generic tool label when pmTool is null", () => {
		const copy = pmSyncErrorCopy("MISSING", null);
		expect(copy.body).toContain("your PM tool");
	});

	it("uses the resolved tool name (not the generic fallback) for a known tool", () => {
		// Guards against a broken display-name lookup silently degrading to the
		// "your PM tool" fallback for a real tool key.
		const copy = pmSyncErrorCopy("MISSING", "azure-devops");
		expect(copy.body).not.toContain("your PM tool");
	});

	it("covers every kind without throwing", () => {
		const kinds: PmSyncErrorKind[] = [
			"MISSING",
			"EXPIRED",
			"INVALID",
			"DISABLED",
			"NO_ACCESS",
			"TRANSIENT",
			"NOT_CONFIGURED",
		];
		for (const kind of kinds) {
			const copy = pmSyncErrorCopy(kind, "azure-devops");
			expect(copy.title.length).toBeGreaterThan(0);
			expect(copy.body.length).toBeGreaterThan(0);
		}
	});
});
