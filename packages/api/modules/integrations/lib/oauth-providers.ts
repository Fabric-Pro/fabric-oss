/**
 * Generic OAuth Provider Configuration
 *
 * Defines OAuth provider configurations for all OAuth-based integrations.
 * Each provider specifies its authorization, token, and API endpoints,
 * along with required scopes and user info fetching logic.
 */

export type OAuthProviderType =
	| "AIRTABLE"
	| "BITBUCKET"
	| "HUBSPOT"
	| "INTERCOM"
	| "LINEAR"
	| "ASANA"
	| "DROPBOX"
	| "GITHUB"
	| "GMAIL"
	| "GITLAB"
	| "GOOGLE_DRIVE"
	| "MICROSOFT_GRAPH"
	| "SLACK"
	| "NOTION";

export interface OAuthTokenResponse {
	access_token: string;
	token_type: string;
	scope?: string;
	refresh_token?: string;
	expires_in?: number;
	/** Slack v2 OAuth returns user-scoped token separately from the bot token */
	authed_user?: {
		id: string;
		scope?: string;
		access_token?: string;
		token_type?: string;
	};
	/** Slack v2 OAuth top-level workspace info */
	team?: {
		id: string;
		name?: string;
	};
	/** Slack v2 OAuth bot user — required to filter self-mentions / DMs */
	bot_user_id?: string;
}

interface OAuthUserInfo {
	id: string;
	login: string;
	name: string | null;
	email: string | null;
	avatarUrl: string | null;
}

export interface OAuthProviderConfig {
	type: OAuthProviderType;
	name: string;
	authorizationUrl: string;
	tokenUrl: string;
	scopes: string[];
	// Environment variable names for credentials
	clientIdEnvVar: string;
	clientSecretEnvVar: string;
	// Whether the provider supports refresh tokens
	supportsRefreshToken: boolean;
	// Whether to use basic auth for token exchange (vs POST body)
	useBasicAuthForToken?: boolean;
	// Custom headers for API requests
	apiHeaders?: Record<string, string>;
	// Function to get user info from the provider
	getUserInfo: (accessToken: string) => Promise<OAuthUserInfo>;
	// Function to refresh access token (if supported)
	refreshAccessToken?: (
		refreshToken: string,
		clientId: string,
		clientSecret: string,
	) => Promise<OAuthTokenResponse>;
	// Revoke a token at the provider on disconnect (if supported). Best-effort:
	// callers should not fail the disconnect if this throws. Implement for
	// providers that expose a revocation endpoint (e.g. Google) so disconnect
	// actually invalidates the grant rather than just dropping our copy.
	revokeAccessToken?: (accessToken: string) => Promise<void>;
	// Custom authorization URL parameters
	authParams?: Record<string, string>;
}

/**
 * Dropbox OAuth Provider Configuration
 */
const dropboxProvider: OAuthProviderConfig = {
	type: "DROPBOX",
	name: "Dropbox",
	authorizationUrl: "https://www.dropbox.com/oauth2/authorize",
	tokenUrl: "https://api.dropboxapi.com/oauth2/token",
	scopes: ["account_info.read", "files.metadata.read", "files.content.read"],
	clientIdEnvVar: "DROPBOX_CLIENT_ID",
	clientSecretEnvVar: "DROPBOX_CLIENT_SECRET",
	supportsRefreshToken: true,
	authParams: {
		token_access_type: "offline",
	},
	getUserInfo: async (accessToken: string): Promise<OAuthUserInfo> => {
		const response = await fetch(
			"https://api.dropboxapi.com/2/users/get_current_account",
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${accessToken}`,
					"Content-Type": "application/json",
				},
				body: "null",
			},
		);

		if (!response.ok) {
			throw new Error(`Failed to get Dropbox user: ${response.status}`);
		}

		const data = (await response.json()) as {
			account_id: string;
			email?: string;
			name?: {
				display_name?: string;
			};
			profile_photo_url?: string;
		};

		return {
			id: data.account_id,
			login: data.email || data.account_id,
			name: data.name?.display_name ?? null,
			email: data.email ?? null,
			avatarUrl: data.profile_photo_url ?? null,
		};
	},
	refreshAccessToken: async (
		refreshToken: string,
		clientId: string,
		clientSecret: string,
	): Promise<OAuthTokenResponse> => {
		const response = await fetch(
			"https://api.dropboxapi.com/oauth2/token",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
				},
				body: new URLSearchParams({
					client_id: clientId,
					client_secret: clientSecret,
					refresh_token: refreshToken,
					grant_type: "refresh_token",
				}),
			},
		);

		if (!response.ok) {
			throw new Error(
				`Failed to refresh Dropbox token: ${response.status}`,
			);
		}

		return response.json() as Promise<OAuthTokenResponse>;
	},
};

/**
 * GitHub OAuth Provider Configuration
 */
const githubProvider: OAuthProviderConfig = {
	type: "GITHUB",
	name: "GitHub",
	authorizationUrl: "https://github.com/login/oauth/authorize",
	tokenUrl: "https://github.com/login/oauth/access_token",
	scopes: ["repo", "read:user"],
	clientIdEnvVar: "FABRIC_GITHUB_CLIENT_ID",
	clientSecretEnvVar: "FABRIC_GITHUB_CLIENT_SECRET",
	supportsRefreshToken: true,
	revokeAccessToken: async (accessToken: string): Promise<void> => {
		// GitHub requires the client credentials to delete a token. Uses the
		// Applications API (DELETE /applications/{client_id}/token). 204 =
		// deleted; 404 = token not found (already expired/revoked) — both fine.
		// Reads FABRIC_GITHUB_* (the connect config) with a legacy fallback.
		const clientId =
			process.env.FABRIC_GITHUB_CLIENT_ID || process.env.GITHUB_CLIENT_ID;
		const clientSecret =
			process.env.FABRIC_GITHUB_CLIENT_SECRET ||
			process.env.GITHUB_CLIENT_SECRET;
		if (!clientId || !clientSecret) {
			return;
		}
		const response = await fetch(
			`https://api.github.com/applications/${clientId}/token`,
			{
				method: "DELETE",
				headers: {
					Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
					Accept: "application/vnd.github.v3+json",
					"Content-Type": "application/json",
					"User-Agent": "Fabric-App",
				},
				body: JSON.stringify({ access_token: accessToken }),
			},
		);
		if (!response.ok && response.status !== 404) {
			throw new Error(
				`Failed to revoke GitHub token: ${response.status}`,
			);
		}
	},
	refreshAccessToken: async (
		refreshToken: string,
		clientId: string,
		clientSecret: string,
	): Promise<OAuthTokenResponse> => {
		const response = await fetch(
			"https://github.com/login/oauth/access_token",
			{
				method: "POST",
				headers: {
					Accept: "application/json",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					client_id: clientId,
					client_secret: clientSecret,
					grant_type: "refresh_token",
					refresh_token: refreshToken,
				}),
			},
		);

		if (!response.ok) {
			throw new Error(
				`Failed to refresh GitHub token: ${response.status}`,
			);
		}

		const data = (await response.json()) as OAuthTokenResponse & {
			error?: string;
			error_description?: string;
		};

		if (data.error) {
			throw new Error(
				`GitHub refresh error: ${data.error_description || data.error}`,
			);
		}

		return data;
	},
	getUserInfo: async (accessToken: string): Promise<OAuthUserInfo> => {
		const response = await fetch("https://api.github.com/user", {
			headers: {
				Authorization: `Bearer ${accessToken}`,
				Accept: "application/vnd.github.v3+json",
				"User-Agent": "Fabric-App",
			},
		});

		if (!response.ok) {
			throw new Error(`Failed to get GitHub user: ${response.status}`);
		}

		const data = (await response.json()) as {
			id: number;
			login: string;
			name: string | null;
			email: string | null;
			avatar_url: string;
		};

		return {
			id: String(data.id),
			login: data.login,
			name: data.name,
			email: data.email,
			avatarUrl: data.avatar_url,
		};
	},
};

