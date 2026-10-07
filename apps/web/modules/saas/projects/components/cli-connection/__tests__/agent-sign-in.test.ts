/**
 * The keyless connect entries, decoded the way each tool decodes them. The
 * formats are each tool's own (cited in `lib/agent-sign-in.ts`); what is pinned
 * here is that every entry names the gateway and carries no credential.
 */

import { describe, expect, it } from "vitest";
import type { LocalSetupRoute } from "../../../lib/instructions-repository-sync";
import {
	buildClaudeCodeCommand,
	buildCloneAndInitLine,
	buildCodexCommand,
	buildCursorInstallLink,
	buildInitLine,
	buildPortableMcpConfiguration,
	buildVsCodeInstallLink,
	codexServerName,
	editorServerName,
	folderHint,
	gatewayUrl,
	gitCredentialHelp,
} from "../lib/agent-sign-in";

const ORIGIN = "https://app.example.com";
const PROJECT_ID = "project-example-one";
const PROJECT_NAME = "Example Website";
const GATEWAY = `${ORIGIN}/api/mcp-gateway/projects/${PROJECT_ID}`;

describe("keyless connect entries", () => {
	it("names the project's own gateway, never the organization-wide one, in every entry", () => {
		expect(gatewayUrl(ORIGIN, PROJECT_ID)).toBe(GATEWAY);
		for (const entry of [
			buildClaudeCodeCommand(ORIGIN, PROJECT_ID),
			buildCodexCommand(ORIGIN, PROJECT_ID),
			buildPortableMcpConfiguration(ORIGIN, PROJECT_ID),
			decodeURIComponent(
				buildVsCodeInstallLink(ORIGIN, PROJECT_ID, PROJECT_NAME),
			),
			atob(
				new URL(
					buildCursorInstallLink(ORIGIN, PROJECT_ID, PROJECT_NAME),
				).searchParams.get("config") ?? "",
			),
		]) {
			expect(entry).toContain(GATEWAY);
			expect(entry.replace(GATEWAY, "")).not.toContain(
				"/api/mcp-gateway",
			);
		}
	});

	it("adds the gateway to Claude Code over HTTP, under the name fabric", () => {
		expect(buildClaudeCodeCommand(ORIGIN, PROJECT_ID)).toBe(
			`claude mcp add --transport http fabric ${GATEWAY}`,
		);
	});

	it("builds a VS Code install link whose payload is the URL-encoded server JSON, named for the project", () => {
		const link = buildVsCodeInstallLink(ORIGIN, PROJECT_ID, PROJECT_NAME);
		const prefix = "vscode:mcp/install?";

		expect(link.startsWith(prefix)).toBe(true);
		expect(
			JSON.parse(decodeURIComponent(link.slice(prefix.length))),
		).toEqual({
			name: "fabric-example-website-pleone",
			type: "http",
			url: GATEWAY,
		});
	});

	it("builds a Cursor install link whose config is the base64 server JSON, named for the project", () => {
		const url = new URL(
			buildCursorInstallLink(ORIGIN, PROJECT_ID, PROJECT_NAME),
		);

		expect(`${url.protocol}//${url.host}${url.pathname}`).toBe(
			"cursor://anysphere.cursor-deeplink/mcp/install",
		);
		expect(url.searchParams.get("name")).toBe(
			"fabric-example-website-pleone",
		);
		expect(JSON.parse(atob(url.searchParams.get("config") ?? ""))).toEqual({
			url: GATEWAY,
		});
	});

	it("adds the server to Codex under a name of the project's own, with no separate login: the add signs in", () => {
		expect(buildCodexCommand(ORIGIN, PROJECT_ID)).toBe(
			`codex mcp add fabric-pleone --url ${GATEWAY}`,
		);
	});

	it("gives two projects different Codex commands, since Codex keeps one list for all of them", () => {
		const first = buildCodexCommand(ORIGIN, "cm9x2k4f10000aaaaaa123456");
		const second = buildCodexCommand(ORIGIN, "cm9x2k4f10000aaaaaa654321");

		expect(first).toContain("fabric-123456");
		expect(second).toContain("fabric-654321");
		expect(first).not.toBe(second);
	});

	it("gives any other client the server alone, with no Authorization header to commit", () => {
		const configuration = buildPortableMcpConfiguration(ORIGIN, PROJECT_ID);

		expect(JSON.parse(configuration)).toEqual({
			mcpServers: { fabric: { type: "http", url: GATEWAY } },
		});
		expect(configuration).not.toMatch(/authorization|bearer|headers/i);
	});

	it("refuses to build an entry for a project id that could change the URL", () => {
		expect(() => gatewayUrl(ORIGIN, "a/b")).toThrow();
		expect(() => gatewayUrl(ORIGIN, "")).toThrow();
	});
});

