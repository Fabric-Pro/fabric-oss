/**
 * The names of the `WorkflowIntegration` rows that hold a provider's OAuth
 * client credentials.
 *
 * `saveAppCredentials` stores a provider's OAuth client id and secret in a
 * `WorkflowIntegration` named `<PROVIDER>_OAUTH_APP`. That row shares
 * provider, user and organization with the user's connection rows; only the
 * name tells the two apart, so every connection selector has to exclude it by
 * that exact name. A suffix match is not safe: a connection is named after the
 * account (`GitLab: <username>`), and a username may end in `_OAUTH_APP`.
 */

/**
 * Every provider `saveAppCredentials` accepts, and so every provider that can
 * have an app row. `integrations.oauth`'s provider enum is built from this
 * list, so the two cannot drift.
 */
export const OAUTH_APP_PROVIDERS = [
	"AIRTABLE",
	"ASANA",
	"BITBUCKET",
	"DROPBOX",
	"GITHUB",
	"GMAIL",
	"GITLAB",
	"GOOGLE_DRIVE",
	"HUBSPOT",
	"INTERCOM",
	"LINEAR",
	"MICROSOFT_GRAPH",
	"SLACK",
	"NOTION",
] as const;

export type OAuthAppProvider = (typeof OAUTH_APP_PROVIDERS)[number];

/** The exact reserved names, for selectors that span several providers. */
export const OAUTH_APP_ROW_NAMES: string[] = OAUTH_APP_PROVIDERS.map(
	(provider) => `${provider}_OAUTH_APP`,
);
