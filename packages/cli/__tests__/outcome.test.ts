/**
 * Every line `fabric instructions` can end a run with (Fizzy #2878), pinned in
 * one place: the closed set of outcomes in `outcome.ts`, each with one fixed
 * sentence and its one next action. The list is keyed by outcome id and typed
 * so that adding an outcome without a sample here does not compile.
 *
 * The invariants the output contract promises are checked over the whole set:
 * no absolute path, no digest, no class name in parentheses, one line (the
 * list of projects excepted), and nothing a server or git would have written.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	HOOK_PREFIX,
	type OutcomeId,
	type OutcomeParams,
	outcomeFailure,
	outcomeLine,
} from "../src/lib/instructions/outcome.js";

const COMMANDS = {
	pull: "git pull --ff-only origin main",
	rebase: "git pull --rebase origin main",
	setUpstream: "git branch --set-upstream-to=origin/main main",
	unshallow: "git fetch --unshallow origin",
	fetch: "git fetch origin main",
};

const SAMPLES: { [K in OutcomeId]: OutcomeParams[K] } = {
	"needs-project": { verb: "check" },
	"no-remote": { verb: "sync" },
	"remote-missing": { remote: "upstream" },
	"unreadable-checkout": { reason: "git timed out" },
	"not-connected": { identity: "github.com/example-org/rules" },
	"several-projects": {
		projects: [
			{ id: "project-a", label: "example-org/Rules A" },
			{ id: "project-b", label: "example-org/Rules B (docs/ai)" },
		],
	},
	"hook-needs-project": {},
	"bad-base-url": {},
	"unusable-base-url": {},
	"bad-project-id": {},
	"bad-org-slug": {},
	"bad-remote-name": {},
	"not-signed-in": { origin: "https://fabric.pro" },
	"hook-signed-out": { origin: "https://fabric.pro" },
	"sign-in-failed": { origin: "https://fabric.pro" },
	"unknown-tool": { tool: "cursor" },
	"lessons-need-claude": {},
	"set-up": {
		repo: "github.com/example-org/rules",
		ref: "main",
		tools: ["claude-code", "codex"],
		applies: false,
		fastForwards: false,
	},
	"no-tool-detected": {},
	"empty-folder": { repo: "github.com/example-org/rules", ref: "main" },
	"not-a-clone": {
		repo: "github.com/example-org/rules",
		project: "project-1",
		tool: "claude-code",
		dir: "rules",
	},
	"wrong-folder": { repo: "github.com/example-org/rules", where: "docs/ai" },
	"several-remotes": {
		repo: "github.com/example-org/rules",
		remotes: ["origin", "upstream"],
	},
	"cloned-needs-folder": {
		repo: "github.com/example-org/rules",
		ref: "main",
		where: "docs/ai",
	},
	"cloned-into": { where: "rules/docs" },
	"clone-needs-project": {},
	"clone-needs-repository": {},
	"clone-folder-in-use": {},
	"clone-checkout-needs-repair": {},
	"clone-failed": {
		repo: "github.com/example-org/rules",
		ref: "main",
		host: "github.com",
		url: "https://github.com/example-org/rules",
		reason: "auth",
		login: "gh auth login",
	},
	"no-clone-url": {
		repo: "dev.azure.com/example-org/Example Project/_git/rules",
	},
	"lock-removed": { repo: "github.com/example-org/rules" },
	"exclude-failed": {
		entries: ["/.claude/settings.local.json", "/.codex/hooks.json"],
	},
	behind: {
		version: 12,
		sha7: "a1b2c3d",
		ref: "main",
		notFetched: false,
		traits: [],
		condition: { kind: "clean", pull: "git pull --ff-only origin main" },
	},
	"behind-direct": {
		repo: "github.com/example-org/rules",
		sha7: "a1b2c3d",
		ref: "main",
		traits: [],
		condition: { kind: "clean", pull: "git pull --ff-only origin main" },
	},
	"earlier-source": {
		version: 12,
		sourceRef: "release",
		ref: "main",
		repo: "github.com/example-org/rules",
	},
	"nothing-published": { repo: "github.com/example-org/rules" },
	"already-current": {
		version: 12,
		sha7: "a1b2c3d",
		ref: "main",
		repo: "github.com/example-org/rules",
	},
	"ff-fast-forwarded": {
		ref: "main",
		from7: "9f8e7d6",
		sha7: "a1b2c3d",
		version: 12,
	},
	"ff-not-safe": {
		reason: "no-upstream",
		ref: "main",
		remote: "origin",
		commands: COMMANDS,
	},
	"ff-fetch-failed": {
		reason: "auth",
		repo: "github.com/example-org/rules",
		host: "github.com",
		ref: "main",
		login: "gh auth login",
		commands: COMMANDS,
	},
	"ff-merge-failed": {
		failure: { reason: "diverged" },
		ref: "main",
		remote: "origin",
		commands: COMMANDS,
	},
	"ff-locked": {},
	"ff-abandoned-lock": { lockPath: "/work/.git/fabric/ff.lock" },
	"ff-fabric-lags": { reason: "refused", ref: "main", sha7: "a1b2c3d" },
	"class-foreign": { repo: "github.com/example-org/rules" },
	"class-ambiguous": {
		repo: "github.com/example-org/rules",
		remotes: ["origin", "upstream"],
	},
	"class-unmapped": {
		repo: "github.com/example-org/rules",
		where: "docs/ai",
	},
	"class-unknown": { reason: "git timed out" },
	"class-unknown-identity": {},
	"class-unsupported-provider": { provider: "BITBUCKET" },
	"lock-of-other-project": {},
	"sign-in-expired": { origin: "https://fabric.pro" },
	forbidden: {},
	"missing-scope": {
		scope: "instructions:publish",
		origin: "https://fabric.pro",
	},
	"proposal-limit-proposer": {},
	"proposal-limit-project": {},
	"note-rejected": {},
	"repository-needs-attention": {},
	"project-not-found": {},
	"request-refused": {},
	"upgrade-required": { line: null },
	"rate-limited": {},
	unreachable: { origin: "https://fabric.pro" },
	"server-error": { origin: "https://fabric.pro" },
	"request-failed": {},
	"gave-up": { after: "10 s" },
};

function render<K extends OutcomeId>(id: K): string {
	return outcomeLine(id, SAMPLES[id]);
}

const IDS = Object.keys(SAMPLES) as OutcomeId[];

describe("the outcome lines", () => {
	it("are exactly these, one per outcome", () => {
		expect(
			Object.fromEntries(IDS.map((id) => [id, render(id)])),
		).toMatchInlineSnapshot(`
			{
			  "already-current": "fabric: coding instructions v12 (a1b2c3d) from main of github.com/example-org/rules is already in this checkout's history; nothing to sync",
			  "bad-base-url": "The deployment address is not a URL. Use --base-url https://example.com",
			  "bad-org-slug": "--org must be an organization slug: letters, digits, '.', '_' or '-', starting with a letter or digit, at most 64 characters.",
			  "bad-project-id": "--project must be a project id: letters, digits, '.', '_' or '-', starting with a letter or digit, at most 64 characters.",
			  "bad-remote-name": "--remote must be the name of a git remote: letters, digits, '.', '_', '-' and '/', starting with a letter, digit, '.' or '_'.",
			  "behind": "fabric: coding instructions v12 (a1b2c3d) is on main; this checkout is behind — run: git pull --ff-only origin main",
			  "behind-direct": "fabric: coding instructions: read directly from github.com/example-org/rules at a1b2c3d; this checkout is behind — run: git pull --ff-only origin main",
			  "class-ambiguous": "fabric: coding instructions: remotes origin, upstream all fetch from github.com/example-org/rules; nothing was checked. Run: fabric instructions init --remote origin",
			  "class-foreign": "fabric: coding instructions: no remote of this checkout fetches from github.com/example-org/rules; nothing was checked.",
			  "class-unknown": "fabric: coding instructions: this git checkout could not be read (git timed out); nothing was checked.",
			  "class-unknown-identity": "fabric: coding instructions: the project is repository-sourced but reports no repository to compare with; nothing was checked.",
			  "class-unmapped": "fabric: coding instructions: this checkout is github.com/example-org/rules, but the project's instructions are at docs/ai, not this directory; nothing was checked.",
			  "class-unsupported-provider": "fabric: coding instructions: BITBUCKET repositories are not compared yet; nothing was checked.",
			  "clone-checkout-needs-repair": "This folder appears to be an incomplete Git checkout. Fabric left it untouched. Inspect its staged and untracked files with git status, then repair or remove the checkout yourself before running init again.",
			  "clone-failed": "Could not clone github.com/example-org/rules: git has no credentials for github.com. The Fabric MCP server was not registered. Run: gh auth login",
			  "clone-folder-in-use": "That folder already exists and is not empty, so nothing was cloned into it. Pick a folder that does not exist yet, or run init inside it when it already is the clone.",
			  "clone-needs-project": "--clone <folder> needs --project <id>: there is no checkout yet to find the project from.",
			  "clone-needs-repository": "--clone needs a project whose instructions come from a git repository; this project's are uploaded, so there is nothing to clone.",
			  "cloned-into": "Cloned into rules/docs. Open your coding tool in that folder.",
			  "cloned-needs-folder": "Cloned github.com/example-org/rules (main). Its instructions are in docs/ai. Run: fabric instructions init --dest docs/ai",
			  "earlier-source": "fabric: coding instructions v12 was published from release; the project now syncs main of github.com/example-org/rules — pull main to pick up the next publication",
			  "empty-folder": "This folder is empty. Run: fabric instructions init --clone to clone github.com/example-org/rules (main) into it.",
			  "exclude-failed": "Could not update .git/info/exclude. Add these to your own ignore rules: /.claude/settings.local.json /.codex/hooks.json",
			  "ff-abandoned-lock": "fabric: coding instructions: a previous Fabric process left its lock at "/work/.git/fabric/ff.lock"; nothing was changed. Confirm it is no longer running, remove that lock, then run the hook again.",
			  "ff-fabric-lags": "fabric: coding instructions: main is at a1b2c3d; Fabric's copy is behind (a commit was refused by the secret scan — see the project's Coding Instructions tab).",
			  "ff-fast-forwarded": "fabric: coding instructions: fast-forwarded main from 9f8e7d6 to a1b2c3d (v12).",
			  "ff-fetch-failed": "fabric: coding instructions: could not fetch github.com/example-org/rules: git has no credentials for github.com. Run: gh auth login",
			  "ff-locked": "fabric: coding instructions: another fabric process is updating this checkout; nothing was changed.",
			  "ff-merge-failed": "fabric: coding instructions: main and origin/main have diverged, so nothing was updated. Run: git pull --rebase origin main, or merge origin/main yourself.",
			  "ff-not-safe": "fabric: coding instructions: main does not track origin/main, so it was not updated. Run: git branch --set-upstream-to=origin/main main",
			  "forbidden": "You do not have access to this project's coding instructions. Ask a project maintainer for access.",
			  "gave-up": "gave up after 10 s",
			  "hook-needs-project": "this hook names no project. Run: fabric instructions init",
			  "hook-signed-out": "not signed in to https://fabric.pro — run: fabric auth login --base-url https://fabric.pro",
			  "lessons-need-claude": "--lessons is not yet supported for codex; Codex hooks for lesson capture are not wired.",
			  "lock-of-other-project": "This folder was synced from a different project, so nothing was changed. Use another --dest, or delete .fabric/instructions.lock to start over.",
			  "lock-removed": "Removed .fabric/instructions.lock: this checkout follows github.com/example-org/rules through git now.",
			  "missing-scope": "This credential is missing the instructions:publish permission. Create a key that carries it, or run: fabric auth login --base-url https://fabric.pro",
			  "needs-project": "This folder is not a git checkout, so its project cannot be found. Run: fabric instructions check --project <id>",
			  "no-clone-url": "This deployment did not say where to clone dev.azure.com/example-org/Example Project/_git/rules from. Clone it yourself, then run: fabric instructions init",
			  "no-remote": "This checkout has no remote, so its project cannot be found. Run: fabric instructions sync --project <id>",
			  "no-tool-detected": "No coding tool was found on this machine, so the Claude Code hook was written. Run again with --tool codex for Codex.",
			  "not-a-clone": "This folder is not a clone of github.com/example-org/rules. Run: fabric instructions init --project project-1 --tool claude-code --clone rules",
			  "not-connected": "This checkout's remote (github.com/example-org/rules) is not connected to any project you can see. Connect the repository in Fabric first.",
			  "not-signed-in": "Not signed in to https://fabric.pro. Run: fabric auth login --base-url https://fabric.pro",
			  "note-rejected": "The note was refused: it is too long or holds text that is not allowed. Change --message and push again; nothing was sent.",
			  "nothing-published": "fabric: coding instructions: the project is repository-sourced but nothing has been published from github.com/example-org/rules yet",
			  "project-not-found": "Project not found, or you cannot see it.",
			  "proposal-limit-project": "This project already has as many active coding-instructions proposals as it allows. Wait for some to be reviewed. Nothing was sent.",
			  "proposal-limit-proposer": "You already have five active coding-instructions proposals on this project. Wait for one to be reviewed, or withdraw one. Nothing was sent.",
			  "rate-limited": "Too many requests. Wait a minute and try again.",
			  "remote-missing": "This checkout has no remote named upstream. Run again with a remote it has, or with --project <id>.",
			  "repository-needs-attention": "This project's repository connection needs attention before a change can be suggested to it; nothing was sent.",
			  "request-failed": "The request failed. Try again, or run with FABRIC_DEBUG=1 to see why.",
			  "request-refused": "The deployment refused the request as invalid.",
			  "server-error": "https://fabric.pro had a problem answering. Try again in a moment.",
			  "set-up": "Set up for github.com/example-org/rules (main). Claude Code and Codex check for updates at every session start. In Codex, run /hooks once to trust the project hook.",
			  "several-projects": "This repository is connected to 2 projects. Run again with one of:
			  --project project-a   example-org/Rules A
			  --project project-b   example-org/Rules B (docs/ai)",
			  "several-remotes": "Remotes origin, upstream all fetch from github.com/example-org/rules. Run: fabric instructions init --remote origin",
			  "sign-in-expired": "Your sign-in to https://fabric.pro has expired. Run: fabric auth login --base-url https://fabric.pro",
			  "sign-in-failed": "Could not sign in to https://fabric.pro. Run: fabric auth login --base-url https://fabric.pro to see why.",
			  "unknown-tool": "Unsupported tool "cursor". Use --tool claude-code or --tool codex.",
			  "unreachable": "Could not reach https://fabric.pro. Check your network and try again.",
			  "unreadable-checkout": "git could not read this checkout (git timed out). Run again with --project <id>.",
			  "unusable-base-url": "The deployment address has characters a shell reads, so init will not write a session hook that carries it. Use an address of letters, digits, '.', '-' and a port.",
			  "upgrade-required": "This CLI is older than the deployment expects. Run: npm install -g @fabricorg/cli",
			  "wrong-folder": "This checkout is github.com/example-org/rules, but its instructions are in docs/ai. Run: fabric instructions init --dest docs/ai",
			}
		`);
	});

	it.each(IDS.filter((id) => id !== "ff-abandoned-lock"))(
		"%s: no absolute path, digest, or class name in parentheses",
		(id) => {
			const text = render(id);

			expect(text).not.toMatch(/[A-Za-z]:\\/);
			expect(text).not.toMatch(/(^|\s)\/(Users|home|tmp|var|private)\//);
			expect(text).not.toMatch(/\b[0-9a-f]{64}\b/i);
			expect(text).not.toMatch(
				/\((?:foreign|ambiguous|unmapped|unknown|unsupported)[^)]*\)/i,
			);
			expect(text).not.toMatch(/\s$/);
		},
	);

	it.each(IDS.filter((id) => id !== "several-projects"))(
		"%s is one line",
		(id) => {
			expect(render(id)).not.toContain("\n");
		},
	);

	it.each([
		[
			["claude-code"],
			"Set up for github.com/example-org/rules (main). Claude Code fast-forwards main at session start when safe.",
		],
		[
			["claude-code", "codex"],
			"Set up for github.com/example-org/rules (main). Claude Code and Codex fast-forward main at session start when safe. In Codex, run /hooks once to trust the project hook.",
		],
	] as const)(
		"says what a fast-forwarding hook does for %j",
		(tools, expected) => {
			expect(
				outcomeLine("set-up", {
					repo: "github.com/example-org/rules",
					ref: "main",
					tools: [...tools],
					applies: false,
					fastForwards: true,
				}),
			).toBe(expected);
		},
	);

	it("says a hook that only reports checks for updates, even for a repository", () => {
		expect(
			outcomeLine("set-up", {
				repo: "github.com/example-org/rules",
				ref: "main",
				tools: ["claude-code"],
				applies: false,
				fastForwards: false,
			}),
		).toBe(
			"Set up for github.com/example-org/rules (main). Claude Code checks for updates at every session start.",
		);
	});

	it("lists several projects one per line, each with the --project to pass", () => {
		expect(render("several-projects").split("\n")).toEqual([
			"This repository is connected to 2 projects. Run again with one of:",
			"  --project project-a   example-org/Rules A",
			"  --project project-b   example-org/Rules B (docs/ai)",
		]);
	});

	it("every line a session hook prints on its own starts with the hook prefix", () => {
		for (const id of [
			"behind",
			"earlier-source",
			"nothing-published",
			"already-current",
			"ff-fast-forwarded",
			"ff-not-safe",
			"ff-fetch-failed",
			"ff-merge-failed",
			"ff-locked",
			"ff-abandoned-lock",
			"ff-fabric-lags",
			"class-foreign",
			"class-ambiguous",
			"class-unmapped",
			"class-unknown",
			"class-unknown-identity",
			"class-unsupported-provider",
		] as const) {
			expect(render(id).startsWith(HOOK_PREFIX)).toBe(true);
		}
	});
});

describe("the exit code of an outcome that stops a run", () => {
	it.each([
		["needs-project", 2],
		["bad-base-url", 2],
		["unusable-base-url", 2],
		["bad-project-id", 2],
		["bad-org-slug", 2],
		["bad-remote-name", 2],
		["not-connected", 4],
		["several-projects", 2],
		["not-signed-in", 3],
		["sign-in-expired", 3],
		["forbidden", 5],
		["missing-scope", 5],
		["project-not-found", 4],
		["rate-limited", 6],
		["lock-of-other-project", 7],
		["not-a-clone", 7],
		["clone-needs-project", 2],
		["clone-needs-repository", 7],
		["clone-folder-in-use", 7],
		["class-foreign", 7],
		["unreachable", 1],
		["upgrade-required", 2],
	] as const)("%s ends with %i", (id, code) => {
		const failure = outcomeFailure(id, SAMPLES[id]);

		expect(failure.exitCode).toBe(code);
		expect(failure.message).toBe(render(id));
	});

	it.each([
		["auth", 3],
		["network", 1],
		["missing-ref", 7],
		["other", 1],
	] as const)("a clone that fails with %s ends with %i", (reason, code) => {
		expect(
			outcomeFailure("clone-failed", {
				...SAMPLES["clone-failed"],
				reason,
			}).exitCode,
		).toBe(code);
	});

	it("uses the deployment's own upgrade line when it sent one", () => {
		expect(
			outcomeLine("upgrade-required", {
				line: "This CLI is older than the deployment expects. Run: npx -y https://fabric.pro/cli/fabric-0.6.0.tgz instructions init",
			}),
		).toBe(
			"This CLI is older than the deployment expects. Run: npx -y https://fabric.pro/cli/fabric-0.6.0.tgz instructions init",
		);
	});
});

describe("a sign-in line for a deployment address no command can carry", () => {
	const ADDRESSES = [
		"https://a.example.com$(id).x",
		"https://a.example.com&calc.exe",
		"https://a.example.com;ls",
		"https://a.example.com`id`",
		"https://a.example.com'x",
		"https://a.example.com!x",
		"https://a.example.com~x",
		"https://a.example.com,x",
	].map((address) => new URL(address).origin);

	/** What follows "Run: " or "run: ", up to the end of the sentence. */
	function afterRun(line: string): string {
		return line.slice(line.search(/[Rr]un: /) + "Run: ".length);
	}

	it.each(ADDRESSES)("never makes a command of %s", (origin) => {
		for (const id of [
			"not-signed-in",
			"hook-signed-out",
			"sign-in-failed",
			"sign-in-expired",
		] as const) {
			for (const project of [undefined, "project-example-one"]) {
				const line = outcomeLine(id, { origin, project });

				expect(afterRun(line)).toContain(
					"<no command: the deployment address cannot be written into one>",
				);
				expect(afterRun(line)).not.toContain("a.example.com");
				expect(afterRun(line)).not.toContain("fabric auth login");
			}
		}
		const missingScope = outcomeLine("missing-scope", {
			origin,
			scope: "instructions:read",
		});
		expect(afterRun(missingScope)).not.toContain("a.example.com");
		expect(afterRun(missingScope)).toContain("<no command:");
	});

	it("is a line to paste for an address that is plain", () => {
		expect(
			outcomeLine("not-signed-in", {
				origin: "http://localhost:3001",
				project: "project-1",
			}),
		).toBe(
			"Not signed in to http://localhost:3001. Run: fabric auth login --base-url http://localhost:3001 --project project-1",
		);
	});
});

