// @vitest-environment node
/**
 * The in-app MCP gateway docs describe the coding-instruction tools, so they
 * are checked against the tools the gateway actually serves rather than
 * against whoever last remembered to edit them. They had drifted: three of the
 * six tools were missing from the table, the Connect dialog was described as
 * minting a read-only key although its key carries `instructions:write`, and a
 * repository project was said to need its changes made "in that repository"
 * while an agent's suggestion becomes a pull request there.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	discoveryDocumentFor,
	parseCliManifest,
} from "../../modules/saas/cli-distribution/lib/cli-discovery";

const WEB_ROOT = path.resolve(__dirname, "../..");

function read(relative: string): string {
	return readFileSync(path.join(WEB_ROOT, relative), "utf8");
}

const GUIDE = read("content/docs/integrations/mcp-gateway.mdx");
const REFERENCE = read("content/docs/api/mcp-gateway.mdx");
const PLATFORM_TOOLS = read("modules/saas/mcp/lib/gateway/platform-tools.ts");

/** Every instruction tool the gateway defines, read from its own source. */
function instructionToolNames(): string[] {
	const names = new Set<string>();
	for (const match of PLATFORM_TOOLS.matchAll(
		/^\t\tname: "(fabric_[a-z_]*instruction[a-z_]*)"/gm,
	)) {
		names.add(match[1]);
	}
	return [...names].sort();
}

