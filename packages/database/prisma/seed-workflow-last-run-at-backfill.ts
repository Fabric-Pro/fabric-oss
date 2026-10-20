import { backfillWorkflowLastRunAt } from "../scripts/backfill-workflow-last-run-at";
import { db } from "./client";

// The deploy runner records the wrapper and implementation hash only on success.
backfillWorkflowLastRunAt({ apply: true })
	.catch((error) => {
		console.error("Workflow last-run backfill failed:", error);
		process.exitCode = 1;
	})
	.finally(() => db.$disconnect());
