/**
 * Config storage for @fabricorg/cli
 *
 * Persists to XDG_CONFIG_HOME/fabricai/config.json (Linux/macOS)
 * or %APPDATA%\fabricai\config.json (Windows).
 *
 * Credentials are stored as-is in the config file with 0600 permissions.
 * Future: migrate to system keychain.
 *
 * Version 2 keys a profile by the ORIGIN of the deployment it signs in to
 * (`https://fabric.pro`), because a credential is only ever good for the
 * deployment that issued it: a browser sign-in records its `issuer`, and
 * `createOAuthFetch` refuses to send it anywhere else. A version 1 file, whose
 * profiles were named and each carried a `baseUrl`, is re-keyed on read, in
 * memory; the first write saves it as version 2.
 *
 * A sign-in for one project (`fabric auth login --project <id>`) is kept in the
 * deployment's profile too, under `projects`, one per project id. That is an
 * added field of version 2 and not a version 3: a build that does not know the
 * field keeps it when it saves, whereas a build that meets a version it does not
 * know reads the file as version 1 and re-keys the profiles, which would lose
 * the other deployments' credentials. Builds of different ages share one config
 * file here, because a deployment serves its own copy of the CLI.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import Conf from "conf";
import {
	ExclusiveLockBusyError,
	withExclusiveLockSync,
} from "./exclusive-lock.js";
import { bakedOrigin, DEFAULT_ORIGIN, normalizeOrigin } from "./origin.js";

interface CliConfig {
	/** 2 once written by this build; absent in a version 1 file. */
	version?: number;
	/** The origin of the profile commands use when none is named. */
	activeProfile: string;
	/** Keyed by origin. */
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
	/**
	 * The authorization server that issued this sign-in. The tokens are only
	 * ever sent to this origin.
	 */
	issuer: string;
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
	/**
	 * Browser sign-ins that reach one project each, by project id. Independent
	 * of `apiKey` and `oauth`: saving or clearing one never touches another.
	 */
	projects?: Record<string, { oauth: OAuthCredentials }>;
	/** The deployment as the person spelled it (`--base-url`), when it is more than an origin */
	baseUrl?: string;
	/** Default context for commands */
	defaultContext?: ContextConfig;
}

export type ContextConfig =
	| { type: "personal" }
	| { type: "org"; slug: string };

/** What a version 1 file may hold: named profiles, an optional issuer-less sign-in. */
interface StoredConfig {
	version?: number;
	activeProfile: string;
	profiles: Record<
		string,
		Omit<ProfileConfig, "oauth"> & {
			oauth?: Omit<OAuthCredentials, "issuer"> & { issuer?: string };
		}
	>;
	defaultFormat: CliConfig["defaultFormat"];
}

const CONFIG_VERSION = 2;

// No `version` here: a default would be read back as the file's own and hide
// a version 1 file from `migrate`.
const DEFAULTS: StoredConfig = {
	activeProfile: "default",
	profiles: {},
	defaultFormat: "table",
};

let _store: Conf<StoredConfig> | undefined;

function getStore(): Conf<StoredConfig> {
	if (!_store) {
		_store = new Conf<StoredConfig>({
			projectName: "fabricai",
			defaults: DEFAULTS,
			// The file holds credentials: owner read/write only.
			configFileMode: 0o600,
		});
	}
	return _store;
}

/** The origin of a URL this build wrote or is about to, or null when it is not one. */
function originOf(url: string): string | null {
	return normalizeOrigin(url);
}

/**
 * A version 1 file as version 2: profiles keyed by the origin of their
 * `baseUrl` (the default deployment when they have none), the active profile
 * winning a collision, and each sign-in given the issuer its token endpoint
 * implies. A file already at version 2 is returned as it is.
 */
