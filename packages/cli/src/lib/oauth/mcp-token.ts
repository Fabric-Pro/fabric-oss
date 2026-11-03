/**
 * A project's MCP gateway sign-in, for coding tools that cannot sign in
 * themselves without a second step (specs/2026-10-21-ai-artifacts-hub).
 *
 * The gateway refuses a token issued for the REST API (an OAuth token is bound
 * to one resource), so the CLI's own project sign-in cannot be reused. During
 * `fabric instructions init` the CLI signs in once more, for the project's
 * MCP gateway, and keeps that sign-in here, beside its config, readable by the
 * person only. The plugin's MCP server then asks `fabric mcp header` for its
 * Authorization header at every connection (Claude Code's `headersHelper`),
 * and nobody has to choose Authenticate in `/mcp`.
 *
 * The refresh token rotates on use, so a refresh holds a lock of its own; a
 * sign-in that can no longer be refreshed is dropped, and the header command
 * then answers with no header, which sends the coding tool back to its own
 * sign-in.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
	getConfigPath,
	getRegisteredClient,
	type OAuthCredentials,
} from "../config.js";
import { withExclusiveLock } from "../exclusive-lock.js";
import { openBrowser } from "./browser.js";
import {
	loginWithBrowser,
	parseTokenResponse,
	postTokenRequest,
} from "./flow.js";

const REFRESH_WINDOW_MS = 60_000;

type Store = Record<string, OAuthCredentials>;

function storeFile(): string {
	return path.join(path.dirname(getConfigPath()), "mcp-sign-ins.json");
}

function keyFor(origin: string, projectId: string): string {
	return `${origin}|${projectId}`;
}

function readStore(): Store {
	try {
		const parsed = JSON.parse(readFileSync(storeFile(), "utf8")) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Store)
			: {};
	} catch {
		return {};
	}
}

function writeStore(store: Store): void {
	const file = storeFile();
	if (!existsSync(path.dirname(file))) {
		mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	}
	writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

export function hasMcpSignIn(origin: string, projectId: string): boolean {
	return Boolean(readStore()[keyFor(origin, projectId)]?.refreshToken);
}

/** Signs in for the project's MCP gateway in the browser and keeps the tokens. */
export async function signInForMcp(input: {
	baseUrl: string;
	origin: string;
	projectId: string;
	announce: (authorizationUrl: string) => void;
	signal?: AbortSignal;
}): Promise<void> {
	const credentials = await loginWithBrowser({
		baseUrl: input.baseUrl,
		project: input.projectId,
		audience: "mcp",
		previous: getRegisteredClient(input.origin, input.projectId),
		openBrowser,
		announce: input.announce,
		signal: input.signal,
	});
	if (new URL(credentials.issuer).origin !== input.origin) {
		throw new Error(
			`The sign-in for ${input.origin} was issued by another site, so nothing was kept.`,
		);
	}
	await withExclusiveLock(async () => {
		const store = readStore();
		store[keyFor(input.origin, input.projectId)] = credentials;
		writeStore(store);
	}, lockOptions());
}

function lockOptions() {
	return {
		lockPath: `${storeFile()}.lock`,
		staleMs: 30_000,
		waitMs: 8_000,
		pollMs: 100,
	};
}

/** A current access token for the project's MCP gateway, or null when there is no usable sign-in. */
export async function mcpAccessToken(
	origin: string,
	projectId: string,
	signal?: AbortSignal,
): Promise<string | null> {
	const key = keyFor(origin, projectId);
	const current = readStore()[key];
	if (!current) {
		return null;
	}
	if (current.expiresAt - Date.now() > REFRESH_WINDOW_MS) {
		return current.accessToken;
	}
	return withExclusiveLock(async () => {
		const store = readStore();
		const latest = store[key];
		if (!latest) {
			return null;
		}
		if (latest.expiresAt - Date.now() > REFRESH_WINDOW_MS) {
			return latest.accessToken;
		}
		if (!latest.refreshToken) {
			delete store[key];
			writeStore(store);
			return null;
		}
		const response = await postTokenRequest(
			(input, init) => fetch(input, init),
			latest.tokenEndpoint,
			{
				grant_type: "refresh_token",
				refresh_token: latest.refreshToken,
				client_id: latest.clientId,
			},
			signal,
		);
		if (!response.ok) {
			delete store[key];
			writeStore(store);
			return null;
		}
		const tokens = parseTokenResponse(
			await response.json().catch(() => null),
			Date.now(),
		);
		store[key] = {
			...latest,
			accessToken: tokens.accessToken,
			refreshToken: tokens.refreshToken,
			expiresAt: tokens.expiresAt,
		};
		writeStore(store);
		return tokens.accessToken;
	}, lockOptions());
}
