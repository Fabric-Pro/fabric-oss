/** The query value that opens the Personal tab of the AI Providers page. */
export const PERSONAL_AI_PROVIDERS_TAB = "personal";

/**
 * Where a member manages their OWN AI provider keys and ChatGPT plan: the
 * Personal tab of the organization's AI Providers page (Fizzy #3082).
 * Relative to an organization's base path, for `useContextPath` and friends.
 */
export const PERSONAL_AI_PROVIDERS_PATH = `settings/ai-providers?tab=${PERSONAL_AI_PROVIDERS_TAB}`;