function migrate(stored: StoredConfig): CliConfig {
	if (stored.version === CONFIG_VERSION) {
		return stored as CliConfig;
	}
	const profiles: Record<string, ProfileConfig> = {};
	let active = DEFAULT_ORIGIN;
	for (const [name, profile] of Object.entries(stored.profiles)) {
		const origin =
			originOf(profile.baseUrl ?? DEFAULT_ORIGIN) ?? DEFAULT_ORIGIN;
		const { oauth, ...rest } = profile;
		const rekeyed: ProfileConfig = oauth
			? {
					...rest,
					oauth: {
						...oauth,
						issuer:
							oauth.issuer ??
							originOf(oauth.tokenEndpoint) ??
							origin,
					},
				}
			: rest;
		const isActive = name === stored.activeProfile;
		if (isActive || !(origin in profiles)) {
			profiles[origin] = rekeyed;
		}
		if (isActive) {
			active = origin;
		}
	}
	return {
		version: CONFIG_VERSION,
		activeProfile: active,
		profiles,
		defaultFormat: stored.defaultFormat,
	};
}

function getConfig(): CliConfig {
	return migrate(getStore().store);
}

function persist(config: CliConfig): void {
	getStore().store = { ...config, version: CONFIG_VERSION };
}

/**
 * A write holds the file's own lock for the milliseconds it takes to read and
 * rewrite one small file, and an old lock with no live owner is reported for
 * manual recovery. This is not the refresh lock (`oauth/session.ts`), which a renewal holds
 * across a network round-trip and writes under: sharing it would make that write
 * wait for itself.
 */
const WRITE_LOCK_STALE_MS = 10_000;
const WRITE_LOCK_WAIT_MS = 8_000;
const WRITE_LOCK_POLL_MS = 20;

/**
 * Change the configuration under its write lock: read it again inside the lock,
 * let `change` say the one thing that differs, and save that, so a write by
 * another process that ran in between is kept and never put back as it was.
 * Every sign-in is written by a login, a logout or a renewal that may run in
 * another process (a session hook renews on its own), and a renewal's rotated
 * refresh token written back as the spent one ends every sign-in this CLI has
 * made, for every project, when the server sees the spent one replayed.
 * `change` returns `undefined` when there is nothing to save.
 */
function update(change: (config: CliConfig) => CliConfig | undefined): void {
	const lockPath = `${getStore().path}.write.lock`;
	mkdirSync(path.dirname(lockPath), { recursive: true });
	try {
		withExclusiveLockSync(
			() => {
				const next = change(getConfig());
				if (next !== undefined) {
					persist(next);
				}
			},
			{
				lockPath,
				staleMs: WRITE_LOCK_STALE_MS,
				waitMs: WRITE_LOCK_WAIT_MS,
				pollMs: WRITE_LOCK_POLL_MS,
			},
		);
	} catch (error) {
		throw error instanceof ExclusiveLockBusyError
			? new Error(
					error.abandoned
						? `A previous Fabric process left its configuration lock at ${JSON.stringify(lockPath)}. Confirm it is no longer running, remove that lock, then try again.`
						: "Another fabric process is updating the configuration and did not finish. Try again.",
				)
			: error;
	}
}

/** The origin commands talk to when none is named. */
export function getActiveOrigin(): string {
	return getConfig().activeProfile;
}

function profileFor(origin?: string): ProfileConfig {
	const config = getConfig();
	return config.profiles[origin ?? config.activeProfile] ?? {};
}

/** The sign-in a project has in a profile, never the deployment's own. */
function projectSignIn(
	profile: ProfileConfig,
	projectId: string,
): OAuthCredentials | undefined {
	const projects = profile.projects;
	return projects !== undefined && Object.hasOwn(projects, projectId)
		? projects[projectId]?.oauth
		: undefined;
}

