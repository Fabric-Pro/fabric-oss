/**
 * The session hook's "changed since your last sync" line: computed from the
 * lock's previous version and the files the run wrote, never from server state.
 */
import { describe, expect, it } from "vitest";
import { changedSinceLastSyncLine } from "../src/lib/instructions/since-last-sync.js";

const base = {
	previousVersion: 3,
	version: 5,
	dryRun: false,
	added: [] as string[],
	updated: [] as string[],
	replaced: [] as string[],
	removed: [] as string[],
};

describe("changedSinceLastSyncLine", () => {
	it("names the files a new version changed and both versions", () => {
		expect(
			changedSinceLastSyncLine({
				...base,
				added: ["skills/new.md"],
				updated: ["CLAUDE.md"],
			}),
		).toBe(
			"fabric: 2 instruction files changed since your last sync (v3 → v5): CLAUDE.md, skills/new.md",
		);
	});

	it("names three files and counts the rest", () => {
		expect(
			changedSinceLastSyncLine({
				...base,
				updated: ["d.md", "a.md", "c.md"],
				removed: ["b.md", "e.md"],
			}),
		).toBe(
			"fabric: 5 instruction files changed since your last sync (v3 → v5): a.md, b.md, c.md and 2 more",
		);
	});

	it("uses the singular for one file", () => {
		expect(
			changedSinceLastSyncLine({ ...base, replaced: ["AGENTS.md"] }),
		).toBe(
			"fabric: 1 instruction file changed since your last sync (v3 → v5): AGENTS.md",
		);
	});

	it("says nothing on a first sync, a dry run, the same version, or no file change", () => {
		const changed = { ...base, updated: ["CLAUDE.md"] };
		expect(
			changedSinceLastSyncLine({ ...changed, previousVersion: null }),
		).toBeNull();
		expect(
			changedSinceLastSyncLine({ ...changed, dryRun: true }),
		).toBeNull();
		expect(changedSinceLastSyncLine({ ...changed, version: 3 })).toBeNull();
		expect(changedSinceLastSyncLine(base)).toBeNull();
	});
});