describe("Codex's server name", () => {
	// The same ids and names `codexServerName` is pinned to in the CLI's
	// agent-mcp.test.ts, and `server-name-agrees-with-web.test.ts` there runs both
	// rules over one corpus, so `fabric instructions init` and this dialog name a
	// project's server alike.
	it.each([
		["project-example-one", "fabric-pleone"],
		["cm9x2k4f10000abcd1234", "fabric-cd1234"],
		["Ab_Cd-Ef-12", "fabric-cdef12"],
		["ab", "fabric-ab"],
		["---", "fabric----"],
	])(
		"is fabric- and the last six letters and digits of the id: %s",
		(id, name) => {
			expect(codexServerName(id)).toBe(name);
		},
	);

	it("is the editor server name of a project with no name to slug", () => {
		for (const id of [PROJECT_ID, "Ab_Cd-Ef-12", "ab", "---"]) {
			expect(codexServerName(id)).toBe(editorServerName("", id));
		}
	});

	it("uses the server name the CLI registers", () => {
		expect(buildCodexCommand(ORIGIN, PROJECT_ID)).toBe(
			`codex mcp add ${codexServerName(PROJECT_ID)} --url ${GATEWAY}`,
		);
		expect(buildCodexCommand(ORIGIN, PROJECT_ID)).not.toContain("login");
	});
});

describe("an editor's server name", () => {
	it("is fabric-, the project's name as a slug, and the tail of its id", () => {
		expect(editorServerName("Example Website", PROJECT_ID)).toBe(
			"fabric-example-website-pleone",
		);
		expect(editorServerName("  Q3 — Roadmap & Plans!  ", PROJECT_ID)).toBe(
			"fabric-q3-roadmap-plans-pleone",
		);
	});

	it("falls back to the id's tail alone when the name has nothing a slug can keep", () => {
		expect(editorServerName("プロジェクト", PROJECT_ID)).toBe(
			"fabric-pleone",
		);
		expect(editorServerName("", PROJECT_ID)).toBe("fabric-pleone");
	});

	it("uses an id with no letters or digits as it is, when the name has none either", () => {
		expect(editorServerName("", "---")).toBe("fabric----");
	});

	it("keeps accents' letters and is bounded", () => {
		expect(editorServerName("Café Ünïcode", PROJECT_ID)).toBe(
			"fabric-cafe-unicode-pleone",
		);
		const long = editorServerName("a".repeat(100), PROJECT_ID);
		expect(long).toBe(`fabric-${"a".repeat(25)}-pleone`);
		expect(long.length).toBeLessThanOrEqual(39);
	});

	it("never ends the slug in a dash the cut left behind", () => {
		const name = `${"a".repeat(24)} bbbb`;

		expect(editorServerName(name, PROJECT_ID)).toBe(
			`fabric-${"a".repeat(24)}-pleone`,
		);
	});

	it("reads the id's tail in lower case, without the separators an id may carry", () => {
		expect(editorServerName("Example", "Ab_Cd-Ef12")).toBe(
			"fabric-example-cdef12",
		);
		expect(editorServerName("Example", "ab")).toBe("fabric-example-ab");
	});

	describe("tells apart projects whose names a slug cannot", () => {
		const GITHUB = "E2E scratch: coding instructions (GitHub)";
		const AZURE = "E2E scratch: coding instructions (Azure DevOps)";

		it("two long names that are the same once they are cut", () => {
			const github = editorServerName(GITHUB, "cm0abcdef123456");
			const azure = editorServerName(AZURE, "cm0abcdef654321");

			expect(github).toBe("fabric-e2e-scratch-coding-instru-123456");
			expect(azure).toBe("fabric-e2e-scratch-coding-instru-654321");
			expect(github).not.toBe(azure);
			expect(github.length).toBeLessThanOrEqual(39);
			expect(azure.length).toBeLessThanOrEqual(39);
		});

		it("two projects of the very same name", () => {
			expect(
				editorServerName("Example Website", "cm0aaaaaa111111"),
			).not.toBe(editorServerName("Example Website", "cm0bbbbbb222222"));
		});

		it("the install links of two projects of one name, in the same editor", () => {
			const names = [
				buildVsCodeInstallLink(ORIGIN, "cm0aaaaaa111111", GITHUB),
				buildVsCodeInstallLink(ORIGIN, "cm0bbbbbb222222", GITHUB),
			].map(
				(link) =>
					JSON.parse(
						decodeURIComponent(
							link.slice("vscode:mcp/install?".length),
						),
					).name as string,
			);
			const cursor = [
				buildCursorInstallLink(ORIGIN, "cm0aaaaaa111111", GITHUB),
				buildCursorInstallLink(ORIGIN, "cm0bbbbbb222222", GITHUB),
			].map((link) => new URL(link).searchParams.get("name"));

			expect(new Set(names).size).toBe(2);
			expect(new Set(cursor).size).toBe(2);
		});
	});
});