describe("the MCP gateway docs", () => {
	it("finds the instruction tools the gateway serves", () => {
		expect(instructionToolNames()).toEqual([
			"fabric_add_instruction_lesson",
			"fabric_get_project_instruction",
			"fabric_get_project_instruction_bundle",
			"fabric_instruction_checks",
			"fabric_list_project_instructions",
			"fabric_propose_project_instruction_change",
		]);
	});

	it.each([
		["the setup guide", GUIDE],
		["the API reference", REFERENCE],
	])("lists every instruction tool in %s", (_label, doc) => {
		for (const tool of instructionToolNames()) {
			expect(doc, tool).toContain(`\`${tool}\``);
		}
	});

	it("gives each instruction tool its scope in the API reference", () => {
		expect(REFERENCE).toMatch(
			/`fabric_propose_project_instruction_change` \| `instructions:write` \| write/,
		);
		expect(REFERENCE).toMatch(
			/`fabric_instruction_checks` \| `instructions:read` \| read/,
		);
	});

	it("describes the one-line setup the deployment serves, and where to find the CLI", () => {
		expect(GUIDE).toContain(
			"https://your-fabric.com/cli/fabric-<version>-<build>.tgz",
		);
		expect(GUIDE).toContain("instructions init");
		expect(GUIDE).toContain("/.well-known/fabric-cli.json");
		expect(REFERENCE).toContain("/.well-known/fabric-cli.json");
		expect(REFERENCE).toContain("cli_not_served");
	});

	it("documents every field the discovery route answers with", () => {
		const manifest = parseCliManifest({
			spec: 1,
			version: "0.4.0",
			minSupported: "0.4.0",
			nodeRange: ">=22",
			origin: "https://fabric.example.com",
			tarball: "/cli/fabric-0.4.0.tgz",
			integrity:
				"sha512-gs0KTkSwaASijxIqwSDGS2+zgB7ztmUss3KGk2FSJtWwW1lV6xyxvhfPm30zh14w8/A1yEfFl+kz96Ujga5gDg==",
		});
		expect(manifest).not.toBeNull();
		if (!manifest) {
			return;
		}

		for (const field of Object.keys(
			discoveryDocumentFor(manifest, "https://fabric.example.com"),
		)) {
			expect(REFERENCE, field).toContain(`| \`${field}\` |`);
		}
	});

	// Fizzy #2878 §10: the tab commits, shows the branch's commits, compares and
	// reverts on a repository project. The guide names the controls by the
	// words the tab uses, so each one is checked against the shipped copy rather
	// than against a memory of it.
	describe("the repository project section", () => {
		const en = JSON.parse(
			read("../../packages/i18n/translations/en.json"),
		) as {
			projects: {
				codingInstructions: {
					commits: Record<string, string>;
					commit: Record<string, string>;
					fileView: Record<string, string>;
				};
			};
		};
		const copy = en.projects.codingInstructions;

		it.each([
			["Suggest as a pull request", copy.commit.suggestButton],
			["Rename", copy.fileView.renameButton],
			["Compare with parent", copy.commits.compareAction],
			["Revert", copy.commits.revertAction],
			["Published", copy.commits.publishedBadge],
			["Refused by scan", copy.commits.refusedBadge],
			["Not synced yet", copy.commits.notSyncedBadge],
			["Commits", "Commits"],
		])("names %s as the tab does", (label, shipped) => {
			expect(shipped).toBe(label);
			// Bold, with the sentence's full stop inside it when it labels a bullet.
			expect(GUIDE).toMatch(
				new RegExp(`\\*\\*${label.replaceAll(" ", "\\s+")}\\.?\\*\\*`),
			);
		});

		it("describes committing to the branch and what happens when it cannot be pushed", () => {
			expect(GUIDE).toContain(
				"#### Work on a repository project from the tab",
			);
			expect(GUIDE).toContain("**Commit to**");
			expect(GUIDE).toMatch(
				/secret scan an upload gets before anything is pushed/,
			);
			expect(GUIDE).toMatch(
				/protected, or keeps\s+moving, Fabric opens the pull request/,
			);
			expect(GUIDE).toMatch(
				/changed the same\s+file since you started, nothing is written/,
			);
		});

		it("says Commits publishes, rolls back and deletes nothing, and names Read-only mode", () => {
			expect(GUIDE).toMatch(
				/publishes, rolls back to or deletes a version/,
			);
			expect(GUIDE).toMatch(
				/Read-only mode makes no commit and no revert/,
			);
		});
	});

	// Fizzy #2878 §9: an upload project's published files move into a repository
	// as one pull request. The guide names the controls and the states by the
	// words the tab uses, so each is checked against the shipped copy.
	describe("the section on moving uploaded instructions into a repository", () => {
		const en = JSON.parse(
			read("../../packages/i18n/translations/en.json"),
		) as {
			projects: {
				codingInstructions: {
					repositorySync: {
						settings: Record<string, string>;
						migration: Record<string, string>;
					};
				};
			};
		};
		const sync = en.projects.codingInstructions.repositorySync;
		// The guide is hard-wrapped; a sentence is checked as one line.
		const section = GUIDE.slice(
			GUIDE.indexOf("#### Move uploaded instructions into a repository"),
			GUIDE.indexOf("#### Keep a checkout current"),
		).replace(/\s+/g, " ");

		it("has its own heading, before the checkout section", () => {
			expect(GUIDE).toContain(
				"#### Move uploaded instructions into a repository",
			);
			expect(section.length).toBeGreaterThan(500);
		});

		it("says a pull request merged into another branch is not synced and ends the move", () => {
			expect(section).toMatch(
				/merged into a different\s+branch than the one the project reads.*Fabric does not sync it/i,
			);
			expect(sync.migration.abandonedMismatch).toContain(
				"merged into another branch; Fabric did not sync it",
			);
		});

		it("says Switch to upload mode is the way out of a switching or blocked move, and the only one when the project was switched behind the move's back", () => {
			expect(section).toMatch(
				/\*\*Switch to upload mode\*\* in Settings.*switching over or blocked/i,
			);
			expect(section).toMatch(
				/switched to the repository by something other than the move.*Cancel move and Retry are refused/i,
			);
			expect(sync.settings.switchToUpload).toBe("Switch to upload mode");
		});

		it("lists reverts among what is paused", () => {
			expect(section).toMatch(/reverts[^.]*are paused/i);
		});

		it.each([
			["Move to a repository…", sync.settings.moveButton],
			["Cancel move", sync.migration.cancelMove],
			["Retry", sync.migration.retry],
		])("names %s as the tab does", (label, shipped) => {
			expect(shipped).toBe(label);
			expect(section).toMatch(
				new RegExp(
					`\\*\\*${label
						.replace("…", "\\.?…?")
						.replaceAll(" ", "\\s+")}\\.?\\*\\*`,
				),
			);
		});

		it("quotes the states the status line shows", () => {
			expect(section).toContain(sync.migration.preparing);
			expect(section).toContain(sync.migration.merged);
		});

		it("says what the move is: one pull request, the instructions staying as published until it merges", () => {
			expect(section).toMatch(/one pull request/);
			expect(section).toMatch(/stay as published/);
		});

		it("says what is paused, and that a pull request that has merged cannot be canceled", () => {
			expect(section).toMatch(
				/uploads, edits, publishing, ignore rules, repository settings, reverts and manual syncs are paused/i,
			);
			expect(section).toMatch(/already merged cannot be canceled/);
		});

		it("says the folder must not hold files and what refuses a move", () => {
			expect(section).toMatch(/must not hold any files yet/);
			expect(section).toMatch(
				/refuses, with the reason, a folder that already has files/,
			);
		});
	});

	it("shows the setup lines the dialog renders, with --tool, and says where to run them", () => {
		expect(GUIDE).toContain(
			"`npx -y <tgz> instructions init --tool <tool>`",
		);
		expect(GUIDE).toContain(
			"`npx -y <tgz> instructions init --project <id> --tool <tool> --clone <dir>`",
		);
		expect(GUIDE).toContain(
			"`npx -y <tgz> instructions init --project <id> --tool <tool>`",
		);
		for (const label of [
			"**Already cloned.**",
			"**Clone it for me.**",
			"**Claude Code**",
			"**Codex**",
			"**VS Code**",
			"**Cursor**",
			"**Other**",
		]) {
			expect(GUIDE, label).toContain(label);
		}
		// The top folder of the clone, or the project's folder inside it: no
		// other folder will do, and the CLI refuses anywhere else.
		expect(GUIDE).toMatch(/top\s+folder of your clone/);
		expect(GUIDE).toMatch(/`<rootPath>\/` inside the clone/);
		expect(GUIDE).toMatch(/Not\s+in any other folder/);
		expect(GUIDE).not.toMatch(/any folder in\s+it/);
		expect(GUIDE).toMatch(/Node\.js 22 or\s+later/);
		// One command per line: Windows PowerShell 5.1 has no `&&`.
		expect(GUIDE).toMatch(/no `&&` and no `cd`/);
	});

	it("says the dialog's collapsible rows by their names, and not the old git one", () => {
		expect(GUIDE).toContain("**Git can't sign in to the repository**");
		expect(GUIDE).toContain("CI or headless? Use an API key");
		expect(GUIDE).not.toMatch(/I don't have git credentials/);
	});

	it("does not offer the npm registry as the way in", () => {
		expect(GUIDE).toMatch(/package on the npm registry is not a way in/);
		expect(GUIDE).not.toMatch(/npm install/);
	});

	it("says what the hook does, the Codex trust steps, and how to check and undo setup", () => {
		expect(GUIDE).toMatch(
			/fast-forwards the branch the project\s+follows to its newest commit when your checkout is clean and on that branch/,
		);
		expect(GUIDE).toMatch(/never merges, rebases, resets or stashes/);
		expect(GUIDE).toMatch(/An upload project\.\*\* The hook reports/);
		expect(GUIDE).toMatch(
			/Trust it, then run `\/hooks`\s+once to trust the project hook/,
		);
		expect(GUIDE).toContain("`.claude/settings.local.json`");
		expect(GUIDE).toContain("`.codex/hooks.json`");
		expect(GUIDE).toContain("`cli/<deployment>/fabric.mjs`");
		expect(GUIDE).toMatch(/instructions doctor --project <id>/);
		expect(GUIDE).toMatch(/To undo it, delete the project's/);
	});

	it("keeps the CLI guide in step: one npx line with --tool, no cd, no registry install as the way in", () => {
		const cliGuide = read("../../docs/guides/coding-instructions-cli.md");

		expect(cliGuide).toContain(
			"npx -y https://example.com/cli/fabric-<version>-<build>.tgz instructions init --tool claude-code",
		);
		expect(cliGuide).not.toMatch(/fabric-<version>\.tgz/);
		expect(cliGuide).not.toMatch(/&& cd /);
		expect(cliGuide).toMatch(
			/\*\*The package on npm is not the way in\.\*\*/,
		);
		expect(cliGuide).toContain("--clone [<folder>]");
		expect(cliGuide).toMatch(
			/trust the folder when Codex asks, then use `\/hooks`/,
		);
		expect(cliGuide).toContain("Node.js 22 or later");
	});

	it("shows the setup line with --base-url as the normal form, and the bake as optional", () => {
		expect(GUIDE).toContain(
			"`--base-url https://your-fabric.com`, the address you are on",
		);
		expect(GUIDE).toMatch(/Baking the address in is\s+optional/);
		expect(GUIDE).toMatch(/`--base-url` wins over what is baked in/);
		expect(REFERENCE).toMatch(/Baking an origin in is optional/);
		expect(REFERENCE).toContain("`FABRIC_CLI_REQUIRE_ORIGIN=1`");
		expect(REFERENCE).toMatch(
			/`origin` \| .*or `null` when the build did not know it/,
		);
	});

	it("names the variables the origin is taken from, and not the Vercel ones", () => {
		for (const name of [
			"FABRIC_CLI_ORIGIN",
			"NEXT_PUBLIC_SITE_URL",
			"APP_URL",
		]) {
			expect(REFERENCE, name).toContain(`\`${name}\``);
		}
		expect(REFERENCE).not.toContain("`VERCEL_PROJECT_PRODUCTION_URL`");
		expect(GUIDE).not.toContain("VERCEL_PROJECT_PRODUCTION_URL");
	});

	it("says a signed-in tool is the default and a key is for CI and headless machines", () => {
		expect(GUIDE).toMatch(/Sign in from your coding agent/);
		expect(GUIDE).toMatch(/CI or headless\? Use an API key/);
	});

	it("says how a checkout is kept current, and that pulling stays with the developer", () => {
		expect(GUIDE).toContain("#### Keep a checkout current");
		expect(GUIDE).toMatch(/the pull itself stays with you/);
	});

	it("no longer describes the dialog's key as read-only, or the old dialog name", () => {
		expect(GUIDE).not.toMatch(/mints a read-only key/);
		expect(GUIDE).not.toMatch(/Connect your coding agent/);
		expect(GUIDE).toMatch(
			/carries `mcp:read`, `instructions:read` and `instructions:write`/,
		);
	});

	it("says a repository project's suggestion becomes a pull request, not that changes must be made in the repository", () => {
		expect(GUIDE).not.toMatch(/must make changes in that repository/);
		expect(GUIDE).toMatch(/commit on the proposer's own branch/);
	});

	it("never claims the gateway can publish", () => {
		expect(REFERENCE).toMatch(/no scope and no argument that publishes/);
		expect(GUIDE).toMatch(
			/Only a person with permission to edit coding instructions/,
		);
	});

	it("does not state a count of platform tools that has gone stale", () => {
		expect(REFERENCE).not.toMatch(/always present, 21 tools/);
	});
});
