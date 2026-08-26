/**
 * i18n parity test for the audit-log action taxonomy.
 *
 * Pins that every closed-taxonomy action key (and the open `error.*`
 * complement) resolves to a non-fallback label in both `en` and `de`
 * translation files. Catches the dot-key collision regression where
 * keys like `"auth.login.success"` lived as literal flat strings under
 * `actions` — `next-intl` would then misinterpret each dot as a nesting
 * separator and throw `MISSING_MESSAGE`. With the nested-object shape
 * the lookup `actions.auth.login.success` traverses correctly to the
 * leaf string.
 */

import { describe, expect, it } from "vitest";
import de from "../../../../../../../../packages/i18n/translations/de.json";
import en from "../../../../../../../../packages/i18n/translations/en.json";
import { KNOWN_ACTIONS } from "../action-catalog";

// Drill into the JSON-as-object using the dotted key path. Mirrors what
// next-intl does under the hood: each segment is a property lookup. Used
// for both leaf-string lookups (action labels) and container lookups
// (asserting that the category nodes are objects, not flat strings).
function dotLookup(source: unknown, key: string): unknown {
	const parts = key.split(".");
	let current: unknown = source;
	for (const part of parts) {
		if (
			!current ||
			typeof current !== "object" ||
			!(part in (current as Record<string, unknown>))
		) {
			return undefined;
		}
		current = (current as Record<string, unknown>)[part];
	}
	return current;
}

function resolveAction(
	source: Record<string, unknown>,
	action: string,
): string | undefined {
	const v = dotLookup(source, `settings.auditLog.actions.${action}`);
	return typeof v === "string" ? v : undefined;
}

describe("audit action i18n parity", () => {
	const enJson = en as unknown as Record<string, unknown>;
	const deJson = de as unknown as Record<string, unknown>;

	it("every catalog action resolves to a non-empty en label", () => {
		for (const action of KNOWN_ACTIONS) {
			const value = resolveAction(enJson, action);
			expect(
				value,
				`missing en label for action "${action}"`,
			).toBeDefined();
			expect(
				typeof value === "string" && value.length > 0,
				`en label for action "${action}" is empty`,
			).toBe(true);
		}
	});

	it("every catalog action resolves to a non-empty de label", () => {
		for (const action of KNOWN_ACTIONS) {
			const value = resolveAction(deJson, action);
			expect(
				value,
				`missing de label for action "${action}"`,
			).toBeDefined();
			expect(
				typeof value === "string" && value.length > 0,
				`de label for action "${action}" is empty`,
			).toBe(true);
		}
	});

	it("en and de have parity (every en action key has a de counterpart)", () => {
		for (const action of KNOWN_ACTIONS) {
			const enValue = resolveAction(enJson, action);
			const deValue = resolveAction(deJson, action);
			expect(enValue, `en missing label for "${action}"`).toBeDefined();
			expect(deValue, `de missing label for "${action}"`).toBeDefined();
		}
	});

	it("category roots (auth, org, project, story, audit, error, incident) are objects, not strings", () => {
		const enActions = dotLookup(enJson, "settings.auditLog.actions");
		expect(enActions).toBeDefined();
		const categories = [
			"auth",
			"org",
			"project",
			"story",
			"audit",
			"error",
			"incident",
		];
		for (const category of categories) {
			const value = (enActions as Record<string, unknown>)[category];
			expect(
				typeof value === "object" && value !== null,
				`en actions.${category} must be an object`,
			).toBe(true);
		}
	});
});