/**
 * Gmail OAuth Provider Configuration
 */
const gmailProvider: OAuthProviderConfig = {
	type: "GMAIL",
	name: "Gmail",
	authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
	tokenUrl: "https://oauth2.googleapis.com/token",
	scopes: [
		"https://www.googleapis.com/auth/gmail.readonly",
		"https://www.googleapis.com/auth/userinfo.profile",
		"https://www.googleapis.com/auth/userinfo.email",
	],
	clientIdEnvVar: "GOOGLE_CLIENT_ID",
	clientSecretEnvVar: "GOOGLE_CLIENT_SECRET",
	supportsRefreshToken: true,
	authParams: {
		access_type: "offline",
		prompt: "consent",
	},
	getUserInfo: async (accessToken: string): Promise<OAuthUserInfo> => {
		const response = await fetch(
			"https://www.googleapis.com/oauth2/v2/userinfo",
			{
				headers: {
					Authorization: `Bearer ${accessToken}`,
				},
			},
		);

		if (!response.ok) {
			throw new Error(`Failed to get Google user: ${response.status}`);
		}

		const data = (await response.json()) as {
			id: string;
			email: string;
			name: string;
			picture: string;
		};

		return {
			id: data.id,
			login: data.email,
			name: data.name,
			email: data.email,
			avatarUrl: data.picture,
		};
	},
	refreshAccessToken: async (
		refreshToken: string,
		clientId: string,
		clientSecret: string,
	): Promise<OAuthTokenResponse> => {
		const response = await fetch("https://oauth2.googleapis.com/token", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: clientId,
				client_secret: clientSecret,
				refresh_token: refreshToken,
				grant_type: "refresh_token",
			}),
		});

		if (!response.ok) {
			throw new Error(
				`Failed to refresh Gmail token: ${response.status}`,
			);
		}

		return response.json() as Promise<OAuthTokenResponse>;
	},
};

/**
 * Google Drive OAuth Provider Configuration
 */
