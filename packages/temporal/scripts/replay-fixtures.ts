import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HistoryAndWorkflowId } from "@temporalio/client";
import { historyFromJSON } from "@temporalio/common/lib/proto-utils";
import { hasWorkflowTaskToReplay } from "./replay-history";

type FixtureFile = {
	workflowId: string;
	runId?: string;
	bucket?: "closed" | "running";
	history: unknown;
};

export async function loadHistoriesForType(
	fixturesDir: string,
	workflowType: string,
	requireFixtures = false,
): Promise<HistoryAndWorkflowId[]> {
	const dir = join(fixturesDir, workflowType);
	const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
	const loaded = await Promise.all(
		files.map(async (file) => {
			const raw = await readFile(join(dir, file), "utf8");
			const parsed = JSON.parse(raw) as FixtureFile;
			// Preserve the original workflowId — workflows that branch on
			// workflowInfo().workflowId (e.g. project-document-generation,
			// code-indexing) would either false-positive or mask real
			// non-determinism if we fed them a synthetic ID derived from the
			// sanitized filename.
			return {
				workflowId: parsed.workflowId,
				history: historyFromJSON(parsed.history),
			};
		}),
	);
	const histories = loaded.filter(({ history }) =>
		hasWorkflowTaskToReplay(history),
	);
	const dropped = loaded.length - histories.length;
	if (dropped > 0) {
		console.log(
			`[replay] ${workflowType}: dropped ${dropped} histories with no started workflow task`,
		);
		if (histories.length === 0 && requireFixtures) {
			throw new Error(
				`${workflowType}: fetch wrote histories with no workflow task started, which it should have excluded; no loadable histories remain for replay coverage.`,
			);
		}
	}
	return histories;
}