/**
 * The bearer credential for a request, in the one order every command uses:
 *
 *   1. `FABRIC_API_KEY`, which overrides whatever is stored, as it always has;
 *   2. the project's own browser sign-in, when `projectId` is named and has one;
 *   3. the deployment's credential: its key, else its organization-wide sign-in.
 *
 * A request without a project never uses a project's sign-in: that one reaches
 * its project and nothing organization-wide.
 *
 * Despite the name this answers "is there a bearer credential at all", which is
 * how every caller but `getClient` uses it: as the check that a request is worth
 * attempting. `getClient` tells a key from a sign-in with `getOAuth` and, for a
 * sign-in, refreshes the token per request, so the access token returned here
 * for one may be stale and is never sent as-is.
 *
 * `origin` names the deployment's profile; the active one when omitted.
 */
export function getApiKey(
	origin?: string,
	projectId?: string,
): string | undefined {
	// Env var takes precedence over stored config
	if (process.env.FABRIC_API_KEY) {
		return process.env.FABRIC_API_KEY;
	}
	const profile = profileFor(origin);
	return (
		(projectId === undefined
			? undefined
			: projectSignIn(profile, projectId)?.accessToken) ??
		profile.apiKey ??
		profile.oauth?.accessToken
	);
}

/** True only for a key, never for a browser sign-in. */
export function hasStoredApiKey(origin?: string): boolean {
	return (
		Boolean(process.env.FABRIC_API_KEY) ||
		Boolean(profileFor(origin).apiKey)
	);
}

/**
 * A deployment's browser sign-in, if it has one: with `projectId`, that
 * project's and nothing else's; without, the organization-wide one.
 */
export function getOAuth(
	origin?: string,
	projectId?: string,
): OAuthCredentials | undefined {
	const profile = profileFor(origin);
	return projectId === undefined
		? profile.oauth
		: projectSignIn(profile, projectId);
}

/**
 * The browser sign-in a new one reuses its client registration from: the one it
 * replaces, else the deployment's own, else any project's. Every sign-in of a
 * deployment is the same registered client, so the person keeps one "Fabric
 * CLI" under Connected agents and not one per project.
 */
export function getRegisteredClient(
	origin?: string,
	projectId?: string,
): OAuthCredentials | undefined {
	const profile = profileFor(origin);
	return (
		(projectId === undefined
			? undefined
			: projectSignIn(profile, projectId)) ??
		profile.oauth ??
		Object.values(profile.projects ?? {})[0]?.oauth
	);
}

/** Every project a deployment has a browser sign-in for. */
export function listProjectSignIns(
	origin?: string,
): Array<{ projectId: string; oauth: OAuthCredentials }> {
	return Object.entries(profileFor(origin).projects ?? {}).map(
		([projectId, { oauth }]) => ({ projectId, oauth }),
	);
}

/**
 * The deployment a command talks to when `--base-url` did not say: the
 * environment, then the deployment this build was packed for, then the
 * active profile's. `undefined` means the default deployment.
 */
export function getBaseUrl(): string | undefined {
	if (process.env.FABRIC_BASE_URL) {
		return process.env.FABRIC_BASE_URL;
	}
	return bakedOrigin() ?? profileFor().baseUrl;
}

export function getDefaultContext(): ContextConfig | undefined {
	// Env var takes precedence
	if (process.env.FABRIC_ORG) {
		return { type: "org", slug: process.env.FABRIC_ORG };
	}
	if (process.env.FABRIC_PERSONAL === "1") {
		return { type: "personal" };
	}
	return profileFor().defaultContext;
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
	/**
	 * Persisted only when a login explicitly selected a deployment URL. Its
	 * origin names the profile the credential is stored under, and that
	 * profile becomes the active one.
	 */
	baseUrl?: string;
	/**
	 * The profile to save into, by origin, without making it active: a
	 * refreshed sign-in goes back where it came from.
	 */
	origin?: string;
	/**
	 * Save a browser sign-in as this project's rather than the deployment's.
	 * Neither the deployment's key nor its own sign-in is touched.
	 */
	projectId?: string;
}