const googleDriveProvider: OAuthProviderConfig = {
	type: "GOOGLE_DRIVE",
	name: "Google Drive",
	authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
	tokenUrl: "https://oauth2.googleapis.com/token",
	// Two scopes intentionally, requested together on a single OAuth grant:
	//  - `drive.readonly` (Restricted) — used by the knowledge connector-sync
	//    activity in `packages/temporal/src/activities/connector-sync/providers/
	//    knowledge.ts` (`discoverGoogleDriveResources`) which enumerates files
	//    via `files.list` with `q='<folderId>' in parents` / `sharedWithMe`.
	//    Those queries return empty under `drive.file`.
	//  - `drive.file` (Sensitive) — required by the Google Picker SDK in the
	//    project-context picker flow; grants per-file access only for files
	//    the user explicitly picks (or that our app creates).
	// CASA Tier 2 is triggered by the connector-sync scope; adding the
	// per-file scope alongside doesn't change the audit posture.
	scopes: [
		"https://www.googleapis.com/auth/drive.readonly",
		"https://www.googleapis.com/auth/drive.file",
		"https://www.googleapis.com/auth/userinfo.profile",
		"https://www.googleapis.com/auth/userinfo.email",
	],
	clientIdEnvVar: "GOOGLE_CLIENT_ID",
	clientSecretEnvVar: "GOOGLE_CLIENT_SECRET",
	supportsRefreshToken: true,
	authParams: {
		access_type: "offline",
		prompt: "consent",
	},
	getUserInfo: async (accessToken: string): Promise<OAuthUserInfo> => {
		const response = await fetch(
			"https://www.googleapis.com/oauth2/v2/userinfo",
			{
				headers: {
					Authorization: `Bearer ${accessToken}`,
				},
			},
		);

		if (!response.ok) {
			throw new Error(`Failed to get Google user: ${response.status}`);
		}

		const data = (await response.json()) as {
			id: string;
			email: string;
			name: string;
			picture: string;
		};

		return {
			id: data.id,
			login: data.email,
			name: data.name,
			email: data.email,
			avatarUrl: data.picture,
		};
	},
	refreshAccessToken: async (
		refreshToken: string,
		clientId: string,
		clientSecret: string,
	): Promise<OAuthTokenResponse> => {
		const response = await fetch("https://oauth2.googleapis.com/token", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: clientId,
				client_secret: clientSecret,
				refresh_token: refreshToken,
				grant_type: "refresh_token",
			}),
		});

		if (!response.ok) {
			throw new Error(
				`Failed to refresh Google token: ${response.status}`,
			);
		}

		return response.json() as Promise<OAuthTokenResponse>;
	},
	revokeAccessToken: async (accessToken: string): Promise<void> => {
		// Google's OAuth 2.0 revocation endpoint. Revoking either the access or
		// refresh token invalidates the whole grant. 200 = revoked; 400 =
		// already-invalid/expired, which is fine for a disconnect.
		const response = await fetch(
			`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(accessToken)}`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
				},
			},
		);
		if (!response.ok && response.status !== 400) {
			throw new Error(
				`Failed to revoke Google token: ${response.status}`,
			);
		}
	},
};

/**
 * Microsoft Graph OAuth Provider Configuration
 */
const microsoftGraphProvider: OAuthProviderConfig = {
	type: "MICROSOFT_GRAPH",
	name: "Microsoft 365",
	authorizationUrl:
		"https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
	tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
	scopes: [
		"User.Read",
		// Directory lookup for the Teams list_users tool (GET /users). User.Read
		// only covers the signed-in user.
		"User.ReadBasic.All",
		"Files.Read.All",
		"Sites.Read.All",
		"offline_access",
		// Teams permissions
		"Team.ReadBasic.All",
		"Channel.ReadBasic.All",
		"Chat.Read",
		"ChatMessage.Read",
		"ChannelMessage.Read.All",
		// Write: posting a channel message (Release Notes chat delivery,
		// @-mention replies) requires the delegated ChannelMessage.Send
		// permission. Without it Graph rejects
		// POST /teams/{id}/channels/{id}/messages with 403 Forbidden — the
		// read scopes above are not sufficient (Fizzy #2013). A token issued
		// before this scope was added keeps its original consent: a refresh
		// does NOT widen scopes, so existing connections must re-authorize.
		// Work/school accounts only — Graph does not support channel posting
		// for personal Microsoft accounts. That is not a new restriction: the
		// ChannelMessage.Read.All scope above is equally unsupported there, so
		// a personal account can never link a Teams channel in the first place.
		"ChannelMessage.Send",
		// The channel-message scope above does not cover 1:1 or group chats:
		// POST /chats/{id}/messages needs its own delegated permission.
		"ChatMessage.Send",
		// Mail permissions — the workflow orchestrator reads a mail folder
		// (GET /me/mailFolders/{id}/messages) and sends mail as the user
		// (POST /me/sendMail) from its integration handler.
		"Mail.Read",
		"Mail.Send",
		// Meeting & transcript permissions
		"OnlineMeetings.Read",
		// Both, deliberately. ReadWrite is a superset of Read on paper, but Read
		// is the only calendar scope currently registered and consented in the
		// app registration, and calendar *reads* are load-bearing today:
		// /me/calendarView backs Meeting Digest's personal and upcoming meeting
		// lists, the meetings cache, the Teams list_meetings tool and the
		// workflow get_calendar_events action. ReadWrite is what the workflow
		// create-calendar-event action needs for POST /me/events. Asking for
		// only ReadWrite before it is registered would trade a permission that
		// works for one the tenant cannot grant. Drop Read in the unused-scope
		// cleanup, once ReadWrite is confirmed granted.
		"Calendars.Read",
		"Calendars.ReadWrite",
		"OnlineMeetingTranscript.Read.All",
	],
	clientIdEnvVar: "MICROSOFT_GRAPH_CLIENT_ID",
	clientSecretEnvVar: "MICROSOFT_GRAPH_CLIENT_SECRET",
	supportsRefreshToken: true,
	authParams: {
		response_mode: "query",
	},
	getUserInfo: async (accessToken: string): Promise<OAuthUserInfo> => {
		const response = await fetch("https://graph.microsoft.com/v1.0/me", {
			headers: {
				Authorization: `Bearer ${accessToken}`,
			},
		});

		if (!response.ok) {
			throw new Error(`Failed to get Microsoft user: ${response.status}`);
		}

		const data = (await response.json()) as {
			id: string;
			userPrincipalName: string;
			displayName: string;
			mail: string | null;
		};

		return {
			id: data.id,
			login: data.userPrincipalName,
			name: data.displayName,
			email: data.mail,
			avatarUrl: null, // Microsoft Graph requires additional API call for photo
		};
	},
	refreshAccessToken: async (
		refreshToken: string,
		clientId: string,
		clientSecret: string,
	): Promise<OAuthTokenResponse> => {
		const response = await fetch(
			"https://login.microsoftonline.com/common/oauth2/v2.0/token",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
				},
				body: new URLSearchParams({
					client_id: clientId,
					client_secret: clientSecret,
					refresh_token: refreshToken,
					grant_type: "refresh_token",
				}),
			},
		);

		if (!response.ok) {
			throw new Error(
				`Failed to refresh Microsoft token: ${response.status}`,
			);
		}

		return response.json() as Promise<OAuthTokenResponse>;
	},
};

