/**
 * Config storage for @fabricorg/cli
 *
 * Persists to XDG_CONFIG_HOME/fabricai/config.json (Linux/macOS)
 * or %APPDATA%\fabricai\config.json (Windows).
 *
 * The API key is stored as-is in the config file with 0600 permissions.
 * Future: migrate to system keychain.
 */

import Conf from "conf";

interface CliConfig {
	/** Active profile name */
	activeProfile: string;
	profiles: Record<string, ProfileConfig>;
	/** Default output format */
	defaultFormat: "table" | "json" | "yaml" | "csv";
}

/**
 * A browser sign-in: the tokens an authorization-code flow returned and what
 * is needed to refresh and revoke them. Kept beside, never inside, `apiKey`:
 * a profile holds one or the other, and `saveApiKey` / `saveOAuth` each clear
 * the other so a stale credential cannot shadow a fresh one.
 */
export interface OAuthCredentials {
	/** The registered public client this profile signed in as. */
	clientId: string;
	/** The loopback redirect the client registered. Reused while it matches. */
	redirectUri: string;
	tokenEndpoint: string;
	revocationEndpoint?: string;
	accessToken: string;
	refreshToken?: string;
	/** Epoch milliseconds at which `accessToken` stops working. */
	expiresAt: number;
}

interface ProfileConfig {
	/** API key for this profile */
	apiKey?: string;
	/** Browser sign-in for this profile. Mutually exclusive with `apiKey`. */
	oauth?: OAuthCredentials;
	/** Override base URL (e.g. for self-hosted) */
	baseUrl?: string;
	/** Default context for commands */
	defaultContext?: ContextConfig;
}

export type ContextConfig =
	| { type: "personal" }
	| { type: "org"; slug: string };

const DEFAULTS: CliConfig = {
	activeProfile: "default",
	profiles: {},
	defaultFormat: "table",
};

let _store: Conf<CliConfig> | undefined;

function getStore(): Conf<CliConfig> {
	if (!_store) {
		_store = new Conf<CliConfig>({
			projectName: "fabricai",
			defaults: DEFAULTS,
			// The file holds credentials: owner read/write only.
			configFileMode: 0o600,
		});
	}
	return _store;
}

function getConfig(): CliConfig {
	return getStore().store;
}

function getActiveProfile(): ProfileConfig {
	const cfg = getConfig();
	return cfg.profiles[cfg.activeProfile] ?? {};
}

/**
 * The profile's key, or failing that its browser sign-in's access token.
 *
 * Despite the name this answers "is there a bearer credential at all", which is
 * how every caller but `getClient` uses it: as the check that a request is worth
 * attempting. `getClient` tells the two apart with `getOAuth` and, for a sign-in,
 * refreshes the token per request, so the access token returned here for one may
 * be stale and is never sent as-is.
 */
export function getApiKey(): string | undefined {
	// Env var takes precedence over stored config
	if (process.env.FABRIC_API_KEY) {
		return process.env.FABRIC_API_KEY;
	}
	const profile = getActiveProfile();
	return profile.apiKey ?? profile.oauth?.accessToken;
}

/** True only for a key, never for a browser sign-in. */
export function hasStoredApiKey(): boolean {
	return (
		Boolean(process.env.FABRIC_API_KEY) ||
		Boolean(getActiveProfile().apiKey)
	);
}

/** The active profile's browser sign-in, if it has one. */
export function getOAuth(): OAuthCredentials | undefined {
	return getActiveProfile().oauth;
}

export function getBaseUrl(): string | undefined {
	if (process.env.FABRIC_BASE_URL) {
		return process.env.FABRIC_BASE_URL;
	}
	return getActiveProfile().baseUrl;
}

export function getDefaultContext(): ContextConfig | undefined {
	// Env var takes precedence
	if (process.env.FABRIC_ORG) {
		return { type: "org", slug: process.env.FABRIC_ORG };
	}
	if (process.env.FABRIC_PERSONAL === "1") {
		return { type: "personal" };
	}
	return getActiveProfile().defaultContext;
}

export function getOutputFormat(): "table" | "json" | "yaml" | "csv" {
	if (
		process.env.FABRIC_FORMAT === "json" ||
		process.env.FABRIC_FORMAT === "yaml" ||
		process.env.FABRIC_FORMAT === "csv"
	) {
		return process.env.FABRIC_FORMAT as "json" | "yaml" | "csv";
	}
	return getConfig().defaultFormat;
}

export interface SaveApiKeyOptions {
	/** Persisted only when a login explicitly selected a deployment URL. */
	baseUrl?: string;
}

/**
 * Save credentials into the active profile in one profile update.
 *
 * `FABRIC_BASE_URL` remains an execution-time override: callers only pass a
 * base URL here when the person explicitly chose it with `--base-url`.
 */
export function saveApiKey(
	apiKey: string,
	{ baseUrl }: SaveApiKeyOptions = {},
): void {
	const store = getStore();
	const profile = store.get("activeProfile") as string;
	const profiles = store.get("profiles") as CliConfig["profiles"];
	const { oauth: _oauth, ...current } = profiles[profile] ?? {};
	store.set("profiles", {
		...profiles,
		[profile]: {
			...current,
			apiKey,
			...(baseUrl === undefined ? {} : { baseUrl }),
		},
	});
}

/**
 * Save a browser sign-in into the active profile, replacing any stored key.
 * Also used to persist a refreshed token pair: pass the same profile's
 * credentials with the new tokens.
 */
export function saveOAuth(
	oauth: OAuthCredentials,
	{ baseUrl }: SaveApiKeyOptions = {},
): void {
	const store = getStore();
	const profile = store.get("activeProfile") as string;
	const profiles = store.get("profiles") as CliConfig["profiles"];
	const { apiKey: _apiKey, ...current } = profiles[profile] ?? {};
	store.set("profiles", {
		...profiles,
		[profile]: {
			...current,
			oauth,
			...(baseUrl === undefined ? {} : { baseUrl }),
		},
	});
}

export function clearApiKey(profile?: string): void {
	const store = getStore();
	const active = profile ?? (store.get("activeProfile") as string);
	const profiles = store.get("profiles") as CliConfig["profiles"];
	const { apiKey: _, oauth: __, ...rest } = profiles[active] ?? {};
	store.set("profiles", { ...profiles, [active]: rest });
}

export function saveDefaultContext(ctx: ContextConfig, profile?: string): void {
	const store = getStore();
	const active = profile ?? (store.get("activeProfile") as string);
	const profiles = store.get("profiles") as CliConfig["profiles"];
	store.set("profiles", {
		...profiles,
		[active]: { ...(profiles[active] ?? {}), defaultContext: ctx },
	});
}

export function getConfigPath(): string {
	return getStore().path;
}
