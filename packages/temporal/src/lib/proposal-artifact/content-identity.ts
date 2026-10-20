/**
 * The document body identity moved to `@repo/utils/content-identity`, where
 * the document queries and procedures share it with the run (Fizzy #2946).
 * Re-exported here so the activities keep their import.
 *
 * Activities only: it reads `node:crypto`, which a workflow bundle cannot.
 */
export { contentIdentity } from "@repo/utils/content-identity";