/**
 * All OAuth providers
 */
export const oauthProviders: Record<OAuthProviderType, OAuthProviderConfig> = {
	AIRTABLE: {
		type: "AIRTABLE",
		name: "Airtable",
		authorizationUrl: "https://airtable.com/oauth2/v1/authorize",
		tokenUrl: "https://airtable.com/oauth2/v1/token",
		scopes: ["data.records:read", "schema.bases:read"],
		clientIdEnvVar: "AIRTABLE_CLIENT_ID",
		clientSecretEnvVar: "AIRTABLE_CLIENT_SECRET",
		supportsRefreshToken: true,
		getUserInfo: async (accessToken: string): Promise<OAuthUserInfo> => {
			const response = await fetch(
				"https://api.airtable.com/v0/meta/whoami",
				{
					headers: {
						Authorization: `Bearer ${accessToken}`,
						Accept: "application/json",
					},
				},
			);

			if (!response.ok) {
				throw new Error(
					`Failed to get Airtable user: ${response.status}`,
				);
			}

			const data = (await response.json()) as {
				id?: string;
				email?: string;
				scopes?: string[];
			};

			return {
				id: data.id ?? data.email ?? "airtable-user",
				login: data.email ?? data.id ?? "airtable-user",
				name: data.email ?? null,
				email: data.email ?? null,
				avatarUrl: null,
			};
		},
		refreshAccessToken: async (
			refreshToken: string,
			clientId: string,
			clientSecret: string,
		): Promise<OAuthTokenResponse> => {
			const response = await fetch(
				"https://airtable.com/oauth2/v1/token",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/x-www-form-urlencoded",
					},
					body: new URLSearchParams({
						client_id: clientId,
						client_secret: clientSecret,
						grant_type: "refresh_token",
						refresh_token: refreshToken,
					}),
				},
			);

			if (!response.ok) {
				throw new Error(
					`Failed to refresh Airtable token: ${response.status}`,
				);
			}

			return response.json() as Promise<OAuthTokenResponse>;
		},
	},
	BITBUCKET: {
		type: "BITBUCKET",
		name: "Bitbucket",
		authorizationUrl: "https://bitbucket.org/site/oauth2/authorize",
		tokenUrl: "https://bitbucket.org/site/oauth2/access_token",
		scopes: ["account", "repository", "issue", "pullrequest"],
		clientIdEnvVar: "BITBUCKET_CLIENT_ID",
		clientSecretEnvVar: "BITBUCKET_CLIENT_SECRET",
		supportsRefreshToken: true,
		useBasicAuthForToken: true,
		getUserInfo: async (accessToken: string): Promise<OAuthUserInfo> => {
			const response = await fetch("https://api.bitbucket.org/2.0/user", {
				headers: {
					Authorization: `Bearer ${accessToken}`,
					Accept: "application/json",
				},
			});

			if (!response.ok) {
				throw new Error(
					`Failed to get Bitbucket user: ${response.status}`,
				);
			}

			const data = (await response.json()) as {
				account_id?: string;
				username?: string;
				display_name?: string;
				links?: { avatar?: { href?: string } };
			};

			return {
				id: data.account_id ?? data.username ?? "bitbucket-user",
				login: data.username ?? data.account_id ?? "bitbucket-user",
				name: data.display_name ?? null,
				email: null,
				avatarUrl: data.links?.avatar?.href ?? null,
			};
		},
		refreshAccessToken: async (
			refreshToken: string,
			clientId: string,
			clientSecret: string,
		): Promise<OAuthTokenResponse> => {
			const credentials = Buffer.from(
				`${clientId}:${clientSecret}`,
			).toString("base64");
			const response = await fetch(
				"https://bitbucket.org/site/oauth2/access_token",
				{
					method: "POST",
					headers: {
						Authorization: `Basic ${credentials}`,
						"Content-Type": "application/x-www-form-urlencoded",
						Accept: "application/json",
					},
					body: new URLSearchParams({
						grant_type: "refresh_token",
						refresh_token: refreshToken,
					}),
				},
			);

			if (!response.ok) {
				throw new Error(
					`Failed to refresh Bitbucket token: ${response.status}`,
				);
			}

			return response.json() as Promise<OAuthTokenResponse>;
		},
	},
	ASANA: {
		type: "ASANA",
		name: "Asana",
		authorizationUrl: "https://app.asana.com/-/oauth_authorize",
		tokenUrl: "https://app.asana.com/-/oauth_token",
		scopes: ["default"],
		clientIdEnvVar: "ASANA_CLIENT_ID",
		clientSecretEnvVar: "ASANA_CLIENT_SECRET",
		supportsRefreshToken: true,
		getUserInfo: async (accessToken: string): Promise<OAuthUserInfo> => {
			const response = await fetch(
				"https://app.asana.com/api/1.0/users/me",
				{
					headers: {
						Authorization: `Bearer ${accessToken}`,
						Accept: "application/json",
					},
				},
			);

			if (!response.ok) {
				throw new Error(`Failed to get Asana user: ${response.status}`);
			}

			const data = (await response.json()) as {
				data?: {
					gid: string;
					email?: string;
					name?: string;
					photo?: { image_60x60?: string | null };
				};
			};

			if (!data.data) {
				throw new Error("Failed to get Asana user profile");
			}

			return {
				id: data.data.gid,
				login: data.data.email || data.data.gid,
				name: data.data.name ?? null,
				email: data.data.email ?? null,
				avatarUrl: data.data.photo?.image_60x60 ?? null,
			};
		},
		refreshAccessToken: async (
			refreshToken: string,
			clientId: string,
			clientSecret: string,
		): Promise<OAuthTokenResponse> => {
			const response = await fetch(
				"https://app.asana.com/-/oauth_token",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/x-www-form-urlencoded",
					},
					body: new URLSearchParams({
						client_id: clientId,
						client_secret: clientSecret,
						grant_type: "refresh_token",
						refresh_token: refreshToken,
					}),
				},
			);

			if (!response.ok) {
				throw new Error(
					`Failed to refresh Asana token: ${response.status}`,
				);
			}

			return response.json() as Promise<OAuthTokenResponse>;
		},
	},
	DROPBOX: dropboxProvider,
	GITHUB: githubProvider,
	GMAIL: gmailProvider,
	GITLAB: {
		type: "GITLAB",
		name: "GitLab",
		authorizationUrl: "https://gitlab.com/oauth/authorize",
		tokenUrl: "https://gitlab.com/oauth/token",
		scopes: ["api", "read_user"],
		clientIdEnvVar: "GITLAB_CLIENT_ID",
		clientSecretEnvVar: "GITLAB_CLIENT_SECRET",
		supportsRefreshToken: true,
		getUserInfo: async (accessToken: string): Promise<OAuthUserInfo> => {
			const response = await fetch("https://gitlab.com/api/v4/user", {
				headers: {
					Authorization: `Bearer ${accessToken}`,
					Accept: "application/json",
				},
			});

			if (!response.ok) {
				throw new Error(
					`Failed to get GitLab user: ${response.status}`,
				);
			}

			const data = (await response.json()) as {
				id: number | string;
				username?: string;
				name?: string;
				email?: string;
				avatar_url?: string | null;
			};

			return {
				id: String(data.id),
				login: data.username ?? data.email ?? String(data.id),
				name: data.name ?? null,
				email: data.email ?? null,
				avatarUrl: data.avatar_url ?? null,
			};
		},
		refreshAccessToken: async (
			refreshToken: string,
			clientId: string,
			clientSecret: string,
		): Promise<OAuthTokenResponse> => {
			const response = await fetch("https://gitlab.com/oauth/token", {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
				},
				body: new URLSearchParams({
					client_id: clientId,
					client_secret: clientSecret,
					grant_type: "refresh_token",
					refresh_token: refreshToken,
				}),
			});

			if (!response.ok) {
				throw new Error(
					`Failed to refresh GitLab token: ${response.status}`,
				);
			}

			return response.json() as Promise<OAuthTokenResponse>;
		},
	},
	GOOGLE_DRIVE: googleDriveProvider,
	INTERCOM: {
		type: "INTERCOM",
		name: "Intercom",
		authorizationUrl: "https://app.intercom.com/oauth",
		tokenUrl: "https://api.intercom.io/auth/eagle/token",
		scopes: [],
		clientIdEnvVar: "INTERCOM_CLIENT_ID",
		clientSecretEnvVar: "INTERCOM_CLIENT_SECRET",
		supportsRefreshToken: false,
		getUserInfo: async (accessToken: string): Promise<OAuthUserInfo> => {
			const response = await fetch("https://api.intercom.io/me", {
				headers: {
					Authorization: `Bearer ${accessToken}`,
					Accept: "application/json",
					"Intercom-Version": "2.11",
				},
			});

			if (!response.ok) {
				throw new Error(
					`Failed to get Intercom user: ${response.status}`,
				);
			}

			const data = (await response.json()) as {
				id?: string;
				email?: string;
				name?: string;
				app?: { id?: string; name?: string };
			};

			return {
				id: data.id ?? data.app?.id ?? "intercom-user",
				login:
					data.email ?? data.app?.name ?? data.id ?? "intercom-user",
				name: data.name ?? data.app?.name ?? null,
				email: data.email ?? null,
				avatarUrl: null,
			};
		},
	},
	MICROSOFT_GRAPH: microsoftGraphProvider,
	HUBSPOT: {
		type: "HUBSPOT",
		name: "HubSpot",
		authorizationUrl: "https://app.hubspot.com/oauth/authorize",
		tokenUrl: "https://api.hubapi.com/oauth/v1/token",
		scopes: [
			"crm.objects.contacts.read",
			"crm.objects.companies.read",
			"crm.objects.deals.read",
			"tickets",
		],
		clientIdEnvVar: "HUBSPOT_CLIENT_ID",
		clientSecretEnvVar: "HUBSPOT_CLIENT_SECRET",
		supportsRefreshToken: true,
		getUserInfo: async (accessToken: string): Promise<OAuthUserInfo> => {
			const response = await fetch(
				`https://api.hubapi.com/oauth/v1/access-tokens/${accessToken}`,
				{
					headers: { Accept: "application/json" },
				},
			);

			if (!response.ok) {
				throw new Error(
					`Failed to get HubSpot user: ${response.status}`,
				);
			}

			const data = (await response.json()) as {
				user?: string;
				hub_id?: number;
				hub_domain?: string;
			};

			return {
				id: String(data.user ?? data.hub_id ?? "hubspot-user"),
				login:
					data.hub_domain ??
					String(data.hub_id ?? data.user ?? "hubspot"),
				name: data.hub_domain ?? "HubSpot",
				email: null,
				avatarUrl: null,
			};
		},
		refreshAccessToken: async (
			refreshToken: string,
			clientId: string,
			clientSecret: string,
		): Promise<OAuthTokenResponse> => {
			const response = await fetch(
				"https://api.hubapi.com/oauth/v1/token",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/x-www-form-urlencoded",
					},
					body: new URLSearchParams({
						client_id: clientId,
						client_secret: clientSecret,
						grant_type: "refresh_token",
						refresh_token: refreshToken,
					}),
				},
			);

			if (!response.ok) {
				throw new Error(
					`Failed to refresh HubSpot token: ${response.status}`,
				);
			}

			return response.json() as Promise<OAuthTokenResponse>;
		},
	},
	LINEAR: {
		type: "LINEAR",
		name: "Linear",
		authorizationUrl: "https://linear.app/oauth/authorize",
		tokenUrl: "https://api.linear.app/oauth/token",
		scopes: ["read", "write", "issues:create", "comments:create"],
		clientIdEnvVar: "LINEAR_CLIENT_ID",
		clientSecretEnvVar: "LINEAR_CLIENT_SECRET",
		supportsRefreshToken: true,
		getUserInfo: async (accessToken: string): Promise<OAuthUserInfo> => {
			const response = await fetch("https://api.linear.app/graphql", {
				method: "POST",
				headers: {
					Authorization: accessToken,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					query: "query { viewer { id name email } }",
				}),
			});

			if (!response.ok) {
				throw new Error(
					`Failed to get Linear user: ${response.status}`,
				);
			}

			const data = (await response.json()) as {
				data?: {
					viewer?: { id: string; name?: string; email?: string };
				};
				errors?: Array<{ message?: string }>;
			};

			if (data.errors?.length || !data.data?.viewer) {
				throw new Error(
					data.errors?.[0]?.message || "Failed to get Linear viewer",
				);
			}

			return {
				id: data.data.viewer.id,
				login: data.data.viewer.email ?? data.data.viewer.id,
				name: data.data.viewer.name ?? null,
				email: data.data.viewer.email ?? null,
				avatarUrl: null,
			};
		},
		refreshAccessToken: async (
			refreshToken: string,
			clientId: string,
			clientSecret: string,
		): Promise<OAuthTokenResponse> => {
			const response = await fetch("https://api.linear.app/oauth/token", {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
				},
				body: new URLSearchParams({
					client_id: clientId,
					client_secret: clientSecret,
					grant_type: "refresh_token",
					refresh_token: refreshToken,
				}),
			});

			if (!response.ok) {
				throw new Error(
					`Failed to refresh Linear token: ${response.status}`,
				);
			}

			return response.json() as Promise<OAuthTokenResponse>;
		},
	},
	SLACK: {
		type: "SLACK",
		name: "Slack",
		authorizationUrl: "https://slack.com/oauth/v2/authorize",
		tokenUrl: "https://slack.com/api/oauth.v2.access",
		// Bot token scopes — these work with Slack's v2 OAuth flow
		scopes: [
			"channels:read",
			"channels:history",
			"groups:read",
			"groups:history",
			"users:read",
			"users:read.email",
			"chat:write",
			// Posting to a channel the bot has not joined returns
			// not_in_channel. `chat:write.public` covers PUBLIC channels
			// without joining; `channels:join` lets the delivery path
			// self-heal by joining and retrying (Fizzy #2013). Private
			// channels can never be self-served — the bot must be invited.
			// Adding/removing requires Slack re-auth.
			"chat:write.public",
			"channels:join",
			"reactions:write",
			// Huddle-notes ingestion (story #1634): `files:read` downloads the
			// huddle AI-notes canvas body (served as a file). `canvases:read`
			// retained for the canvas API. Granted ahead of the feature so users
			// re-auth once, not twice. Adding/removing requires Slack re-auth.
			"files:read",
			"canvases:read",
		],
		// search:read is a user-token-only scope (not valid as a bot scope
		// for standard Slack workspaces). Slack's v2 OAuth supports requesting
		// user scopes separately via the `user_scope` parameter.
		authParams: {
			user_scope: "search:read",
		},
		clientIdEnvVar: "SLACK_CLIENT_ID",
		clientSecretEnvVar: "SLACK_CLIENT_SECRET",
		supportsRefreshToken: false,
		revokeAccessToken: async (accessToken: string): Promise<void> => {
			// Slack's auth.revoke endpoint invalidates a bot/user token.
			// Returns { ok: true } on success; ok: false for already-revoked
			// tokens. Both outcomes are acceptable for a disconnect flow.
			const response = await fetch("https://slack.com/api/auth.revoke", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${accessToken}`,
					"Content-Type": "application/x-www-form-urlencoded",
				},
			});
			if (!response.ok) {
				throw new Error(
					`Failed to revoke Slack token: ${response.status}`,
				);
			}
			const data = (await response.json()) as {
				ok: boolean;
				error?: string;
			};
			// "token_revoked" means it was already invalid — not an error.
			if (!data.ok && data.error !== "token_revoked") {
				throw new Error(`Slack revoke error: ${data.error}`);
			}
		},
		getUserInfo: async (accessToken: string): Promise<OAuthUserInfo> => {
			// First, get basic identity via auth.test
			const authResponse = await fetch(
				"https://slack.com/api/auth.test",
				{
					headers: {
						Authorization: `Bearer ${accessToken}`,
					},
				},
			);

			if (!authResponse.ok) {
				throw new Error(
					`Failed to get Slack user: ${authResponse.status}`,
				);
			}

			const authData = (await authResponse.json()) as {
				ok: boolean;
				user_id: string;
				user: string;
				team: string;
				error?: string;
			};

			if (!authData.ok) {
				throw new Error(
					`Slack auth test failed: ${authData.error || "unknown error"}`,
				);
			}

			// Then fetch user profile for email and avatar
			let email: string | null = null;
			let avatarUrl: string | null = null;
			let displayName: string | null = authData.user;

			try {
				const userResponse = await fetch(
					`https://slack.com/api/users.info?user=${authData.user_id}`,
					{
						headers: {
							Authorization: `Bearer ${accessToken}`,
						},
					},
				);

				if (userResponse.ok) {
					const userData = (await userResponse.json()) as {
						ok: boolean;
						user?: {
							profile?: {
								email?: string;
								image_48?: string;
								real_name?: string;
								display_name?: string;
							};
						};
					};

					if (userData.ok && userData.user?.profile) {
						email = userData.user.profile.email || null;
						avatarUrl = userData.user.profile.image_48 || null;
						displayName =
							userData.user.profile.display_name ||
							userData.user.profile.real_name ||
							authData.user;
					}
				}
			} catch {
				// Non-fatal - continue with basic info
			}

			return {
				id: authData.user_id,
				login: authData.user,
				name: displayName,
				email,
				avatarUrl,
			};
		},
	},
	NOTION: {
		type: "NOTION",
		name: "Notion",
		authorizationUrl: "https://api.notion.com/v1/oauth/authorize",
		tokenUrl: "https://api.notion.com/v1/oauth/token",
		scopes: [], // Notion doesn't use scopes in the same way
		clientIdEnvVar: "NOTION_CLIENT_ID",
		clientSecretEnvVar: "NOTION_CLIENT_SECRET",
		supportsRefreshToken: false,
		useBasicAuthForToken: true, // Notion requires Basic auth for token exchange
		authParams: {
			owner: "user",
		},
		getUserInfo: async (accessToken: string): Promise<OAuthUserInfo> => {
			// Notion returns user info in the token response, so we get it from /users/me
			const response = await fetch("https://api.notion.com/v1/users/me", {
				headers: {
					Authorization: `Bearer ${accessToken}`,
					"Notion-Version": "2022-06-28",
				},
			});

			if (!response.ok) {
				throw new Error(
					`Failed to get Notion user: ${response.status}`,
				);
			}

			const data = (await response.json()) as {
				id: string;
				type: string;
				name: string | null;
				avatar_url: string | null;
				person?: {
					email: string;
				};
				bot?: {
					owner: {
						type: string;
						user?: {
							id: string;
							name: string;
							avatar_url: string;
							person: { email: string };
						};
					};
				};
			};

			// Handle both user and bot responses
			const email =
				data.person?.email ||
				data.bot?.owner?.user?.person?.email ||
				null;
			const name = data.name || data.bot?.owner?.user?.name || null;
			const avatarUrl =
				data.avatar_url || data.bot?.owner?.user?.avatar_url || null;

			return {
				id: data.id,
				login: email || data.id,
				name,
				email,
				avatarUrl,
			};
		},
	},
};

