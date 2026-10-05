/**
 * What each coding tool needs in order to sign in to Fabric by itself.
 *
 * Every entry here is one action that carries NO credential: the tool is
 * pointed at the project's own gateway URL, it learns from the gateway's 401
 * that it can sign in, and the person approves it in the browser. Nothing built
 * in this file contains a secret, which is why all of it is safe to copy into a
 * shared document or commit to a repository.
 *
 * The URL is the project's (`/api/mcp-gateway/projects/<id>`), so the sign-in
 * is for that one project: it asks for no organization and no project, and the
 * connection reaches that project and nothing else. Claude Code keeps the
 * server in the project's folder (its local scope) and the portable entry is a
 * file of that folder's, which is why both keep the name `fabric`. Codex keeps
 * one list for the whole machine, and VS Code and Cursor install the server for
 * the whole editor, so their entries carry the project in the server's name and
 * two projects do not collide.
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

import { buildProjectResource } from "@repo/utils/oauth-project-resource";
import {
	type LocalSetupRoute,
	quoteShellArgIfNeeded,
} from "../../../lib/instructions-repository-sync";

const SERVER_NAME = "fabric";

/** The most of a project's name a server name could carry before its id was added. */
const SERVER_SLUG_MAX_LENGTH = 32;

/** The longest a server name is: `fabric-` and the slug, whatever of that is the id's. */
const SERVER_NAME_MAX_LENGTH = SERVER_NAME.length + 1 + SERVER_SLUG_MAX_LENGTH;

/** How much of a project's id ends its server name, to tell it from a project of the same name. */
const SERVER_ID_SUFFIX_LENGTH = 6;

/**
 * The endpoint every entry names: one project's gateway, built where every
 * project resource is built so it is spelled exactly as the metadata publishes
 * it. It must be the gateway and never the alternate `/mcp` host, which
 * verifies personal keys only and would hand a client a successful connection
 * with an empty tool list.
 */
export function gatewayUrl(origin: string, projectId: string): string {
	return buildProjectResource(origin, "mcp", projectId);
}

/**
 * The name an editor installs the server under: `fabric-<project-slug>-<id>`,
 * the project's name as a slug and then the last six letters and digits of its
 * id. An editor installs for every folder it opens, so the name has to tell two
 * projects' servers apart, and a name alone does not: two projects may be named
 * alike, in one organization or in two, and a slug cut to length loses what set
 * two long names apart. The id's tail does. It is the tail because an id starts
 * with a timestamp and ends in the random part. The slug is cut so the whole name
 * stays within `SERVER_NAME_MAX_LENGTH`; a name with nothing a slug can keep
 * leaves `fabric-<id>`, and an id with nothing of that kind is used as it is.
 */
export function editorServerName(
	projectName: string,
	projectId: string,
): string {
	const suffix = projectId
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "")
		.slice(-SERVER_ID_SUFFIX_LENGTH);
	const room =
		SERVER_NAME_MAX_LENGTH -
		(SERVER_NAME.length + 1) -
		(suffix === "" ? 0 : suffix.length + 1);
	const slug = projectName
		.normalize("NFKD")
		.replace(/\p{M}+/gu, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.slice(0, room)
		.replace(/^-+|-+$/g, "");
	const parts = [SERVER_NAME, slug, suffix].filter((part) => part !== "");
	return parts.length === 1 ? `${SERVER_NAME}-${projectId}` : parts.join("-");
}

export function buildClaudeCodeCommand(
	origin: string,
	projectId: string,
): string {
	return `claude mcp add --transport http ${SERVER_NAME} ${gatewayUrl(origin, projectId)}`;
}

export function buildVsCodeInstallLink(
	origin: string,
	projectId: string,
	projectName: string,
): string {
	const server = {
		name: editorServerName(projectName, projectId),
		type: "http",
		url: gatewayUrl(origin, projectId),
	};
	return `vscode:mcp/install?${encodeURIComponent(JSON.stringify(server))}`;
}

export function buildCursorInstallLink(
	origin: string,
	projectId: string,
	projectName: string,
): string {
	const config = btoa(JSON.stringify({ url: gatewayUrl(origin, projectId) }));
	return `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(editorServerName(projectName, projectId))}&config=${encodeURIComponent(config)}`;
}

/**
 * The name Codex registers a project's server under: `fabric-` and the last
 * six letters and digits of the project's id, which is `editorServerName` with
 * no project name to slug. Codex keeps one list of servers for every project
 * on the machine, so a name that did not carry the project would be replaced by
 * the next project's `codex mcp add`. It comes from the id alone because that is
 * all `fabric instructions init` and `doctor` have, and the CLI registers the
 * same name: `codexServerName` in `packages/cli/src/lib/instructions/agent-mcp.ts`,
 * which cannot import this file. `packages/cli/__tests__/server-name-agrees-with-web.test.ts`
 * runs one corpus of ids through both and fails on any difference.
 */
export function codexServerName(projectId: string): string {
	return editorServerName("", projectId);
}

export function buildCodexCommands(origin: string, projectId: string): string {
	const name = codexServerName(projectId);
	return [
		`codex mcp add ${name} --url ${gatewayUrl(origin, projectId)}`,
		`codex mcp login ${name}`,
	].join("\n");
}

/**
 * The configuration for any other client: the server and nothing else. No
 * `Authorization` header — an empty one committed to a repository is how this
 * screen used to leave people with a broken `.mcp.json`.
 */
