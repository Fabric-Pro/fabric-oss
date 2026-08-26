import { ERROR_ACTIONS, AUDIT_ACTIONS as TAXONOMY } from "@repo/database";
import { describe, expect, it } from "vitest";
import {
	AUDIT_ACTIONS as CATALOG,
	describeActionKey,
} from "../audit-actions-catalog";

/**
 * Every audit action must have a plain-language description.
 *
 * The taxonomy is a closed set guarded by a hard count in `packages/api`, and the
 * i18n labels are guarded by their own parity test — but nothing tied the two to
 * THIS catalog, which is what the audit log actually renders. So the catalog
 * drifted: 28 of 87 actions had no entry and fell through to "Custom action
 * emitted by this deployment", which tells an operator investigating an incident
 * nothing at all. `atlas.*`, `mcp.config.*`, `featureFlag.*` and
 * `story.auto_hidden` were among them — exactly the kinds of event someone reads
 * the audit log to understand.
 *
 * The drift was invisible because the fallback is graceful. A missing entry never
 * threw, never logged, and never failed a test; it just quietly degraded the one
 * surface the whole taxonomy exists to serve.
 */
describe("audit action catalog coverage", () => {
	const described = new Set(CATALOG.map((a) => a.key));

	it("describes every action in the closed taxonomy", () => {
		const missing = TAXONOMY.filter((key) => !described.has(key));

		expect(missing).toEqual([]);
	});

	it("describes every error action the middleware can emit", () => {
		// `ERROR_ACTIONS` is a second array (D16 automatic error capture) and is
		// just as visible in the log as the hand-emitted ones.
		const missing = ERROR_ACTIONS.filter((key) => !described.has(key));

		expect(missing).toEqual([]);
	});

	it("never falls back to the generic sentence for a known action", () => {
		// The behavioural form of the same claim: the fallback is what made the
		// drift invisible, so assert no real action reaches it.
		for (const key of [...TAXONOMY, ...ERROR_ACTIONS]) {
			expect(describeActionKey(key)).not.toMatch(/Custom action emitted/);
		}
	});

	it("gives each entry a description worth reading", () => {
		// A one-word entry would satisfy the coverage check above while leaving
		// the operator no better off than the fallback did.
		const thin = CATALOG.filter((a) => a.description.trim().length < 25);

		expect(thin.map((a) => a.key)).toEqual([]);
	});

	it("has no duplicate keys", () => {
		expect(described.size).toBe(CATALOG.length);
	});
});
