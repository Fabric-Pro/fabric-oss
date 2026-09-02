import { afterEach, describe, expect, it, vi } from "vitest";
import {
	isProjectTabFeatureEnabled,
	isProjectTabVisibleToViewer,
	resolveAdminTabState,
	resolveProjectTabs,
} from "../../../../modules/saas/projects/lib/project-tab-preferences";

/**
 * Layer 0 of tab resolution (card #1837): the per-deployment feature-flag
 * ceiling. Flag reads are lazy functions, so vi.stubEnv applies without
 * module reloads. Atlas stands in for "feature-gated tab" (its gate predates
 * customization); documents for an ungated one.
 */

const ATLAS = "NEXT_PUBLIC_FABRIC_FEATURE_ATLAS";

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("feature-flag availability ceiling", () => {
	const IDS = ["overview", "atlas"];

	it("flag off: gated tab is invisible even when admin and user opted in", () => {
		vi.stubEnv(ATLAS, "false");
		const resolved = resolveProjectTabs(
			[{ id: "overview" }, { id: "atlas" }],
			{
				config: { overrides: { atlas: true } },
				prefs: {},
			},
		);
		expect(resolved.map((t) => t.id)).toEqual(["overview"]);
		expect(isProjectTabVisibleToViewer("atlas", {}, {})).toBe(false);
		expect(isProjectTabFeatureEnabled("atlas")).toBe(false);
	});

	it("legacy env name still unlocks the gated tab", () => {
		vi.stubEnv("NEXT_PUBLIC_FABRIC_FEATURE_CODE_UNDERSTANDING", "true");
		expect(isProjectTabFeatureEnabled("atlas")).toBe(true);
		// Unlocking the feature hands the tab to the admin layer, which shows
		// it unless an admin has hidden it.
		expect(isProjectTabVisibleToViewer("atlas", {}, {})).toBe(true);
		expect(
			isProjectTabVisibleToViewer(
				"atlas",
				{ overrides: { atlas: false } },
				{},
			),
		).toBe(false);
	});

	it("resolveAdminTabState omits feature-disabled tabs entirely", () => {
		vi.stubEnv(ATLAS, "false");
		expect(resolveAdminTabState(IDS, null)).toEqual({
			overview: true,
		});
	});

	it("flag on: the gated tab obeys the ordinary admin layer", () => {
		vi.stubEnv(ATLAS, "true");
		expect(isProjectTabVisibleToViewer("atlas", {}, {})).toBe(true);
		expect(
			resolveProjectTabs([{ id: "overview" }, { id: "atlas" }], {}).map(
				(t) => t.id,
			),
		).toEqual(["overview", "atlas"]);
		expect(
			resolveProjectTabs([{ id: "overview" }, { id: "atlas" }], {
				config: { overrides: { atlas: false } },
			}).map((t) => t.id),
		).toEqual(["overview"]);
	});
});
