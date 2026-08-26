import { describe, expect, it } from "vitest";
import {
	hasAutomationRef,
	isAutomatedWithRef,
	isLinkableAutomationUrl,
	statusAfterRefEdit,
} from "../automation-link";

/**
 * `statusAfterRefEdit` exists to keep the editor in step with the write path,
 * which reads: an explicit `automationStatus` wins, otherwise a non-empty ref
 * implies AUTOMATED. The editor always submits a status, so these cases pin the
 * client to the same outcome a caller that omitted the status would get.
 */
describe("statusAfterRefEdit", () => {
	it("marks the case automated when the first ref is recorded", () => {
		expect(statusAfterRefEdit("NOT_AUTOMATED", "", "auth › login")).toBe(
			"AUTOMATED",
		);
		expect(statusAfterRefEdit("PLANNED", "", "auth › login")).toBe(
			"AUTOMATED",
		);
	});

	it("treats a blank ref as no ref", () => {
		expect(statusAfterRefEdit("PLANNED", "", "   ")).toBe("PLANNED");
		expect(statusAfterRefEdit("PLANNED", "   ", "auth › login")).toBe(
			"AUTOMATED",
		);
	});

	it("leaves the status alone once a ref is on file", () => {
		// The escape hatch: a ref recorded while the case is deliberately only
		// PLANNED survives further edits to the ref itself.
		expect(statusAfterRefEdit("PLANNED", "old ref", "new ref")).toBe(
			"PLANNED",
		);
		expect(statusAfterRefEdit("AUTOMATED", "old ref", "new ref")).toBe(
			"AUTOMATED",
		);
	});

	it("does not downgrade the status when the ref is cleared", () => {
		expect(statusAfterRefEdit("AUTOMATED", "old ref", "")).toBe(
			"AUTOMATED",
		);
	});
});

describe("hasAutomationRef", () => {
	it("is true only for a ref with content", () => {
		expect(hasAutomationRef("auth › login")).toBe(true);
		expect(hasAutomationRef("   ")).toBe(false);
		expect(hasAutomationRef("")).toBe(false);
		expect(hasAutomationRef(null)).toBe(false);
		expect(hasAutomationRef(undefined)).toBe(false);
	});
});

describe("isLinkableAutomationUrl", () => {
	it("accepts http(s) URLs, trimming surrounding space", () => {
		expect(isLinkableAutomationUrl("https://ci.example.com/run/1")).toBe(
			true,
		);
		expect(isLinkableAutomationUrl("http://ci.example.com/run/1")).toBe(
			true,
		);
		expect(
			isLinkableAutomationUrl("  https://ci.example.com/run/1  "),
		).toBe(true);
	});

	it("rejects blank and unparseable values", () => {
		expect(isLinkableAutomationUrl("")).toBe(false);
		expect(isLinkableAutomationUrl("   ")).toBe(false);
		expect(isLinkableAutomationUrl("ci.example.com/run/1")).toBe(false);
	});

	it("rejects schemes that are not safe to render as a link", () => {
		expect(isLinkableAutomationUrl("javascript:alert(1)")).toBe(false);
		expect(isLinkableAutomationUrl("data:text/html,<script>")).toBe(false);
		expect(isLinkableAutomationUrl("file:///etc/passwd")).toBe(false);
	});
});

/**
 * The row mark and the Automation % must agree. The server counts a case as
 * automated only when it is AUTOMATED *and* carries a ref
 * (`automatedWithRefCount`); these cases pin the client to that same rule, so
 * the two renderings of one fact cannot diverge.
 */
describe("isAutomatedWithRef", () => {
	it("is true only for an AUTOMATED case that carries a ref", () => {
		expect(
			isAutomatedWithRef("AUTOMATED", "login.spec.ts > signs in"),
		).toBe(true);
	});

	it("is false for AUTOMATED with no ref — intent recorded ahead of the link", () => {
		expect(isAutomatedWithRef("AUTOMATED", null)).toBe(false);
		expect(isAutomatedWithRef("AUTOMATED", "   ")).toBe(false);
	});

	it("is false for a stale ref left on a case marked NOT_AUTOMATED", () => {
		// Reachable: clearing the status does not null the ref. The mark must not
		// claim automation the percentage refuses to count.
		expect(isAutomatedWithRef("NOT_AUTOMATED", "login.spec.ts")).toBe(
			false,
		);
	});

	it("is false for PLANNED with a ref — the deliberate not-yet-automated case", () => {
		expect(isAutomatedWithRef("PLANNED", "login.spec.ts")).toBe(false);
	});
});