export function buildPortableMcpConfiguration(
	origin: string,
	projectId: string,
): string {
	return JSON.stringify(
		{
			mcpServers: {
				[SERVER_NAME]: {
					type: "http",
					url: gatewayUrl(origin, projectId),
				},
			},
		},
		null,
		2,
	);
}

export type LocalSetupTool = "claude-code" | "codex";

type RepositoryRoute = Extract<LocalSetupRoute, { kind: "repository" }>;

export type CloneChoice = "have" | "clone";

interface InitLineArgs {
	tarballUrl: string;
	baseUrl: string | null;
	tool: LocalSetupTool;
	projectId: string;
}

/**
 * A folder name is handed to `--clone` as its value, so one that starts with
 * `-` would be read as a flag. A leading `./` says it is a path.
 */
function cloneArgument(directory: string): string {
	return quoteShellArgIfNeeded(
		directory.startsWith("-") ? `./${directory}` : directory,
	);
}

/**
 * One command per line and no `&&`: Windows PowerShell 5.1 rejects it, and the
 * CLI does the clone and the set-up in one go. Every value drawn from
 * server-held data is quoted with `quoteShellArgIfNeeded`, so a stored value
 * carrying a shell metacharacter cannot split the pasted line into extra
 * commands.
 */
function joinInitLine(
	args: InitLineArgs,
	cloneDirectory: string | null,
): string {
	const { tarballUrl, baseUrl, tool, projectId } = args;
	return [
		"npx -y",
		quoteShellArgIfNeeded(tarballUrl),
		"instructions init",
		...(baseUrl === null
			? []
			: [`--base-url ${quoteShellArgIfNeeded(baseUrl)}`]),
		`--project ${quoteShellArgIfNeeded(projectId)}`,
		`--tool ${tool}`,
		...(cloneDirectory === null
			? []
			: [`--clone ${cloneArgument(cloneDirectory)}`]),
	].join(" ");
}

/**
 * The one line that sets a checkout up: the CLI this deployment serves, run
 * straight from its URL, so there is nothing to install first and the sign-in
 * goes to the deployment the tarball came from.
 *
 * `baseUrl` is the address to sign in at, written as `--base-url` and always
 * winning over anything baked into the tarball. It is `null` only when the
 * tarball is baked for the very address the person is on, where the flag would
 * say what the CLI already knows.
 *
 * The line always names the project, as `--project`. The CLI could find a
 * repository project from the checkout's remote, but it signs in for the
 * project it is told, and naming it is what keeps that sign-in to the one
 * project the person is looking at. `--tool` is always written: the person
 * picked a tool, and `init` without one writes a hook for every tool it finds
 * on the machine.
 */
export function buildInitLine(args: InitLineArgs): string {
	return joinInitLine(args, null);
}

/**
 * The same set-up, for a repository the person has not cloned: `init` clones
 * the project's repository into `route.directory` and carries on in the folder
 * the instructions live in.
 */
export function buildCloneAndInitLine(
	route: RepositoryRoute,
	args: InitLineArgs,
): string {
	return joinInitLine(args, route.directory);
}

/**
 * Where to run the line, in words that never say "any folder": `init` in an
 * existing checkout only works in the clone's top folder, or in the sync's root
 * folder inside it when the instructions live in a subfolder.
 */
export function folderHint(
	route: RepositoryRoute,
	choice: CloneChoice,
): string {
	if (choice === "clone") {
		return `cloned into a new folder, ${route.directory}`;
	}
	return route.rootPath === null
		? "run it in the top folder of your clone"
		: `run it in ${route.rootPath}/ inside your clone`;
}

export interface GitCredentialHelp {
	/** What to do, in a sentence that names the provider. */
	sentence: string;
	/** The one command that does it. */
	command: string;
}

/**
 * How to give git credentials for a provider, for the person whose first
 * `git clone` or `git fetch` says it cannot sign in. Fabric never hands out
 * repository credentials; the checkout uses the person's own, so the help is
 * the provider's own sign-in.
 *
 * Azure DevOps has no sign-in command for git (`az devops login` only stores a
 * token for the `az devops` commands, which git never reads): Git Credential
 * Manager signs git in the first time a git command reaches the repository
 * from a terminal, so the command is one such git command.
 */
export function gitCredentialHelp(
	route: Pick<RepositoryRoute, "provider" | "cloneUrl">,
): GitCredentialHelp {
	const { provider } = route;
	switch (provider) {
		case "GITHUB":
			return {
				sentence:
					"Fabric never hands out repository credentials: your checkout uses your own. Run this once to sign git in to GitHub, or install Git Credential Manager.",
				command: "gh auth login",
			};
		case "GITLAB":
			return {
				sentence:
					"Fabric never hands out repository credentials: your checkout uses your own. Run this once to sign git in to GitLab.",
				command: "glab auth login",
			};
		case "AZURE_DEVOPS":
			return {
				sentence:
					"Fabric never hands out repository credentials: your checkout uses your own. Run this once in a terminal: Git Credential Manager, included with Git for Windows, opens an Azure DevOps sign-in and remembers it.",
				command: `git ls-remote ${quoteShellArgIfNeeded(route.cloneUrl)}`,
			};
		default: {
			const unreachable: never = provider;
			return unreachable;
		}
	}
}
