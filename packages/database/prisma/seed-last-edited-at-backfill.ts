/**
 * Deploy entry for the one-time `UserStory.lastEditedAt` backfill.
 *
 * `deploy-seeds.ts` runs each entry only when its content hash changes and
 * records that hash, so this executes once per environment rather than on every
 * deploy. The backfill is idempotent regardless — it only touches rows whose
 * clock is still null — so a forced re-run is safe.
 *
 * The logic lives in `scripts/backfill-last-edited-at.ts`, which is also the
 * manual CLI (dry-run by default). This wrapper exists because the deploy runner
 * invokes seeds with no arguments, and a backfill that silently dry-ran during a
 * release would look like it had succeeded while doing nothing.
 */
import { backfillLastEditedAt } from "../scripts/backfill-last-edited-at";
import { db } from "./client";

backfillLastEditedAt({ apply: true })
	.catch((error) => {
		console.error("lastEditedAt backfill failed:", error);
		process.exitCode = 1;
	})
	.finally(async () => {
		await db.$disconnect();
	});