/**
 * Get OAuth provider configuration
 */
export function getOAuthProvider(
	type: OAuthProviderType,
): OAuthProviderConfig | undefined {
	return oauthProviders[type];
}

/**
 * Get OAuth provider credentials from environment variables.
 * For async lookup that also checks the database, use getOAuthCredentialsWithDb().
 */
export function getOAuthCredentials(provider: OAuthProviderConfig): {
	clientId: string | undefined;
	clientSecret: string | undefined;
} {
	return {
		clientId: process.env[provider.clientIdEnvVar],
		clientSecret: process.env[provider.clientSecretEnvVar],
	};
}

/**
 * Get OAuth provider credentials from environment OR database.
 * Checks .env first, then falls back to stored app credentials in WorkflowIntegration.
 *
 * App credentials are stored with name="<PROVIDER>_OAUTH_APP" and credentials contain
 * { client_id, client_secret } encrypted.
 */
export async function getOAuthCredentialsWithDb(
	provider: OAuthProviderConfig,
	userId?: string,
	organizationId?: string | null,
): Promise<{
	clientId: string | undefined;
	clientSecret: string | undefined;
}> {
	// Check .env first
	const envCreds = getOAuthCredentials(provider);
	if (envCreds.clientId && envCreds.clientSecret) {
		return envCreds;
	}

	// Fall back to database-stored app credentials
	try {
		const { db } = await import("@repo/database");
		const { decryptApiKey } = await import("@repo/utils");

		// Look for app config record — search across contexts (org first, then personal, then any)
		const whereConditions = [];
		if (organizationId) {
			whereConditions.push({
				organizationId,
				provider: provider.type as any,
				name: `${provider.type}_OAUTH_APP`,
				isActive: true,
			});
		}
		if (userId) {
			whereConditions.push({
				userId,
				organizationId: null as string | null,
				provider: provider.type as any,
				name: `${provider.type}_OAUTH_APP`,
				isActive: true,
			});
		}
		// SECURITY (SOC 2 CC6.1 / C1.1): do NOT fall back to "any record with
		// this name". A previous unscoped fallback here matched ANY tenant's
		// `<PROVIDER>_OAUTH_APP` row, so an org/user without its own stored app
		// would silently borrow (and expose) another tenant's OAuth
		// client_secret and authenticate against the wrong OAuth app. The only
		// legitimate global app is the environment-configured one, already
		// handled above via getOAuthCredentials(). If neither the env nor the
		// caller's own tenant has an app configured, fail closed (undefined) so
		// the OAuth flow surfaces a clean "not configured" error.

		for (const where of whereConditions) {
			const appConfig = await db.workflowIntegration.findFirst({
				where,
			});
			if (appConfig?.credentials) {
				try {
					const decrypted = JSON.parse(
						decryptApiKey(appConfig.credentials),
					) as Record<string, string>;
					if (decrypted.client_id && decrypted.client_secret) {
						return {
							clientId: decrypted.client_id,
							clientSecret: decrypted.client_secret,
						};
					}
				} catch {
					// Decryption failed, continue to next
				}
			}
		}
	} catch {
		// DB not available, fall through
	}

	// Fall back to MCP config OAuth credentials (e.g., GitLab connected via MCP Servers page)
	try {
		const { db } = await import("@repo/database");
		const { decryptApiKey } = await import("@repo/utils");

		// Map integration provider to MCP server key
		const mcpServerKeyMap: Record<string, string> = {
			GITLAB: "gitlab",
		};
		const mcpServerKey = mcpServerKeyMap[provider.type];
		if (mcpServerKey) {
			const tenantFilter = organizationId
				? { userId, organizationId }
				: userId
					? { userId, organizationId: null as string | null }
					: {};

			const mcpConfig = await db.mCPConfig.findFirst({
				where: {
					...tenantFilter,
					enabled: true,
					oauthClientId: { not: null },
					mcpServer: { key: mcpServerKey },
				},
				select: {
					oauthClientId: true,
					encryptedOauthClientSecret: true,
				},
			});
			if (mcpConfig?.oauthClientId) {
				return {
					clientId: mcpConfig.oauthClientId,
					clientSecret: mcpConfig.encryptedOauthClientSecret
						? decryptApiKey(mcpConfig.encryptedOauthClientSecret)
						: undefined,
				};
			}
		}
	} catch {
		// MCP config lookup failed, fall through
	}

	return envCreds;
}

