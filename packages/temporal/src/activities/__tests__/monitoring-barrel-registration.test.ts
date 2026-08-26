/**
 * Guards worker activity registration.
 *
 * `worker.ts` registers activities via `import * as activities from
 * "./activities"` — the TOP-LEVEL barrel. An activity exported only from a
 * sub-barrel (e.g. `activities/monitoring`) but not re-exported here is never
 * registered, so any workflow `proxyActivities` call for it fails at RUNTIME
 * while type-checking still passes (the workflow imports its types from the
 * sub-barrel). This is precisely how the AC-9 project service-alert digest
 * activity shipped unregistered the first time.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ACTIVITIES_DIR = join(__dirname, "..");
const monitoringSrc = readFileSync(
	join(ACTIVITIES_DIR, "monitoring/index.ts"),
	"utf8",
);
const topLevelSrc = readFileSync(join(ACTIVITIES_DIR, "index.ts"), "utf8");

/** Extract runtime (non-`type`) named exports from `export { ... } from "..."` blocks. */
function runtimeExports(src: string): string[] {
	const names = new Set<string>();
	const blockRe = /export\s*\{([\s\S]*?)\}\s*from/g;
	let match: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
	while ((match = blockRe.exec(src)) !== null) {
		for (const raw of match[1].split(",")) {
			const entry = raw.trim();
			if (!entry || entry.startsWith("type ")) {
				continue;
			}
			const name = entry.split(/\s+as\s+/)[0].trim();
			if (name) {
				names.add(name);
			}
		}
	}
	return [...names];
}

describe("activities barrel registration (worker discovery)", () => {
	it("re-exports every monitoring activity from the top-level barrel", () => {
		const missing = runtimeExports(monitoringSrc).filter(
			(name) => !new RegExp(`\\b${name}\\b`).test(topLevelSrc),
		);
		expect(missing).toEqual([]);
	});

	it("registers the AC-9 project service-alert digest activity", () => {
		expect(topLevelSrc).toContain(
			"dispatchProjectServiceAlertDigestActivity",
		);
	});
});
