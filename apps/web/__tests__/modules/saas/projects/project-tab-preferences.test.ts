import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	isProjectTabFeatureEnabled,
	resolveAdminTabState,
	resolveProjectTabs,
} from "../../../../modules/saas/projects/lib/project-tab-preferences";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../../../..");

/** Minimal stand-in for ProjectDetails' tab metadata (only `id` matters). */
const meta = (ids: string[]) => ids.map((id) => ({ id, label: id }));

describe("resolveProjectTabs", () => {
	// None of these ids is feature-gated, so this suite stays pure layer-1/2
	// behaviour (the flag suite below covers layer 0).
	const ALL = ["overview", "documents", "decisions", "reports", "settings"];

	it("shows every offered tab when nothing is configured", () => {
		const resolved = resolveProjectTabs(meta(ALL), {});
		expect(resolved.map((t) => t.id)).toEqual(ALL);
	});

	it("an admin override can restore a tab an earlier admin hid", () => {
		const hidden = resolveProjectTabs(meta(ALL), {
			config: { overrides: { decisions: false } },
		});
		expect(hidden.map((t) => t.id)).not.toContain("decisions");

		const restored = resolveProjectTabs(meta(ALL), {
			config: { overrides: { decisions: true } },
		});
		expect(restored.map((t) => t.id)).toContain("decisions");
	});

	it("an admin override can hide a default-visible tab for everyone", () => {
		const resolved = resolveProjectTabs(meta(ALL), {
			config: { overrides: { reports: false } },
		});
		expect(resolved.map((t) => t.id)).not.toContain("reports");
	});

	it("protected tabs ignore an admin override that would hide them", () => {
		const resolved = resolveProjectTabs(meta(ALL), {
			config: { overrides: { overview: false, settings: false } },
		});
		expect(resolved.map((t) => t.id)).toEqual(
			expect.arrayContaining(["overview", "settings"]),
		);
	});

	it("a personal hidden entry removes an otherwise-visible tab", () => {
		const resolved = resolveProjectTabs(meta(ALL), {
			prefs: { hidden: ["documents"] },
		});
		expect(resolved.map((t) => t.id)).not.toContain("documents");
	});

	it("an admin-disabled tab stays hidden regardless of personal preferences", () => {
		const resolved = resolveProjectTabs(meta(ALL), {
			config: { overrides: { decisions: false } },
			prefs: { hidden: [], order: [] },
		});
		expect(resolved.map((t) => t.id)).not.toContain("decisions");
	});

	it("applies the saved order and appends unlisted tabs in default order", () => {
		const resolved = resolveProjectTabs(meta(ALL), {
			prefs: { order: ["reports", "overview"] },
		});
		const ids = resolved.map((t) => t.id);
		expect(ids.slice(0, 2)).toEqual(["reports", "overview"]);
		// Everything else keeps its relative default sequence after them.
		expect(ids.slice(2)).toEqual(["documents", "decisions", "settings"]);
	});

	it("drops order entries that are hidden, unknown, or duplicated", () => {
		const resolved = resolveProjectTabs(meta(ALL), {
			config: { overrides: { reports: false } },
			prefs: {
				order: [
					"ghost-tab",
					"reports",
					"settings",
					"settings",
					"documents",
				],
			},
		});
		expect(resolved.map((t) => t.id)).toEqual([
			"settings",
			"documents",
			"overview",
			"decisions",
		]);
	});

	it("tolerates malformed config/prefs payloads as 'nothing configured'", () => {
		const resolved = resolveProjectTabs(meta(ALL), {
			config: "garbage",
			prefs: 42,
		});
		expect(resolved.map((t) => t.id)).toEqual(ALL);
	});
});

describe("future-tab coverage (new tabs need no wiring)", () => {
	/**
	 * The canonical live tab ids, parsed from ProjectDetails' source exactly
	 * like the get-started drift test does. A new tab added there must flow
	 * through this resolver without any per-tab change — this guard fails if
	 * resolution ever drops one silently.
	 */
	function liveProjectTabIds(): string[] {
		const source = readFileSync(
			path.resolve(
				repoRoot,
				"apps/web/modules/saas/projects/lib/project-tabs.ts",
			),
			"utf8",
		);
		const start = source.indexOf("const tabs = [");
		const end = source.indexOf("] as const;", start);
		const ids: string[] = [];
		for (const line of source.slice(start, end).split("\n")) {
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

	it("resolves every live tab this deployment offers", () => {
		const live = liveProjectTabIds();
		expect(live.length).toBeGreaterThanOrEqual(15); // extractor self-check

		const noConfig = resolveProjectTabs(meta(live), {}).map((t) => t.id);
		// Feature-gated tabs (layer 0) are also "accounted for": the runner's
		// env leaves them off, which is exactly their intended default state.
		const accountedFor = new Set([
			...noConfig,
			...live.filter((id) => !isProjectTabFeatureEnabled(id)),
		]);
		for (const id of live) {
			expect(
				accountedFor.has(id),
				`tab "${id}" vanished under default resolution`,
			).toBe(true);
		}

		// Admin overrides can force-show every FEATURE-ENABLED tab; layer-0
		// disabled tabs are the ceiling and stay hidden even then.
		const enabledIds = live.filter((id) => isProjectTabFeatureEnabled(id));
		const allShown = resolveProjectTabs(meta(live), {
			config: {
				overrides: Object.fromEntries(
					enabledIds.map((id) => [id, true]),
				),
			},
		}).map((t) => t.id);
		expect(new Set(allShown)).toEqual(new Set(enabledIds));
	});
});

describe("resolveAdminTabState", () => {
	const IDS = ["overview", "documents", "decisions", "settings"];

	it("marks protected tabs visible no matter what is stored", () => {
		const state = resolveAdminTabState(IDS, {
			overrides: { overview: false, settings: false },
		});
		expect(state.overview).toBe(true);
		expect(state.settings).toBe(true);
	});

	it("reflects stored overrides in both directions", () => {
		const state = resolveAdminTabState(IDS, {
			overrides: { decisions: true, documents: false },
		});
		expect(state.decisions).toBe(true);
		expect(state.documents).toBe(false);
	});

	it("marks every offered tab visible without overrides", () => {
		const state = resolveAdminTabState(IDS, null);
		expect(state).toEqual({
			overview: true,
			documents: true,
			decisions: true,
			settings: true,
		});
	});
});
