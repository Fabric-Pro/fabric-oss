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

interface ProfileConfig {
	/** API key for this profile */
	apiKey?: string;
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

export function getApiKey(): string | undefined {
	// Env var takes precedence over stored config
	if (process.env.FABRIC_API_KEY) {
		return process.env.FABRIC_API_KEY;
	}
	return getActiveProfile().apiKey;
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

export function saveApiKey(apiKey: string, profile = "default"): void {
	const store = getStore();
	const profiles = store.get("profiles") as CliConfig["profiles"];
	store.set("profiles", {
		...profiles,
		[profile]: { ...(profiles[profile] ?? {}), apiKey },
	});
	store.set("activeProfile", profile);
}

export function clearApiKey(profile = "default"): void {
	const store = getStore();
	const profiles = store.get("profiles") as CliConfig["profiles"];
	const { apiKey: _, ...rest } = profiles[profile] ?? {};
	store.set("profiles", { ...profiles, [profile]: rest });
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