/** The profile a save lands in, and whether it becomes the active one. */
function targetOf(
	config: CliConfig,
	{ baseUrl, origin }: SaveApiKeyOptions,
): { key: string; activate: boolean } {
	if (baseUrl !== undefined) {
		return {
			key: originOf(baseUrl) ?? config.activeProfile,
			activate: true,
		};
	}
	return { key: origin ?? config.activeProfile, activate: false };
}

/**
 * Save credentials into a profile in one update.
 *
 * `FABRIC_BASE_URL` remains an execution-time override: callers only pass a
 * base URL here when the person explicitly chose it with `--base-url`.
 */
export function saveApiKey(
	apiKey: string,
	options: SaveApiKeyOptions = {},
): void {
	update((config) => {
		const { key, activate } = targetOf(config, options);
		const { oauth: _oauth, ...current } = config.profiles[key] ?? {};
		return {
			...config,
			activeProfile: activate ? key : config.activeProfile,
			profiles: {
				...config.profiles,
				[key]: {
					...current,
					apiKey,
					...(options.baseUrl === undefined
						? {}
						: { baseUrl: options.baseUrl }),
				},
			},
		};
	});
}

/**
 * Save a browser sign-in into a profile, replacing any stored key. Also used
 * to persist a refreshed token pair: pass the same profile's credentials with
 * the new tokens and its `origin`.
 */
export function saveOAuth(
	oauth: OAuthCredentials,
	options: SaveApiKeyOptions = {},
): void {
	update((config) => {
		const { key, activate } = targetOf(config, options);
		if (options.projectId !== undefined) {
			const profile = config.profiles[key] ?? {};
			return {
				...config,
				activeProfile: activate ? key : config.activeProfile,
				profiles: {
					...config.profiles,
					[key]: {
						...profile,
						projects: {
							...profile.projects,
							[options.projectId]: { oauth },
						},
						...(options.baseUrl === undefined
							? {}
							: { baseUrl: options.baseUrl }),
					},
				},
			};
		}
		const { apiKey: _apiKey, ...current } = config.profiles[key] ?? {};
		return {
			...config,
			activeProfile: activate ? key : config.activeProfile,
			profiles: {
				...config.profiles,
				[key]: {
					...current,
					oauth,
					...(options.baseUrl === undefined
						? {}
						: { baseUrl: options.baseUrl }),
				},
			},
		};
	});
}

/**
 * Remove the deployment's own credential. A project's browser sign-in is a
 * credential of its own and stays until `clearProjectSignIn` removes it.
 */
export function clearApiKey(origin?: string): void {
	update((config) => {
		const key = origin ?? config.activeProfile;
		const { apiKey: _, oauth: __, ...rest } = config.profiles[key] ?? {};
		return { ...config, profiles: { ...config.profiles, [key]: rest } };
	});
}

/** Remove one project's browser sign-in, and nothing else of the deployment's. */
export function clearProjectSignIn(projectId: string, origin?: string): void {
	update((config) => {
		const key = origin ?? config.activeProfile;
		const { projects, ...rest } = config.profiles[key] ?? {};
		if (projects === undefined || !Object.hasOwn(projects, projectId)) {
			return undefined;
		}
		const remaining = Object.fromEntries(
			Object.entries(projects).filter(([id]) => id !== projectId),
		);
		return {
			...config,
			profiles: {
				...config.profiles,
				[key]:
					Object.keys(remaining).length === 0
						? rest
						: { ...rest, projects: remaining },
			},
		};
	});
}

export function saveDefaultContext(ctx: ContextConfig, origin?: string): void {
	update((config) => {
		const key = origin ?? config.activeProfile;
		return {
			...config,
			profiles: {
				...config.profiles,
				[key]: { ...(config.profiles[key] ?? {}), defaultContext: ctx },
			},
		};
	});
}

export function getConfigPath(): string {
	return getStore().path;
}
