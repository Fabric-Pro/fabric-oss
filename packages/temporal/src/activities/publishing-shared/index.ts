/**
 * Helpers shared by the publishing generation families (Publishing Suite, Fizzy
 * #1853).
 *
 * Nothing here is an activity, and this barrel is deliberately NOT re-exported
 * from `activities/index.ts` — that file is what the worker registers, so every
 * name it reaches becomes a function Temporal can be asked to schedule.
 */

export { assertGenerationActorAuthorized } from "./assert-generation-actor";
export { resolveContributorNames } from "./contributor-names";
