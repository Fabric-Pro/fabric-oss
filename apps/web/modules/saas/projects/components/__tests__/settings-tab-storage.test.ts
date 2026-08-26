import { describe, expect, it } from "vitest";
import {
	KNOWN_SETTINGS_TABS,
	resolveStoredSettingsTab,
	type SettingsTabGates,
} from "../settings-tab-storage";

/**
 * Settings-tab storage-key rename migration, and the flag gates on top of it.
 *
 * The persisted sub-tab value can be the stale pre-rename string `"execution"`
 * (or any unknown value). The read path must gracefully default such values to
 * `"development"` rather than throwing or leaving an invalid tab selected. The
 * flag-gated tabs — `project-management`, and the QA pair `environments` /
 * `testing` — must never be resolved while their flag is off.
 * `resolveStoredSettingsTab` was extracted to its own module so it can be
 * unit-tested without evaluating the `"use client"` `ProjectSettings` graph.
 */

/** All gates open — the shape most assertions do not care about. */
const OPEN: SettingsTabGates = {
	pmFieldMappingEnabled: true,
	qaEnabled: true,
	publishingEnabled: true,
};
/** All gates shut. */
const SHUT: SettingsTabGates = {
	pmFieldMappingEnabled: false,
	qaEnabled: false,
	publishingEnabled: false,
};

describe("resolveStoredSettingsTab", () => {
	it('migrates the stale pre-rename "execution" value to "development"', () => {
		expect(resolveStoredSettingsTab("execution", SHUT)).toBe("development");
		expect(resolveStoredSettingsTab("execution", OPEN)).toBe("development");
	});

	it('defaults any unknown/garbage persisted value to "development"', () => {
		expect(resolveStoredSettingsTab("does-not-exist", SHUT)).toBe(
			"development",
		);
		expect(resolveStoredSettingsTab("", SHUT)).toBe(null); // empty === "not persisted"
		expect(resolveStoredSettingsTab("random-123", OPEN)).toBe(
			"development",
		);
	});

	it("returns null when nothing is persisted so the caller can fall back", () => {
		expect(resolveStoredSettingsTab(null, SHUT)).toBe(null);
		expect(resolveStoredSettingsTab(null, OPEN)).toBe(null);
	});

	it("preserves a valid persisted tab value unchanged", () => {
		expect(resolveStoredSettingsTab("general", SHUT)).toBe("general");
		expect(resolveStoredSettingsTab("knowledge", OPEN)).toBe("knowledge");
		expect(resolveStoredSettingsTab("development", SHUT)).toBe(
			"development",
		);
		expect(resolveStoredSettingsTab("newsletter", SHUT)).toBe("newsletter");
		expect(resolveStoredSettingsTab("danger", OPEN)).toBe("danger");
	});

	it('resolves the flag-gated "project-management" tab only when the flag is on', () => {
		// Flag on → the persisted PM tab is honored.
		expect(
			resolveStoredSettingsTab("project-management", {
				...SHUT,
				pmFieldMappingEnabled: true,
			}),
		).toBe("project-management");
		// Flag off → never land on the gated PM tab; fall back to Development.
		expect(resolveStoredSettingsTab("project-management", SHUT)).toBe(
			"development",
		);
	});

	it('does not list the removed "execution" id among known tabs', () => {
		expect(KNOWN_SETTINGS_TABS).not.toContain("execution");
		expect(KNOWN_SETTINGS_TABS).toContain("development");
		expect(KNOWN_SETTINGS_TABS).toContain("project-management");
	});

	it("keeps the QA settings tabs resolvable while the QA flag is on", () => {
		// A tab missing from KNOWN_SETTINGS_TABS is silently rewritten to
		// "development" on reload, so someone who was last on Testing would be
		// bounced elsewhere — the failure is invisible without this assertion.
		expect(KNOWN_SETTINGS_TABS).toContain("environments");
		expect(KNOWN_SETTINGS_TABS).toContain("testing");
		expect(resolveStoredSettingsTab("testing", OPEN)).toBe("testing");
		expect(resolveStoredSettingsTab("environments", OPEN)).toBe(
			"environments",
		);
	});

	it("refuses the QA settings tabs while the QA flag is off", () => {
		// The QA project tab is gated on NEXT_PUBLIC_FABRIC_FEATURE_TEST_CASES but
		// its two settings pages were not, so a stale sessionStorage value reopened
		// a full configuration surface for a page the user cannot reach and an API
		// that refuses them server-side.
		expect(resolveStoredSettingsTab("testing", SHUT)).toBe("development");
		expect(resolveStoredSettingsTab("environments", SHUT)).toBe(
			"development",
		);
		// The gates are independent — PM on does not open the QA pair.
		expect(
			resolveStoredSettingsTab("testing", {
				pmFieldMappingEnabled: true,
				qaEnabled: false,
				publishingEnabled: true,
			}),
		).toBe("development");
	});

	it('resolves the flag-gated "publishing" tab only when the flag is on', () => {
		// An id missing from KNOWN_SETTINGS_TABS is silently rewritten to
		// "development" on reload — without this, selecting Publishing Suite
		// and reloading would dump the user on a different tab.
		expect(KNOWN_SETTINGS_TABS).toContain("publishing");
		// Flag on → the persisted Publishing Suite tab is honored.
		expect(
			resolveStoredSettingsTab("publishing", {
				...SHUT,
				publishingEnabled: true,
			}),
		).toBe("publishing");
	});

	it('refuses the "publishing" settings tab while its flag is off', () => {
		// Mirrors the QA pair: a stale sessionStorage value must not reopen a
		// settings surface for a page the flag hides.
		expect(resolveStoredSettingsTab("publishing", SHUT)).toBe(
			"development",
		);
		// The gates are independent — QA on does not open Publishing Suite.
		expect(
			resolveStoredSettingsTab("publishing", {
				pmFieldMappingEnabled: false,
				qaEnabled: true,
				publishingEnabled: false,
			}),
		).toBe("development");
	});
});