const TARBALL = `${ORIGIN}/cli/fabric-0.4.0.tgz`;

const REPOSITORY_ROUTE: Extract<LocalSetupRoute, { kind: "repository" }> = {
	kind: "repository",
	provider: "GITHUB",
	repositoryLabel: "example-org/rules",
	cloneUrl: "https://github.com/example-org/rules.git",
	directory: "rules",
	ref: "main",
	rootPath: null,
};

const LINE = {
	tarballUrl: TARBALL,
	baseUrl: null,
	tool: "claude-code",
} as const;

describe("the one-line setup", () => {
	it("runs the CLI the deployment serves, naming the project, with nothing to install and no key", () => {
		const line = buildInitLine({ ...LINE, projectId: "project-1" });

		expect(line).toBe(
			`npx -y ${TARBALL} instructions init --project project-1 --tool claude-code`,
		);
		expect(line).not.toMatch(/--key|--base-url|--clone|--org|auth login/);
	});

	it("always carries the project, whether or not the project has a remote to find it from", () => {
		for (const projectId of ["project-1", "project-example-one"]) {
			expect(buildInitLine({ ...LINE, projectId })).toContain(
				`--project ${projectId}`,
			);
		}
	});

	it("says which address to sign in at when the tarball is not known to be built for it", () => {
		expect(
			buildInitLine({ ...LINE, baseUrl: ORIGIN, projectId: "project-1" }),
		).toBe(
			`npx -y ${TARBALL} instructions init --base-url ${ORIGIN} --project project-1 --tool claude-code`,
		);
	});

	it("names the tool it was given, for Claude Code and for Codex alike", () => {
		expect(
			buildInitLine({ ...LINE, tool: "codex", projectId: "project-1" }),
		).toBe(
			`npx -y ${TARBALL} instructions init --project project-1 --tool codex`,
		);
		expect(
			buildInitLine({
				...LINE,
				tool: "claude-code",
				projectId: "project-1",
			}),
		).toBe(
			`npx -y ${TARBALL} instructions init --project project-1 --tool claude-code`,
		);
	});

	it("puts --base-url before the project", () => {
		expect(
			buildInitLine({
				...LINE,
				baseUrl: ORIGIN,
				tool: "codex",
				projectId: "project-1",
			}),
		).toBe(
			`npx -y ${TARBALL} instructions init --base-url ${ORIGIN} --project project-1 --tool codex`,
		);
	});

	it("quotes a value that carries a shell metacharacter, so the line cannot be split", () => {
		expect(
			buildInitLine({
				...LINE,
				baseUrl: "https://app.example.com/a b",
				projectId: "p;rm",
			}),
		).toBe(
			`npx -y ${TARBALL} instructions init --base-url 'https://app.example.com/a b' --project 'p;rm' --tool claude-code`,
		);
	});
});