/**
 * Generate OAuth authorization URL
 */
export function generateAuthorizationUrl(
	provider: OAuthProviderConfig,
	clientId: string,
	redirectUri: string,
	state: string,
): string {
	const params = new URLSearchParams({
		client_id: clientId,
		redirect_uri: redirectUri,
		scope: provider.scopes.join(" "),
		state,
		response_type: "code",
		...provider.authParams,
	});

	return `${provider.authorizationUrl}?${params.toString()}`;
}

/**
 * Exchange authorization code for tokens
 */
export async function exchangeCodeForTokens(
	provider: OAuthProviderConfig,
	code: string,
	clientId: string,
	clientSecret: string,
	redirectUri: string,
): Promise<OAuthTokenResponse> {
	const body = new URLSearchParams({
		client_id: clientId,
		client_secret: clientSecret,
		code,
		redirect_uri: redirectUri,
		grant_type: "authorization_code",
	});

	const headers: Record<string, string> = {
		"Content-Type": "application/x-www-form-urlencoded",
		Accept: "application/json",
	};

	if (provider.useBasicAuthForToken) {
		const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString(
			"base64",
		);
		headers.Authorization = `Basic ${credentials}`;
	}

	const response = await fetch(provider.tokenUrl, {
		method: "POST",
		headers,
		body,
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(
			`Token exchange failed for ${provider.name}: ${response.status} - ${errorText}`,
		);
	}

	const data = (await response.json()) as OAuthTokenResponse & {
		error?: string;
		error_description?: string;
	};

	if (data.error) {
		throw new Error(`OAuth error: ${data.error_description || data.error}`);
	}

	if (!data.access_token) {
		throw new Error(`No access token in ${provider.name} response`);
	}

	return data;
}

/**
 * Map OAuth provider type to WorkflowIntegration provider enum
 */
export function mapOAuthToWorkflowProvider(
	type: OAuthProviderType,
): string | null {
	const mapping: Record<OAuthProviderType, string | null> = {
		AIRTABLE: null,
		ASANA: "ASANA",
		BITBUCKET: null,
		DROPBOX: null,
		GITHUB: "GITHUB",
		GMAIL: "GMAIL",
		GITLAB: "GITLAB",
		GOOGLE_DRIVE: "GOOGLE_DRIVE",
		INTERCOM: null,
		HUBSPOT: null,
		LINEAR: "LINEAR",
		MICROSOFT_GRAPH: "MICROSOFT_GRAPH",
		SLACK: "SLACK",
		NOTION: "NOTION",
	};
	return mapping[type];
}
