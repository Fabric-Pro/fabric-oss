/**
 * Every starter of `orchestratorExecutionWorkflow` must bound the run.
 *
 * This is a drift guard, not a unit test, because the defect it prevents is a
 * MISSING call-site rather than a wrong one. The interactive chat starter was
 * fixed first on the stated belief that it was "the only caller that omitted
 * it"; that belief was wrong — two more starters were unbounded, including a
 * fire-and-forget one triggered by a story column transition, where nothing
 * watches the run at all and a wedge is therefore completely invisible.
 *
 * A per-site test would have passed while the other sites stayed broken. Only
 * enumerating the call sites catches the next one.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOTS = [
	resolve(__dirname, "../../../../apps/web"),
	resolve(__dirname, "../../../../packages/api"),
];

const SKIP_DIRS = new Set([
	"node_modules",
	".next",
	"dist",
	"__tests__",
	".turbo",
]);

function walk(dir: string, out: string[] = []): string[] {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (SKIP_DIRS.has(entry)) {
			continue;
		}
		const full = join(dir, entry);
		let s: ReturnType<typeof statSync>;
		try {
			s = statSync(full);
		} catch {
			continue;
		}
		if (s.isDirectory()) {
			walk(full, out);
		} else if (/\.tsx?$/.test(entry)) {
			out.push(full);
		}
	}
	return out;
}

/**
 * A `workflow.start("orchestratorExecutionWorkflow", { … })` call, with the
 * options object that follows it. Deliberately crude: it only has to be good
 * enough to notice a new call site, and a false positive here is a cheap
 * conversation while a false negative is another invisible wedge.
 */
function findStarters(source: string): string[] {
	const blocks: string[] = [];
	const marker = '"orchestratorExecutionWorkflow"';
	let idx = source.indexOf(marker);
	while (idx !== -1) {
		// Only `client.workflow.start(...)` sites — `executeChild` and re-exports
		// are bounded elsewhere or are not start calls.
		const before = source.slice(Math.max(0, idx - 200), idx);
		if (
			/workflow\s*\.\s*start\s*\(\s*$/.test(before.replace(/\s+$/, "\n"))
		) {
			blocks.push(source.slice(idx, idx + 1400));
		} else if (/workflow\s*\.\s*start\s*\(/.test(before)) {
			blocks.push(source.slice(idx, idx + 1400));
		}
		idx = source.indexOf(marker, idx + 1);
	}
	return blocks;
}

describe("orchestratorExecutionWorkflow starters are bounded", () => {
	const files = ROOTS.flatMap((r) => walk(r));

	it("finds the known start sites (guard is actually scanning something)", () => {
		const withStarters = files.filter((f) =>
			readFileSync(f, "utf8").includes('"orchestratorExecutionWorkflow"'),
		);
		// If this drops to zero the guard has silently stopped guarding.
		expect(withStarters.length).toBeGreaterThanOrEqual(3);
	});

	it("every start call passes workflowExecutionTimeout", () => {
		const unbounded: string[] = [];
		for (const file of files) {
			const src = readFileSync(file, "utf8");
			if (!src.includes('"orchestratorExecutionWorkflow"')) {
				continue;
			}
			for (const block of findStarters(src)) {
				if (!block.includes("workflowExecutionTimeout")) {
					unbounded.push(
						file.replace(/\\/g, "/").split("/apps/").pop() ?? file,
					);
				}
			}
		}
		expect(unbounded).toEqual([]);
	});
});