describe("the clone-and-set-up line", () => {
	it("is ONE command, with the project, the tool and the folder, and nothing to chain", () => {
		const line = buildCloneAndInitLine(REPOSITORY_ROUTE, {
			...LINE,
			projectId: "project-1",
		});

		expect(line).toBe(
			`npx -y ${TARBALL} instructions init --project project-1 --tool claude-code --clone rules`,
		);
		// Windows PowerShell 5.1 rejects `&&`.
		expect(line).not.toMatch(/&&|git clone|\bcd\b/);
	});

	it("does not name the clone URL: the CLI finds the repository from the project", () => {
		const line = buildCloneAndInitLine(REPOSITORY_ROUTE, {
			...LINE,
			projectId: "project-1",
		});

		expect(line).not.toContain(REPOSITORY_ROUTE.cloneUrl);
		expect(line).not.toContain("github.com");
	});

	it("keeps the sync's root folder out of the line: the CLI continues in it by itself", () => {
		const line = buildCloneAndInitLine(
			{ ...REPOSITORY_ROUTE, rootPath: "agents" },
			{ ...LINE, projectId: "project-1" },
		);

		expect(line).not.toContain("agents");
		expect(line.endsWith("--clone rules")).toBe(true);
	});

	it("puts --base-url before the project, and names the tool Codex was picked for", () => {
		expect(
			buildCloneAndInitLine(REPOSITORY_ROUTE, {
				...LINE,
				baseUrl: ORIGIN,
				tool: "codex",
				projectId: "project-1",
			}),
		).toBe(
			`npx -y ${TARBALL} instructions init --base-url ${ORIGIN} --project project-1 --tool codex --clone rules`,
		);
	});

	it("quotes a folder carrying a shell metacharacter, so the line cannot be split", () => {
		const line = buildCloneAndInitLine(
			{ ...REPOSITORY_ROUTE, directory: "my rules;rm" },
			{ ...LINE, projectId: "project-1" },
		);

		expect(line).toBe(
			`npx -y ${TARBALL} instructions init --project project-1 --tool claude-code --clone 'my rules;rm'`,
		);
	});

	it("will not let a folder that starts with a dash be read as a flag", () => {
		const line = buildCloneAndInitLine(
			{ ...REPOSITORY_ROUTE, directory: "-rules" },
			{ ...LINE, projectId: "project-1" },
		);

		expect(line.endsWith("--clone ./-rules")).toBe(true);
	});
});

describe("where to run the line", () => {
	it("says the top folder of the clone when the instructions are at its root", () => {
		expect(folderHint(REPOSITORY_ROUTE, "have")).toBe(
			"run it in the top folder of your clone",
		);
	});

	it("names the root folder inside the clone when the instructions live in a subfolder", () => {
		expect(
			folderHint({ ...REPOSITORY_ROUTE, rootPath: "agents" }, "have"),
		).toBe("run it in agents/ inside your clone");
	});

	it("says a clone lands in a new folder, by name", () => {
		expect(
			folderHint({ ...REPOSITORY_ROUTE, rootPath: "agents" }, "clone"),
		).toBe("cloned into a new folder, rules");
	});

	it("never says any folder", () => {
		for (const rootPath of [null, "agents"]) {
			for (const choice of ["have", "clone"] as const) {
				expect(
					folderHint({ ...REPOSITORY_ROUTE, rootPath }, choice),
				).not.toMatch(/any folder/i);
			}
		}
	});
});

describe("git sign-in help", () => {
	const cloneUrl =
		"https://dev.azure.com/example-org/example/_git/instructions";

	it("names the provider's own sign-in for git, for every provider it can set up", () => {
		expect(
			gitCredentialHelp({ provider: "GITHUB", cloneUrl }).command,
		).toBe("gh auth login");
		expect(
			gitCredentialHelp({ provider: "GITLAB", cloneUrl }).command,
		).toBe("glab auth login");
		for (const provider of ["GITHUB", "GITLAB", "AZURE_DEVOPS"] as const) {
			expect(
				gitCredentialHelp({ provider, cloneUrl }).sentence,
			).toContain("never hands out repository credentials");
		}
	});

	// `az devops login` stores a token for the `az devops` commands, which git
	// never reads. Git Credential Manager signs git in on a git command.
	it("gives Azure DevOps a git command against the repository, not `az devops login`", () => {
		const help = gitCredentialHelp({ provider: "AZURE_DEVOPS", cloneUrl });

		expect(help.command).toBe(`git ls-remote ${cloneUrl}`);
		expect(help.sentence).toContain("Git Credential Manager");
		expect(help.command).not.toContain("az devops");
	});
});
