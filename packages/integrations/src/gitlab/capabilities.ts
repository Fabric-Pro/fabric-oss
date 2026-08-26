/**
 * Single source of truth for GitLab REST PM capabilities.
 * Imported by API procedures and Temporal activities — never duplicate the shape.
 *
 * REST-GitLab supports story-level push/pull but NOT task-level sync
 * (syncTaskToPM has no REST path), so `supportsTaskSync` is intentionally false.
 *
 * Note: `canFetch` is consumed by internal Temporal activities (story-sync,
 * pm-tool-fallback) but is intentionally NOT exposed in the public
 * `getPMCapabilities` Zod output schema. Callers that ship this object to
 * the API surface should explicitly destructure it (see get-pm-capabilities.ts)
 * so the omission is visible at the call site rather than relying on Zod's
 * silent `.strip()`. Adding it to the API surface is a deliberate future
 * contract change, not an accident of this constant.
 */
export const GITLAB_REST_CAPABILITIES = Object.freeze({
	hasPMCapabilities: true,
	canCreate: true,
	canUpdate: true,
	canGet: true,
	canList: true,
	canFetch: true,
	supportsPush: true,
	supportsPull: true,
	supportsTaskSync: false,
} as const);

export type GitLabRestCapabilities = typeof GITLAB_REST_CAPABILITIES;
