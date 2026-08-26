/**
 * Every readiness item's call-to-action must land somewhere that still exists
 * (Fizzy #2165, Checklist AC-4).
 *
 * The panel routes a gap to `target` — either a top-level project tab or a
 * Project Settings sub-tab. Both are plain string ids living in `apps/web`,
 * while the rules that name them live in `packages/api`, so nothing in the type
 * system connects the two. Rename a tab and the CTA silently becomes a link to
 * nowhere: `?tab=` ignores an unrecognised value by design, and the settings
 * event fires with a sub-tab nobody handles. Neither throws.
 *
 * A test that asserts the click handler calls `router.push` cannot catch that —
 * it passes forever while pushing a dead id. This checks the ids themselves,
 * parsed from the live sources the same way the get-started drift test does.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { READINESS_RULES } from "@repo/api/modules/projects/lib/readiness/registry";
import { KNOWLEDGE_BASE_SOURCE_CATEGORIES } from "@repo/api/modules/projects/procedures/contexts/knowledge-base-category.types";
import { KNOWLEDGE_BASE_CATEGORY_OPTIONS } from "@saas/projects/lib/knowledge-base-categories";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../../../../..");
const read = (rel: string) => readFileSync(path.resolve(repoRoot, rel), "utf8");

const projectDetailsSource = read(
	"apps/web/modules/saas/projects/components/ProjectDetails.tsx",
);
const settingsNavSource = read(
	"apps/web/modules/saas/projects/components/ProjectSettingsNav.tsx",
);

/** Live top-level project tab ids, from `ProjectDetails`' `tabs` array. */
function liveProjectTabIds(): string[] {
	const start = projectDetailsSource.indexOf("const tabs = [");
	const end = projectDetailsSource.indexOf("] as const;", start);
	const ids: string[] = [];
	for (const line of projectDetailsSource.slice(start, end).split("\n")) {
		if (line.trim().startsWith("//")) {
			continue;
		}
		const m = line.match(/id:\s*"([a-z-]+)"/);
		if (m) {
			ids.push(m[1]);
		}
	}
	return ids;
}

/** Live settings sub-tab ids, from the `SettingsTab` union. */
function liveSettingsTabIds(): string[] {
	const start = settingsNavSource.indexOf("export type SettingsTab =");
	const end = settingsNavSource.indexOf(";", start);
	return [
		...settingsNavSource.slice(start, end).matchAll(/"([a-z-]+)"/g),
	].map((m) => m[1]);
}

describe("readiness item targets", () => {
	// Both extractors read source text, so a parsing change would make every
	// assertion below pass vacuously. Pin a floor first.
	it("the extractors actually find the live ids (guards itself)", () => {
		expect(liveProjectTabIds().length).toBeGreaterThanOrEqual(15);
		expect(liveSettingsTabIds().length).toBeGreaterThanOrEqual(8);
	});

	it("every rule targets a project tab or settings sub-tab that still exists", () => {
		const tabs = new Set(liveProjectTabIds());
		const settingsTabs = new Set(liveSettingsTabIds());

		for (const rule of READINESS_RULES) {
			if (rule.target.kind === "tab") {
				expect(
					tabs.has(rule.target.tab),
					`readiness item "${rule.key}" targets project tab "${rule.target.tab}", which no longer exists in ProjectDetails.tsx`,
				).toBe(true);
			} else {
				expect(
					settingsTabs.has(rule.target.subTab),
					`readiness item "${rule.key}" targets settings sub-tab "${rule.target.subTab}", which is no longer in the SettingsTab union`,
				).toBe(true);
			}
		}
	});

	// Every `ctaLabelKey` was dead code until the CTA was rendered, so none of
	// them had ever been resolved. `en.json`'s `readiness.cta` block was authored
	// separately from the registry, which is exactly the shape that drifts — and
	// a missing key is not cosmetic: next-intl renders the raw path as the button
	// label, or throws and takes the whole panel down with it.
	it("every rule's CTA label key resolves to real copy", () => {
		const messages = JSON.parse(
			read("packages/i18n/translations/en.json"),
		) as Record<string, unknown>;

		for (const rule of READINESS_RULES) {
			const value = rule.ctaLabelKey
				.split(".")
				.reduce<unknown>(
					(node, part) =>
						node && typeof node === "object"
							? (node as Record<string, unknown>)[part]
							: undefined,
					messages,
				);
			expect(
				typeof value === "string" && value.trim().length > 0,
				`readiness item "${rule.key}" points at "${rule.ctaLabelKey}", which has no copy in en.json`,
			).toBe(true);
		}
	});

	// Structural, so a NEW rule cannot drift either: the key is derived from the
	// rule key rather than invented per rule. Every one of the 26 was invented
	// before this test existed, and every one of them was wrong — the registry
	// named them by verb ("defineFeatures") while the catalogue keyed them by
	// item ("featureSnapshot"), so all 26 buttons would have rendered a raw key
	// path or thrown.
	it("derives every CTA label key from the rule key", () => {
		for (const rule of READINESS_RULES) {
			const camel = rule.key.replace(/-([a-z])/g, (_, c: string) =>
				c.toUpperCase(),
			);
			expect(rule.ctaLabelKey, `item "${rule.key}"`).toBe(
				`readiness.cta.${camel}`,
			);
		}
	});

	// Same exposure for the item names the panel already rendered — cheap to pin
	// while the resolver is here.
	it("every rule's item name resolves to real copy", () => {
		const messages = JSON.parse(
			read("packages/i18n/translations/en.json"),
		) as Record<string, unknown>;
		const items = (messages.readiness as Record<string, unknown>)
			.items as Record<string, { name?: string }>;

		for (const rule of READINESS_RULES) {
			const camel = rule.key.replace(/-([a-z])/g, (_, c: string) =>
				c.toUpperCase(),
			);
			expect(
				items[camel]?.name?.trim(),
				`readiness item "${rule.key}" has no name copy at readiness.items.${camel}.name`,
			).toBeTruthy();
		}
	});

	// The dialog cannot import the server module that defines these, so it keeps
	// its own labelled list. This is what stops the two from drifting.
	it("the link form offers exactly the categories the API accepts, in order", () => {
		expect(KNOWLEDGE_BASE_CATEGORY_OPTIONS.map((o) => o.value)).toEqual([
			...KNOWLEDGE_BASE_SOURCE_CATEGORIES,
		]);
	});
});
