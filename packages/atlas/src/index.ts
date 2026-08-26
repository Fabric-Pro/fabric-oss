/**
 * @repo/atlas — the single entry point for the "Atlas"
 * feature: analysing a connected repository into an AI-described dependency
 * graph (Technical + Business lenses) and a graph-grounded AI chat.
 *
 * `AtlasService` is the facade — every consumer (oRPC procedures,
 * Temporal activities, and the web layer's type imports) routes through it, so
 * `findReferences(AtlasService)` enumerates the whole feature.
 */

export {
	type EnsureFreshRepoCredentialsInput,
	type EnsureFreshResult,
	ensureFreshRepoCredentials,
} from "./credentials";
export * from "./errors";
export * from "./schemas";
export { AtlasService } from "./service";
export * from "./types";
export * from "./workflow";
