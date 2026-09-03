import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeProjectTabPrefs } from "@repo/database/src/project-tabs";
import { describe, expect, it } from "vitest";
import {
	isProjectTabFeatureEnabled,
	type ProjectTabGates,
	resolveAdminTabState,
	resolveProjectTabPaint,
	resolveProjectTabs,
} from "../../../../modules/saas/projects/lib/project-tab-preferences";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../../../..");

/** Minimal stand-in for ProjectDetails' tab metadata (only `id` matters). */
const meta = (ids: string[]) => ids.map((id) => ({ id, label: id }));

/**
 * This suite is about layers 1-3 (defaults, admin overrides, personal prefs).
 * Publishing Suite is switched ON here so its Layer 0 ceiling never silently
 * removes it from a fixture and makes a layer-1 assertion pass for the wrong
 * reason. Layer 0 itself is covered in project-tab-feature-gate.test.ts.
 */
const GATES: ProjectTabGates = { publishingSuiteEnabled: true };

describe("resolveProjectTabs", () => {
	// None of these ids is feature-gated, so this suite stays pure layer-1/2
	// behaviour (the flag suite below covers layer 0).
	const ALL = ["overview", "documents", "decisions", "reports", "settings"];

	it("shows every offered tab when nothing is configured", () => {
		const resolved = resolveProjectTabs(meta(ALL), { gates: GATES });
		expect(resolved.map((t) => t.id)).toEqual(ALL);
	});

	it("an admin override can restore a tab an earlier admin hid", () => {
		const hidden = resolveProjectTabs(meta(ALL), {
			gates: GATES,
			config: { overrides: { decisions: false } },
		});
		expect(hidden.map((t) => t.id)).not.toContain("decisions");

		const restored = resolveProjectTabs(meta(ALL), {
			gates: GATES,
			config: { overrides: { decisions: true } },
		});
		expect(restored.map((t) => t.id)).toContain("decisions");
	});

	it("an admin override can hide a default-visible tab for everyone", () => {
		const resolved = resolveProjectTabs(meta(ALL), {
			gates: GATES,
			config: { overrides: { reports: false } },
		});
		expect(resolved.map((t) => t.id)).not.toContain("reports");
	});

	it("protected tabs ignore an admin override that would hide them", () => {
		const resolved = resolveProjectTabs(meta(ALL), {
			gates: GATES,
			config: { overrides: { overview: false, settings: false } },
		});
		expect(resolved.map((t) => t.id)).toEqual(
			expect.arrayContaining(["overview", "settings"]),
		);
	});

	it("a personal hidden entry removes an otherwise-visible tab", () => {
		const resolved = resolveProjectTabs(meta(ALL), {
			gates: GATES,
			prefs: { hidden: ["documents"] },
		});
		expect(resolved.map((t) => t.id)).not.toContain("documents");
	});

	it("an admin-disabled tab stays hidden regardless of personal preferences", () => {
		const resolved = resolveProjectTabs(meta(ALL), {
			gates: GATES,
			config: { overrides: { decisions: false } },
			prefs: { hidden: [], order: [] },
		});
		expect(resolved.map((t) => t.id)).not.toContain("decisions");
	});

	it("applies the saved order and appends unlisted tabs in default order", () => {
		const resolved = resolveProjectTabs(meta(ALL), {
			gates: GATES,
			prefs: { order: ["reports", "overview"] },
		});
		const ids = resolved.map((t) => t.id);
		expect(ids.slice(0, 2)).toEqual(["reports", "overview"]);
		// Everything else keeps its relative default sequence after them.
		expect(ids.slice(2)).toEqual(["documents", "decisions", "settings"]);
	});

	it("drops order entries that are hidden, unknown, or duplicated", () => {
		const resolved = resolveProjectTabs(meta(ALL), {
			gates: GATES,
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
			gates: GATES,
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

		const noConfig = resolveProjectTabs(meta(live), { gates: GATES }).map(
			(t) => t.id,
		);
		// Feature-gated tabs (layer 0) are also "accounted for": the runner's
		// env leaves the `NEXT_PUBLIC_*` ones off, and the runtime-gated ones
		// answer from `GATES` — either way that is their intended default
		// state, not a tab this resolver dropped.
		const accountedFor = new Set([
			...noConfig,
			...live.filter((id) => !isProjectTabFeatureEnabled(id, GATES)),
		]);
		for (const id of live) {
			expect(
				accountedFor.has(id),
				`tab "${id}" vanished under default resolution`,
			).toBe(true);
		}

		// Admin overrides can force-show every FEATURE-ENABLED tab; layer-0
		// disabled tabs are the ceiling and stay hidden even then.
		const enabledIds = live.filter((id) =>
			isProjectTabFeatureEnabled(id, GATES),
		);
		const allShown = resolveProjectTabs(meta(live), {
			gates: GATES,
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
		const state = resolveAdminTabState(
			IDS,
			{ overrides: { overview: false, settings: false } },
			GATES,
		);
		expect(state.overview).toBe(true);
		expect(state.settings).toBe(true);
	});

	it("reflects stored overrides in both directions", () => {
		const state = resolveAdminTabState(
			IDS,
			{ overrides: { decisions: true, documents: false } },
			GATES,
		);
		expect(state.decisions).toBe(true);
		expect(state.documents).toBe(false);
	});

	it("marks every offered tab visible without overrides", () => {
		const state = resolveAdminTabState(IDS, null, GATES);
		expect(state).toEqual({
			overview: true,
			documents: true,
			decisions: true,
			settings: true,
		});
	});
});

describe("resolveProjectTabPaint", () => {
	it("paints both halves when the viewer stored nothing", () => {
		expect(resolveProjectTabPaint("stories", null)).toEqual({
			showIcon: true,
			showTitle: true,
		});
	});

	it("drops the title for a tab the viewer set to icon", () => {
		expect(
			resolveProjectTabPaint("stories", { display: { stories: "icon" } }),
		).toEqual({ showIcon: true, showTitle: false });
	});

	it("drops the icon for a tab the viewer set to title", () => {
		expect(
			resolveProjectTabPaint("stories", {
				display: { stories: "title" },
			}),
		).toEqual({ showIcon: false, showTitle: true });
	});

	it("leaves other tabs alone", () => {
		const prefs = { display: { stories: "icon" } };
		expect(resolveProjectTabPaint("documents", prefs)).toEqual({
			showIcon: true,
			showTitle: true,
		});
	});

	it("falls back to both halves on a malformed payload", () => {
		// A blank button is the worst possible degradation, so the tolerant
		// path has to land on "show everything", never on "show nothing".
		for (const junk of ["garbage", 42, { display: "nope" }, undefined]) {
			expect(resolveProjectTabPaint("stories", junk)).toEqual({
				showIcon: true,
				showTitle: true,
			});
		}
	});
});

describe("sanitizeProjectTabPrefs", () => {
	it("refuses to store a protected tab as hidden", () => {
		// The dialog cannot produce this; a direct PATCH can, and the column
		// outlives whichever client wrote it.
		expect(
			sanitizeProjectTabPrefs({ hidden: ["overview", "reports"] }),
		).toEqual({ hidden: ["reports"] });
	});

	it("drops a paint entry for a tab that is hidden", () => {
		expect(
			sanitizeProjectTabPrefs({
				hidden: ["reports"],
				display: { reports: "icon", stories: "title" },
			}),
		).toEqual({ hidden: ["reports"], display: { stories: "title" } });
	});

	it("keeps a paint entry once the tab stops being hidden", () => {
		expect(
			sanitizeProjectTabPrefs({
				hidden: [],
				display: { stories: "icon" },
			}),
		).toEqual({ hidden: [], display: { stories: "icon" } });
	});

	it("leaves order and absent keys alone", () => {
		expect(sanitizeProjectTabPrefs({ order: ["a", "b"] })).toEqual({
			order: ["a", "b"],
		});
	});
});
