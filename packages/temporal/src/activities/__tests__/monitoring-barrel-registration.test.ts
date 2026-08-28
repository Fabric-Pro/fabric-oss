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
const conversationSweepSrc = readFileSync(
	join(
		ACTIVITIES_DIR,
		"conversation-bundle-embedding-sweep/sweep-conversation-bundle-embeddings.ts",
	),
	"utf8",
);
const captureHelperSrc = readFileSync(
	join(__dirname, "../../lib/capture-conversation-bundle.ts"),
	"utf8",
);

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

	/**
	 * The conversation-bundle recovery sweep (Fizzy #2228, U11) is the shape
	 * this file exists for: a workflow proxies it from its SUB-barrel, so
	 * type-checking passes whether or not the top-level barrel re-exports it,
	 * and an omission only surfaces as a scheduled execution that fails at its
	 * first tick.
	 */
	it("re-exports every conversation-bundle sweep activity from the top-level barrel", () => {
		const declared = [
			...conversationSweepSrc.matchAll(/export async function (\w+)/g),
		].map((match) => match[1]);

		expect(declared).toContain("sweepConversationBundleEmbeddingsActivity");
		const missing = declared.filter(
			(name) => !new RegExp(`\\b${name}\\b`).test(topLevelSrc),
		);
		expect(missing).toEqual([]);
	});

	/**
	 * And the exact converse, which is just as load-bearing. The worker
	 * registers EVERYTHING the top-level barrel exports as an activity, so the
	 * capture helper — a plain function called inline from activities that are
	 * already registered — must stay out of it. Re-exporting it would register
	 * two activities that nothing proxies and give the sweep a second, subtly
	 * different entry point.
	 */
	it("keeps the inline capture helper OUT of the barrel", () => {
		const helpers = [
			...captureHelperSrc.matchAll(/export async function (\w+)/g),
		].map((match) => match[1]);

		expect(helpers).toEqual(
			expect.arrayContaining([
				"captureChannelConversationBundle",
				"embedConversationBundle",
			]),
		);
		for (const name of helpers) {
			expect(topLevelSrc).not.toContain(name);
		}
	});
});