describe("the checkout report lines", () => {
	const base: Omit<OutcomeParams["behind"], "condition"> = {
		version: 12,
		sha7: "a1b2c3d",
		ref: "main",
		notFetched: false,
		traits: [],
	};

	it.each([
		[
			"behind and clean: one command to run",
			{ kind: "clean", pull: "git pull --ff-only origin main" },
			"fabric: coding instructions v12 (a1b2c3d) is on main; this checkout is behind — run: git pull --ff-only origin main",
		],
		[
			"behind with uncommitted changes",
			{ kind: "dirty" },
			"fabric: coding instructions v12 (a1b2c3d) is on main; this checkout is behind and has uncommitted changes — commit or stash, then pull.",
		],
		[
			"on another branch",
			{ kind: "other-branch", branch: "feature/x" },
			"fabric: coding instructions v12 (a1b2c3d) is on main; this checkout is behind; you are on feature/x — pull main when you switch to it.",
		],
		[
			"detached",
			{ kind: "detached" },
			"fabric: coding instructions v12 (a1b2c3d) is on main; this checkout is behind; HEAD is detached — check out main and pull.",
		],
		[
			"an operation in progress",
			{ kind: "operation", operation: "rebase" },
			"fabric: coding instructions v12 (a1b2c3d) is on main; this checkout is behind; a rebase is in progress; nothing was changed.",
		],
	] as const)("%s", (_label, condition, expected) => {
		expect(outcomeLine("behind", { ...base, condition })).toBe(expected);
	});

	it.each([
		[
			{ kind: "clean", pull: "git pull --ff-only origin main" },
			"fabric: coding instructions: read directly from github.com/example-org/rules at a1b2c3d; this checkout is behind — run: git pull --ff-only origin main",
		],
		[
			{ kind: "other-branch", branch: "feature/x" },
			"fabric: coding instructions: read directly from github.com/example-org/rules at a1b2c3d; this checkout is behind; you are on feature/x — pull main when you switch to it.",
		],
		[
			{ kind: "detached" },
			"fabric: coding instructions: read directly from github.com/example-org/rules at a1b2c3d; this checkout is behind; HEAD is detached — check out main and pull.",
		],
		[
			{ kind: "dirty" },
			"fabric: coding instructions: read directly from github.com/example-org/rules at a1b2c3d; this checkout is behind and has uncommitted changes — commit or stash, then pull.",
		],
	] as const)("a direct read behind: %j", (condition, expected) => {
		expect(
			outcomeLine("behind-direct", {
				repo: "github.com/example-org/rules",
				sha7: "a1b2c3d",
				ref: "main",
				traits: [],
				condition,
			}),
		).toBe(expected);
	});

	it("says which project is missing a sign-in when the machine is signed in for others", () => {
		expect(
			outcomeLine("hook-signed-out", {
				origin: "https://fabric.pro",
				project: "project-2",
				otherProjects: true,
			}),
		).toBe(
			"not signed in to https://fabric.pro for project project-2 (it is signed in for other projects) — run: fabric auth login --base-url https://fabric.pro --project project-2",
		);
	});

	it("says the commit has not been fetched when it is not in the clone at all", () => {
		expect(
			outcomeLine("behind", {
				...base,
				notFetched: true,
				condition: {
					kind: "clean",
					pull: "git pull --ff-only origin main",
				},
			}),
		).toBe(
			"fabric: coding instructions v12 (a1b2c3d) is on main; this checkout has not fetched it yet — run: git pull --ff-only origin main",
		);
	});

	it("names a shallow clone, a sparse checkout and a superproject right after the state", () => {
		expect(
			outcomeLine("behind", {
				...base,
				traits: ["shallow", "sparse", "superproject"],
				condition: { kind: "dirty" },
			}),
		).toBe(
			"fabric: coding instructions v12 (a1b2c3d) is on main; this checkout is behind (shallow clone) (sparse checkout) (inside a superproject) and has uncommitted changes — commit or stash, then pull.",
		);
	});
});

describe("the remedies a session hook prints, from the served build", () => {
	const ORIGIN = "https://fabric.example.com";
	const TARBALL = "/cli/fabric-0.5.0-0123456789.tgz";

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("are the short npx command, not the path of the copy the hook runs", () => {
		vi.stubGlobal("__FABRIC_BUNDLE__", true);
		vi.stubGlobal("__FABRIC_BUNDLE_TARBALL__", TARBALL);
		vi.stubGlobal("__FABRIC_BAKED_ORIGIN__", ORIGIN);

		expect(outcomeLine("hook-needs-project", {})).toBe(
			`this hook names no project. Run: npx -y ${ORIGIN}${TARBALL} instructions init`,
		);
		expect(outcomeLine("hook-signed-out", { origin: ORIGIN })).toBe(
			`not signed in to ${ORIGIN} — run: npx -y ${ORIGIN}${TARBALL} auth login --base-url ${ORIGIN}`,
		);
	});
});
