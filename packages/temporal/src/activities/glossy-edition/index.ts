/**
 * Glossy edition build activities (Fizzy #2589). Activity functions and
 * types only: the worker registers every function the activities barrel
 * exports, so the helpers in `shared.ts` and the planners stay unexported.
 */

export { detectGlossyOpportunitiesActivity } from "./detect";
export { extractGlossyVisualActivity } from "./extract-visual";
export { failGlossyBuildActivity } from "./fail-build";
export { finalizeGlossyBuildActivity } from "./finalize-build";
export { prepareGlossyBuildActivity } from "./prepare-build";
export { rewriteGlossySectionActivity } from "./rewrite-section";
export type * from "./types";
