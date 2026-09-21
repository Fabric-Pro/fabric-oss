/**
 * Shape of `Project.pmStatusSyncLastRun`: what the last PM → Fabric status
 * sync did, as the project's PM settings card shows it (Fizzy #2304, spec
 * D2.6). Every writer builds through this schema and the card parses through
 * it, so the two cannot drift.
 *
 * Pure (zod only) so a client component can import it from
 * `@repo/database/src/pm-status-sync-last-run-schema` without pulling in the
 * Prisma client. `prisma/queries/pm-status-sync-last-run.ts` re-exports it
 * beside the writer, and `@repo/database` exports both.
 *
 * The outcome keys restate `StatusSyncOutcome` from `@repo/integrations/pm`
 * structurally, because this package cannot import integrations. A type test
 * on the integrations side pins the two to the same set.
 */
import { z } from "zod";

const count = z.number().int().nonnegative();
const timestamp = z.string().datetime();

export interface PmStatusSyncLastRun {
	/** ISO start of the sync session this summary belongs to. */
	sessionAt: string;
	fetch?: {
		at: string;
		linked: number;
		fetched: number;
		failed: number;
		notFound: number;
		complete: boolean;
	};
	failure?: {
		at: string;
		kind: "fetch-failed" | "source-not-found";
		error: string;
	};
	outcome?: {
		at: string;
		counts: {
			moved: number;
			unchanged: number;
			"fabric-ahead": number;
			"not-mapped": number;
			ambiguous: number;
			unverified: number;
			stale: number;
			"skipped-conflict": number;
			raced: number;
		};
	};
}

export const pmStatusSyncLastRunSchema: z.ZodType<PmStatusSyncLastRun> =
	z.object({
		sessionAt: timestamp,
		fetch: z
			.object({
				at: timestamp,
				linked: count,
				fetched: count,
				failed: count,
				notFound: count,
				complete: z.boolean(),
			})
			.optional(),
		failure: z
			.object({
				at: timestamp,
				kind: z.enum(["fetch-failed", "source-not-found"]),
				error: z.string(),
			})
			.optional(),
		outcome: z
			.object({
				at: timestamp,
				counts: z.object({
					moved: count,
					unchanged: count,
					"fabric-ahead": count,
					"not-mapped": count,
					ambiguous: count,
					unverified: count,
					stale: count,
					"skipped-conflict": count,
					raced: count,
				}),
			})
			.optional(),
	});
