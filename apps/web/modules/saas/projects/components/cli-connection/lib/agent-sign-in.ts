/**
 * What each coding tool needs in order to sign in to Fabric by itself.
 *
 * Every entry here is one action that carries NO credential: the tool is
 * pointed at the gateway, it learns from the gateway's 401 that it can sign
 * in, and the person approves it in the browser. Nothing built in this file
 * contains a secret, which is why all of it is safe to copy into a shared
 * document or commit to a repository.
 *
 * The command and link formats come from each tool's own documentation
 * (checked 2026-10-02):
 *
 *   - Claude Code: `claude mcp add --transport http <name> <url>`, then
 *     `/mcp` to authenticate (https://code.claude.com/docs/en/mcp).
 *   - VS Code: `vscode:mcp/install?` followed by
 *     `encodeURIComponent(JSON.stringify(server))`
 *     (https://code.visualstudio.com/api/extension-guides/ai/mcp).
 *   - Cursor: `cursor://anysphere.cursor-deeplink/mcp/install?name=...&config=`
 *     with the base64 of the server's JSON
 *     (https://cursor.com/docs/context/mcp/install-links).
 *   - Codex: `codex mcp add <name> --url <url>`, then `codex mcp login <name>`
 *     (https://developers.openai.com/codex/mcp).
 */

import {
	type LocalSetupRoute,
	quoteShellArgIfNeeded,
} from "../../../lib/instructions-repository-sync";

/**
 * The endpoint every entry names. It must be the gateway and never the
 * alternate `/mcp` host, which verifies personal keys only and would hand a
 * client a successful connection with an empty tool list.
 */
const MCP_GATEWAY_PATH = "/api/mcp-gateway";

const SERVER_NAME = "fabric";

export function gatewayUrl(origin: string): string {
	return `${origin}${MCP_GATEWAY_PATH}`;
}

export function buildClaudeCodeCommand(origin: string): string {
	return `claude mcp add --transport http ${SERVER_NAME} ${gatewayUrl(origin)}`;
}

export function buildVsCodeInstallLink(origin: string): string {
	const server = {
		name: SERVER_NAME,
		type: "http",
		url: gatewayUrl(origin),
	};
	return `vscode:mcp/install?${encodeURIComponent(JSON.stringify(server))}`;
}

export function buildCursorInstallLink(origin: string): string {
	const config = btoa(JSON.stringify({ url: gatewayUrl(origin) }));
	return `cursor://anysphere.cursor-deeplink/mcp/install?name=${SERVER_NAME}&config=${encodeURIComponent(config)}`;
}

export function buildCodexCommands(origin: string): string {
	return [
		`codex mcp add ${SERVER_NAME} --url ${gatewayUrl(origin)}`,
		`codex mcp login ${SERVER_NAME}`,
	].join("\n");
}

/**
 * The configuration for any other client: the server and nothing else. No
 * `Authorization` header — an empty one committed to a repository is how this
 * screen used to leave people with a broken `.mcp.json`.
 */
export function buildPortableMcpConfiguration(origin: string): string {
	return JSON.stringify(
		{
			mcpServers: {
				[SERVER_NAME]: { type: "http", url: gatewayUrl(origin) },
			},
		},
		null,
		2,
	);
}

export type LocalSetupTool = "claude-code" | "codex";

/** The CLI signs in through the browser; `--key` stays for CI. */
export function oauthLoginLine(baseUrl: string): string {
	return `fabric auth login --base-url ${baseUrl}`;
}

/** The API-key sign-in the collapsed alternative still shows. */
export function keyLoginLine(rawKey: string, baseUrl: string): string {
	return `fabric auth login --key ${rawKey} --base-url ${baseUrl}`;
}

export function buildLocalSyncCommands(
	projectId: string,
	loginLine: string,
	automaticallyApplyUpdates: boolean,
	tool: LocalSetupTool,
): string {
	return [
		"npm install -g @fabricorg/cli",
		loginLine,
		`fabric instructions init --project ${projectId} --tool ${tool}${
			automaticallyApplyUpdates ? " --apply" : ""
		}`,
	].join("\n");
}

/**
 * The repository variant's five lines: clone (with an explicit target
 * directory), enter the folder the instructions live in, install/update the
 * CLI, sign in, then `init` — never with `--apply`, because a sync hook would
 * be a second writer next to the developer's own pulls. Every argument drawn
 * from server-held data — the clone URL, the directory, the root folder — is
 * quoted with `quoteShellArgIfNeeded` and both `git clone` and `cd` use a `--`
 * option terminator, so a stored path carrying a shell metacharacter or a
 * leading `-` can neither split the pasted block into extra commands nor be
 * read as an option.
 */
export function buildRepositorySetupCommands(
	route: Extract<LocalSetupRoute, { kind: "repository" }>,
	projectId: string,
	loginLine: string,
	tool: LocalSetupTool,
): string {
	const cdTarget = route.rootPath
		? `${route.directory}/${route.rootPath}`
		: route.directory;
	return [
		`git clone -- ${quoteShellArgIfNeeded(route.cloneUrl)} ${quoteShellArgIfNeeded(route.directory)}`,
		`cd -- ${quoteShellArgIfNeeded(cdTarget)}`,
		"npm install -g @fabricorg/cli",
		loginLine,
		`fabric instructions init --project ${projectId} --tool ${tool}`,
	].join("\n");
}
