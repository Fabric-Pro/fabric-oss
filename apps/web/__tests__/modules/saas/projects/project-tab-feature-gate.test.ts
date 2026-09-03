import { afterEach, describe, expect, it, vi } from "vitest";
import {
	isProjectTabFeatureEnabled,
	isProjectTabVisibleToViewer,
	type ProjectTabGates,
	resolveAdminTabState,
	resolveProjectTabs,
} from "../../../../modules/saas/projects/lib/project-tab-preferences";

/**
 * Layer 0 of tab resolution (card #1837): the availability ceiling.
 *
 * Two kinds of gate now live here. Atlas and Test Cases stay build-time
 * `NEXT_PUBLIC_*` reads, so `vi.stubEnv` still drives them. Publishing Suite is
 * resolved per organization at runtime and arrives as an argument, because a
 * `NEXT_PUBLIC_*` value is inlined at build time and can never carry a
 * per-organization answer.
 */

const ATLAS = "NEXT_PUBLIC_FABRIC_FEATURE_ATLAS";

const OFF: ProjectTabGates = { publishingSuiteEnabled: false };
const ON: ProjectTabGates = { publishingSuiteEnabled: true };

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("feature-flag availability ceiling — build-time gates", () => {
	const IDS = ["overview", "atlas"];

	it("flag off: gated tab is invisible even when admin and user opted in", () => {
		vi.stubEnv(ATLAS, "false");
		const resolved = resolveProjectTabs(
			[{ id: "overview" }, { id: "atlas" }],
			{
				config: { overrides: { atlas: true } },
				prefs: {},
				gates: OFF,
			},
		);
		expect(resolved.map((t) => t.id)).toEqual(["overview"]);
		expect(isProjectTabVisibleToViewer("atlas", OFF, {}, {})).toBe(false);
		expect(isProjectTabFeatureEnabled("atlas", OFF)).toBe(false);
	});

	it("legacy env name still unlocks the gated tab", () => {
		vi.stubEnv("NEXT_PUBLIC_FABRIC_FEATURE_CODE_UNDERSTANDING", "true");
		expect(isProjectTabFeatureEnabled("atlas", OFF)).toBe(true);
		// Unlocking the feature hands the tab to the admin layer, which shows
		// it unless an admin has hidden it.
		expect(isProjectTabVisibleToViewer("atlas", OFF, {}, {})).toBe(true);
		expect(
			isProjectTabVisibleToViewer(
				"atlas",
				OFF,
				{ overrides: { atlas: false } },
				{},
			),
		).toBe(false);
	});

	it("resolveAdminTabState omits feature-disabled tabs entirely", () => {
		vi.stubEnv(ATLAS, "false");
		expect(resolveAdminTabState(IDS, null, OFF)).toEqual({
			overview: true,
		});
	});

	it("flag on: the gated tab obeys the ordinary admin layer", () => {
		vi.stubEnv(ATLAS, "true");
		expect(isProjectTabVisibleToViewer("atlas", OFF, {}, {})).toBe(true);
		expect(
			resolveProjectTabs([{ id: "overview" }, { id: "atlas" }], {
				gates: OFF,
			}).map((t) => t.id),
		).toEqual(["overview", "atlas"]);
		expect(
			resolveProjectTabs([{ id: "overview" }, { id: "atlas" }], {
				config: { overrides: { atlas: false } },
				gates: OFF,
			}).map((t) => t.id),
		).toEqual(["overview"]);
	});
});

describe("feature-flag availability ceiling — the runtime Publishing gate", () => {
	const IDS = ["overview", "publishing-suite"];

	it("gate off: the tab is invisible even with an admin override", () => {
		expect(
			resolveProjectTabs(
				[{ id: "overview" }, { id: "publishing-suite" }],
				{
					config: { overrides: { "publishing-suite": true } },
					prefs: {},
					gates: OFF,
				},
			).map((t) => t.id),
		).toEqual(["overview"]);
		expect(isProjectTabFeatureEnabled("publishing-suite", OFF)).toBe(false);
		expect(resolveAdminTabState(IDS, null, OFF)).toEqual({
			overview: true,
		});
	});

	it("gate on: the tab is offered, and visible until an admin hides it", () => {
		// #1837's follow-up retired the default-hidden set, so Layer 0 is now
		// the ONLY thing between an enrolled organization and a visible tab:
		// opening the gate shows it in every project the organization owns
		// until a project admin turns it off.
		expect(isProjectTabFeatureEnabled("publishing-suite", ON)).toBe(true);
		expect(
			isProjectTabVisibleToViewer("publishing-suite", ON, {}, {}),
		).toBe(true);
		expect(
			resolveProjectTabs(
				[{ id: "overview" }, { id: "publishing-suite" }],
				{
					config: { overrides: { "publishing-suite": false } },
					gates: ON,
				},
			).map((t) => t.id),
		).toEqual(["overview"]);
	});

	it("the runtime gate does not leak into the env-gated tabs", () => {
		// A gates object that accidentally answered for every tab id would
		// unlock Atlas here. Publishing ON, Atlas env OFF: Atlas must stay out.
		vi.stubEnv(ATLAS, "false");
		expect(isProjectTabFeatureEnabled("atlas", ON)).toBe(false);
	});

	it("the gate value does not change an ungated tab's answer", () => {
		// "Ignores the gates object" would overstate it: the object is still
		// validated (the resolvers throw on a malformed one). What holds is that
		// its VALUE is never consulted for a tab that carries no Layer 0 gate.
		for (const gates of [OFF, ON]) {
			expect(isProjectTabFeatureEnabled("overview", gates)).toBe(true);
			expect(isProjectTabFeatureEnabled("documents", gates)).toBe(true);
		}
	});
});
