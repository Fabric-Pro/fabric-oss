/** Explicit worker entry point; live configuration is supplied by the operator. */

import {
	executePrivateHarnessTriage,
	markPrivateTriageFailed,
	purgeExpiredHarnessTriageContent,
} from "../packages/api/modules/projects/lib/harness-triage-host";
import {
	isHarnessTriageRetentionWorkerQualified,
	listExpiredHarnessTriageContent,
} from "../packages/database";

if (!(await isHarnessTriageRetentionWorkerQualified())) {
	throw Error(
		"Private review worker requires a qualified fabric_worker database connection.",
	);
}

import {
	createHarnessTriageActivities,
	runHarnessTriageWorker,
} from "../packages/temporal/src/lib/harness-triage-worker";

await runHarnessTriageWorker(
	createHarnessTriageActivities({
		execute: (input, workflowId, nativeRunId, signal) =>
			executePrivateHarnessTriage(
				input,
				input.runId,
				workflowId,
				nativeRunId,
				signal,
			),
		failed: (input, workflowId, nativeRunId) =>
			markPrivateTriageFailed(
				input,
				input.runId,
				workflowId,
				nativeRunId,
			),
		purge: async () => {
			const rows = await listExpiredHarnessTriageContent();
			for (const row of rows) {
				await purgeExpiredHarnessTriageContent(row, row.id);
			}
			return { purged: rows.length };
		},
	}),
);
