/**
 * The vocabulary of a generation-queue explanation — CLIENT-SAFE.
 *
 * Deliberately free of imports of any kind, for the same reason and under the
 * same constraint as `document-dependency-graph.ts`: the browser bundle that
 * renders a queued document's card needs this union, and the module that
 * PRODUCES the values (`prisma/queries/projects/generation-dependencies.ts`)
 * pulls in the generated Prisma client. Written twice, the two copies drift
 * silently — a category the probe starts emitting renders at the reader as an
 * "unknown" fallback, which is exactly the failure that reads like nothing
 * being wrong.
 *
 * DO NOT re-export this through the queries barrel to save the deep import;
 * that barrel carries the whole database surface.
 */

/**
 * A handful of coarse buckets, and deliberately nothing finer.
 *
 * A category is all the user ever sees for a wait, which is the point: the
 * probe reads across a project's whole surface — uploaded files, a connected
 * repository, a crawled site, chat monitors, sibling documents — and some of
 * those rows belong to sources the requester cannot open. A per-project guest
 * asked to wait for a private repository learns its name, from a screen that
 * was only ever meant to say "not yet".
 *
 * So an entry carries a category and a count and has no room for anything else.
 * That is a shape, not a habit: there is no field to accidentally put a path, a
 * filename, a channel or a document title in, so no future edit can leak one
 * without changing this type and tripping the test that walks every returned
 * entry's keys.
 */
export const GENERATION_DEPENDENCY_CATEGORIES = [
	"codebaseIndexing",
	"sourceExtraction",
	"linkedSiteCrawl",
	"securityScan",
	"monitorIngestion",
	"projectManagementScan",
	"prerequisiteDocument",
] as const;

export type GenerationDependencyCategory =
	(typeof GENERATION_DEPENDENCY_CATEGORIES)[number];
