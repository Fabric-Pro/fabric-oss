/**
 * Everything `fabric instructions` says about how a run ended, in one place.
 *
 * Each outcome is one fixed sentence and, where there is one, the single
 * thing to do next. The parameters are validated names (a project label, a
 * remote, a branch), never text a server or git wrote, so a line can reach a
 * coding agent's context without a scrubbing step: no digest, no class name
 * in parentheses, and no absolute path except an abandoned local lock that
 * needs explicit recovery. Exit codes are the CLI's documented
 * ones (`src/bin/fabric.ts`): 1 general, 2 usage, 3 auth, 4 not found,
 * 5 forbidden, 6 rate limited, 7 refused.
 *
 * Under `--hook` a line is printed only when the person or agent must know:
 * on stdout for what the agent has to act on (the checkout's state, a sign-in
 * that cannot be used, an upgrade), on stderr, behind
 * `fabric: coding instructions <verb> skipped:`, for everything that merely
 * stopped the check. The exit code is always 0 there. A line that starts
 * `fabric: coding instructions` carries that prefix itself.
 */
import { CliFailure } from "../command-boundary.js";
import { fabricCommand, isServedBundle } from "../launcher.js";
import { BAD_BASE_URL_LINE } from "../origin.js";
import { isSafeArgument, NO_COMMAND } from "../shell-words.js";
import { sanitizeDisplayText } from "./checks.js";
import type { InstructionsHookTool } from "./hook.js";

/** What every line a session hook prints starts with. */
export const HOOK_PREFIX = "fabric: coding instructions";

/** Why the checkout does not hold the published commit, and the one thing to do. */
export type BehindCondition =
	| { kind: "clean"; pull: string }
	| { kind: "dirty" }
	| { kind: "operation"; operation: string }
	| { kind: "detached" }
	| { kind: "other-branch"; branch: string };

type CheckoutTrait = "shallow" | "sparse" | "superproject";

const TRAIT_TEXT: Record<CheckoutTrait, string> = {
	shallow: " (shallow clone)",
	sparse: " (sparse checkout)",
	superproject: " (inside a superproject)",
};

export interface ProjectChoice {
	id: string;
	/** `organization/name` plus where in the repository it lives. */
	label: string;
}

/**
 * A run's missing sign-in. `otherProjects` is set when this machine holds a
 * sign-in to the deployment for some other project: the one missing is then
 * that project's, which is a different thing to fix than no sign-in at all.
 */
type SignedOutParams = {
	origin: string;
	project?: string;
	otherProjects?: boolean;
};

function forProject(
	project: string | undefined,
	otherProjects?: boolean,
): string {
	return project !== undefined && otherProjects === true
		? ` for project ${project} (it is signed in for other projects)`
		: "";
}

/** `host/path` of a repository, as every line names one. */
type Repo = string;

/**
 * A branch name or a host, which the deployment supplied: control characters
 * (C0, C1 and the line separators) become spaces and the length is bounded,
 * wherever the line is printed from.
 */
function shown(value: string): string {
	return sanitizeDisplayText(value, 255);
}

const MAX_BLOCKED_FILES = 3;

/** ` (a, b, c and 2 more)`, or nothing when git named no file. */
function blockedFilesText(files: readonly string[]): string {
	if (files.length === 0) {
		return "";
	}
	const named = files.slice(0, MAX_BLOCKED_FILES).map(shown).join(", ");
	const more = files.length - MAX_BLOCKED_FILES;
	return ` (${named}${more > 0 ? ` and ${more} more` : ""})`;
}

type CloneFailureClass =
	| "auth"
	| "network"
	| "missing-ref"
	| "checkout"
	| "old-git"
	| "other";

/** Why the hook did not fast-forward a checkout it left alone, for the reasons `behind` has no words for. */
export type FastForwardNotSafe =
	| "shallow"
	| "submodule"
	| "no-upstream"
	| "upstream-mismatch"
	| "git-busy"
	| "branch-busy";

export type FastForwardFetchFailure =
	| "auth"
	| "network"
	| "missing-ref"
	| "timeout"
	| "old-git"
	| "other";

/** Why the merge did not happen; only local changes name files. */
export type FastForwardMergeFailure =
	| { reason: "local-changes"; files: string[] }
	| { reason: "diverged" | "timeout" | "other" };

/**
 * Whether the person at the keyboard has something to do about this merge
 * failure (their branch has diverged, or local changes are in the way): it is
 * said on stdout, where the session reads it. Every other failure is a skip
 * for the log.
 */
export function isUserActionableMergeFailure(
	reason: FastForwardMergeFailure["reason"],
): boolean {
	return reason === "diverged" || reason === "local-changes";
}

/** Why Fabric's own copy is behind a branch tip the checkout has. */
export type FabricLag =
	| "refused"
	| "running"
	| "failed"
	| "paused"
	| "off"
	| "pending";

/**
 * The commands a line suggests, already shell-quoted by the caller: pull
 * fast-forward only, rebase, track the right branch, unshallow, and a fetch
 * of the branch.
 */
export interface FastForwardCommands {
	pull: string;
	rebase: string;
	setUpstream: string;
	unshallow: string;
	fetch: string;
}

const LAG_TEXT: Record<FabricLag, string> = {
	refused:
		"a commit was refused by the secret scan — see the project's Coding Instructions tab",
	running: "a sync is in progress",
	failed: "the last sync failed — see the project's Coding Instructions tab",
	paused: "automatic sync is paused — see the project's Coding Instructions tab",
	off: "automatic sync is off — see the project's Coding Instructions tab",
	pending: "the next sync has not run yet",
};

/** Parameters of each outcome, keyed by id. A new outcome starts here. */
export interface OutcomeParams {
	"needs-project": { verb: string };
	"no-remote": { verb: string };
	"remote-missing": { remote: string };
	"unreadable-checkout": { reason: string };
	"not-connected": { identity: string | null };
	"several-projects": { projects: ProjectChoice[] };
	"hook-needs-project": Record<string, never>;
	"bad-base-url": Record<string, never>;
	"unusable-base-url": Record<string, never>;
	"bad-project-id": Record<string, never>;
	"bad-org-slug": Record<string, never>;
	"bad-remote-name": Record<string, never>;
	/** `project` names the project whose sign-in is missing, when the run has one. */
	"not-signed-in": SignedOutParams;
	"hook-signed-out": SignedOutParams;
	"sign-in-failed": { origin: string; project?: string };
	"unknown-tool": { tool: string };
	"lessons-need-claude": Record<string, never>;
	"set-up": {
		repo: Repo | null;
		ref: string | null;
		tools: InstructionsHookTool[];
		/** The hook applies updates rather than only reporting them. */
		applies: boolean;
		/** The hook fast-forwards the branch at session start when that is safe. */
		fastForwards: boolean;
	};
	"no-tool-detected": Record<string, never>;
	"empty-folder": { repo: Repo; ref: string };
	/**
	 * The line that clones the repository and sets it up in one run. `project`
	 * is a validated id, `tool` the one `--tool` named (or `null`), `dir` is
	 * shell-quoted by the caller.
	 */
	"not-a-clone": {
		repo: Repo;
		project: string;
		tool: string | null;
		dir: string;
	};
	/** `where` is a shell-quoted relative path. */
	"wrong-folder": { repo: Repo; where: string };
	"several-remotes": { repo: Repo; remotes: string[] };
	"cloned-needs-folder": { repo: Repo; ref: string; where: string };
	/** `where` is a shell-quoted relative path from the folder the person ran it in. */
	"cloned-into": { where: string };
	"clone-needs-project": Record<string, never>;
	"clone-needs-repository": Record<string, never>;
	"clone-folder-in-use": Record<string, never>;
	"clone-checkout-needs-repair": Record<string, never>;
	"clone-failed": {
		repo: Repo;
		ref: string;
		host: string;
		/** Shell-quoted by the caller. */
		url: string;
		reason: CloneFailureClass;
		login: string;
	};
	"no-clone-url": { repo: Repo };
	"lock-removed": { repo: Repo };
	"exclude-failed": { entries: string[] };
	behind: {
		version: number;
		sha7: string;
		ref: string;
		/** The published commit is not in this clone at all, rather than not in HEAD. */
		notFetched: boolean;
		traits: CheckoutTrait[];
		condition: BehindCondition;
	};
	"behind-direct": {
		repo: Repo;
		sha7: string;
		ref: string;
		traits: CheckoutTrait[];
		condition: BehindCondition;
	};
	"earlier-source": {
		version: number;
		sourceRef: string;
		ref: string;
		repo: Repo;
	};
	"nothing-published": { repo: Repo };
	"already-current": {
		version: number;
		sha7: string | null;
		ref: string;
		repo: Repo;
	};
	"ff-fast-forwarded": {
		ref: string;
		/** Where the branch was, and where it is. */
		from7: string;
		sha7: string;
		/** The published version, when the new HEAD is the commit it was published from. */
		version: number | null;
	};
	"ff-not-safe": {
		reason: FastForwardNotSafe;
		ref: string;
		remote: string;
		commands: FastForwardCommands;
	};
	/** `auth` is printed as a line of its own; every other reason is a skip. */
	"ff-fetch-failed": {
		reason: FastForwardFetchFailure;
		repo: Repo;
		host: string;
		ref: string;
		login: string;
		commands: FastForwardCommands;
	};
	/** `diverged` is printed as a line of its own; the others are skips. */
	"ff-merge-failed": {
		failure: FastForwardMergeFailure;
		ref: string;
		remote: string;
		commands: FastForwardCommands;
	};
	"ff-locked": Record<string, never>;
	"ff-abandoned-lock": { lockPath: string };
	"ff-fabric-lags": { reason: FabricLag; ref: string; sha7: string };
	"class-foreign": { repo: Repo };
	"class-ambiguous": { repo: Repo; remotes: string[] };
	"class-unmapped": { repo: Repo; where: string };
	"class-unknown": { reason: string };
	"class-unknown-identity": Record<string, never>;
	"class-unsupported-provider": { provider: string };
	"lock-of-other-project": Record<string, never>;
	"sign-in-expired": { origin: string; project?: string };
	forbidden: Record<string, never>;
	/** `scope` is a permission name such as `instructions:publish`, when the deployment named one. */
	"missing-scope": { scope: string | null; origin: string };
	"proposal-limit-proposer": Record<string, never>;
	"proposal-limit-project": Record<string, never>;
	"note-rejected": Record<string, never>;
	"repository-needs-attention": Record<string, never>;
	"project-not-found": Record<string, never>;
	"request-refused": Record<string, never>;
	/** `line` is the deployment's own words, when it sent them. */
	"upgrade-required": { line: string | null };
	"rate-limited": Record<string, never>;
	unreachable: { origin: string };
	"server-error": { origin: string };
	"request-failed": Record<string, never>;
	"gave-up": { after: string };
}

export type OutcomeId = keyof OutcomeParams;

const TOOL_LABEL: Record<InstructionsHookTool, string> = {
	"claude-code": "Claude Code",
	codex: "Codex",
};

function sessionStartClause(
	tools: InstructionsHookTool[],
	applies: boolean,
): string {
	const names = tools.map((tool) => TOOL_LABEL[tool]);
	const single = names.length === 1;
	const verb = applies
		? `${single ? "applies" : "apply"} updates`
		: `${single ? "checks" : "check"} for updates`;
	return `${names.join(" and ")} ${verb} at every session start.`;
}

function fastForwardClause(tools: InstructionsHookTool[], ref: string): string {
	const names = tools.map((tool) => TOOL_LABEL[tool]);
	const verb = names.length === 1 ? "fast-forwards" : "fast-forward";
	return `${names.join(" and ")} ${verb} ${ref} at session start when safe.`;
}

/**
 * The sign-in command for a deployment, in the launcher this install runs, and
 * for one project of it when the run is for one: `project` is a validated id.
 */
function loginCommand(origin: string, project?: string): string {
	// An address that holds a character a shell reads is not written into a
	// line (`shell-words.ts`); the line says so and does not repeat it.
	if (!isSafeArgument(origin)) {
		return NO_COMMAND;
	}
	return fabricCommand(
		`auth login --base-url ${origin}${project === undefined ? "" : ` --project ${project}`}`,
		origin,
	);
}

/** What follows "this checkout is behind": the one thing to do for the state it is in. */
function behindAdvice(condition: BehindCondition, ref: string): string {
	switch (condition.kind) {
		case "clean":
			return ` — run: ${condition.pull}`;
		case "dirty":
			return " and has uncommitted changes — commit or stash, then pull.";
		case "operation":
			return `; a ${condition.operation} is in progress; nothing was changed.`;
		case "detached":
			return `; HEAD is detached — check out ${ref} and pull.`;
		case "other-branch":
			return `; you are on ${condition.branch} — pull ${ref} when you switch to it.`;
		default:
			return condition satisfies never;
	}
}

const LINES: { [K in OutcomeId]: (params: OutcomeParams[K]) => string } = {
	"needs-project": ({ verb }) =>
		`This folder is not a git checkout, so its project cannot be found. Run: ${fabricCommand(`instructions ${verb} --project <id>`)}`,
	"no-remote": ({ verb }) =>
		`This checkout has no remote, so its project cannot be found. Run: ${fabricCommand(`instructions ${verb} --project <id>`)}`,
	"remote-missing": ({ remote }) =>
		`This checkout has no remote named ${remote}. Run again with a remote it has, or with --project <id>.`,
	"unreadable-checkout": ({ reason }) =>
		`git could not read this checkout (${reason}). Run again with --project <id>.`,
	"not-connected": ({ identity }) =>
		`This checkout's ${identity === null ? "remotes are" : `remote (${identity}) is`} not connected to any project you can see. Connect the repository in Fabric first.`,
	"several-projects": ({ projects }) =>
		[
			`This repository is connected to ${projects.length} projects. Run again with one of:`,
			...projects.map(
				(project) => `  --project ${project.id}   ${project.label}`,
			),
		].join("\n"),
	"hook-needs-project": () =>
		`this hook names no project. Run: ${fabricCommand("instructions init")}`,
	"bad-base-url": () => BAD_BASE_URL_LINE,
	"unusable-base-url": () =>
		"The deployment address has characters a shell reads, so init will not write a session hook that carries it. Use an address of letters, digits, '.', '-' and a port.",
	"bad-project-id": () =>
		"--project must be a project id: letters, digits, '.', '_' or '-', starting with a letter or digit, at most 64 characters.",
	"bad-org-slug": () =>
		"--org must be an organization slug: letters, digits, '.', '_' or '-', starting with a letter or digit, at most 64 characters.",
	"bad-remote-name": () =>
		"--remote must be the name of a git remote: letters, digits, '.', '_', '-' and '/', starting with a letter, digit, '.' or '_'.",
	"not-signed-in": ({ origin, project, otherProjects }) =>
		`Not signed in to ${origin}${forProject(project, otherProjects)}. Run: ${loginCommand(origin, project)}`,
	"hook-signed-out": ({ origin, project, otherProjects }) =>
		`not signed in to ${origin}${forProject(project, otherProjects)} — run: ${loginCommand(origin, project)}`,
	"sign-in-failed": ({ origin, project }) =>
		`Could not sign in to ${origin}. Run: ${loginCommand(origin, project)} to see why.`,
	"unknown-tool": ({ tool }) =>
		`Unsupported tool "${tool}". Use --tool claude-code or --tool codex.`,
	"lessons-need-claude": () =>
		"--lessons is not yet supported for codex; Codex hooks for lesson capture are not wired.",
	"set-up": ({ repo, ref, tools, applies, fastForwards }) => {
		const where =
			repo === null
				? ""
				: ` for ${repo}${ref === null ? "" : ` (${shown(ref)})`}`;
		const trust = tools.includes("codex")
			? " In Codex, run /hooks once to trust the project hook."
			: "";
		const clause =
			fastForwards && ref !== null
				? fastForwardClause(tools, shown(ref))
				: sessionStartClause(tools, applies);
		return `Set up${where}. ${clause}${trust}`;
	},
	"no-tool-detected": () =>
		"No coding tool was found on this machine, so the Claude Code hook was written. Run again with --tool codex for Codex.",
	"empty-folder": ({ repo, ref }) =>
		`This folder is empty. Run: ${fabricCommand("instructions init --clone")} to clone ${repo} (${shown(ref)}) into it.`,
	"not-a-clone": ({ repo, project, tool, dir }) =>
		`This folder is not a clone of ${repo}. Run: ${fabricCommand(`instructions init --project ${project}${tool === null ? "" : ` --tool ${tool}`} --clone ${dir}`)}`,
	"wrong-folder": ({ repo, where }) =>
		`This checkout is ${repo}, but its instructions are in ${where}. Run: ${fabricCommand(`instructions init --dest ${where}`)}`,
	"several-remotes": ({ repo, remotes }) =>
		`Remotes ${remotes.join(", ")} all fetch from ${repo}. Run: ${fabricCommand(`instructions init --remote ${remotes[0] ?? "origin"}`)}`,
	"cloned-needs-folder": ({ repo, ref, where }) =>
		`Cloned ${repo} (${shown(ref)}). Its instructions are in ${where}. Run: ${fabricCommand(`instructions init --dest ${where}`)}`,
	"cloned-into": ({ where }) =>
		`Cloned into ${where}. Open your coding tool in that folder.`,
	"clone-needs-project": () =>
		"--clone <folder> needs --project <id>: there is no checkout yet to find the project from.",
	"clone-needs-repository": () =>
		"--clone needs a project whose instructions come from a git repository; this project's are uploaded, so there is nothing to clone.",
	"clone-folder-in-use": () =>
		"That folder already exists and is not empty, so nothing was cloned into it. Pick a folder that does not exist yet, or run init inside it when it already is the clone.",
	"clone-checkout-needs-repair": () =>
		"This folder appears to be an incomplete Git checkout. Fabric left it untouched. Inspect its staged and untracked files with git status, then repair or remove the checkout yourself before running init again.",
	"clone-failed": ({ repo, ref, host, url, reason, login }) => {
		switch (reason) {
			case "auth":
				return `Could not clone ${repo}: git has no credentials for ${shown(host)}. The Fabric MCP server was not registered. Run: ${login}`;
			case "network":
				return `Could not clone ${repo}: ${shown(host)} did not answer. The Fabric MCP server was not registered. Check your network and try again.`;
			case "missing-ref":
				return `Could not clone ${repo}: it has no branch ${shown(ref)}. The Fabric MCP server was not registered.`;
			case "checkout":
				return `Could not finish checking out ${repo}. Fabric did not change the partial checkout or register its MCP server. Inspect it with git status, then repair or remove it yourself before trying again.`;
			case "old-git":
				return `Could not clone ${repo}: this git is older than 2.31, which Fabric's repository transport needs. The Fabric MCP server was not registered. Update git and try again.`;
			case "other":
				return `Could not clone ${repo}. The Fabric MCP server was not registered. Run: git clone -- ${url} to see why.`;
			default:
				return reason satisfies never;
		}
	},
	"no-clone-url": ({ repo }) =>
		`This deployment did not say where to clone ${repo} from. Clone it yourself, then run: ${fabricCommand("instructions init")}`,
	"lock-removed": ({ repo }) =>
		`Removed .fabric/instructions.lock: this checkout follows ${repo} through git now.`,
	"exclude-failed": ({ entries }) =>
		`Could not update .git/info/exclude. Add these to your own ignore rules: ${entries.map(shown).join(" ")}`,
	behind: ({ version, sha7, ref, notFetched, traits, condition }) =>
		`${HOOK_PREFIX} v${version} (${sha7}) is on ${ref}; this checkout ${notFetched ? "has not fetched it yet" : "is behind"}${traits.map((trait) => TRAIT_TEXT[trait]).join("")}${behindAdvice(condition, ref)}`,
	"behind-direct": ({ repo, sha7, ref, traits, condition }) =>
		`${HOOK_PREFIX}: read directly from ${repo} at ${sha7}; this checkout is behind${traits.map((trait) => TRAIT_TEXT[trait]).join("")}${behindAdvice(condition, ref)}`,
	"earlier-source": ({ version, sourceRef, ref, repo }) =>
		`${HOOK_PREFIX} v${version} was published from ${sourceRef}; the project now syncs ${ref} of ${repo} — pull ${ref} to pick up the next publication`,
	"nothing-published": ({ repo }) =>
		`${HOOK_PREFIX}: the project is repository-sourced but nothing has been published from ${repo} yet`,
	"already-current": ({ version, sha7, ref, repo }) =>
		`${HOOK_PREFIX} v${version}${sha7 === null ? "" : ` (${sha7})`} from ${ref} of ${repo} is already in this checkout's history; nothing to sync`,
	"ff-fast-forwarded": ({ ref, from7, sha7, version }) =>
		`${HOOK_PREFIX}: fast-forwarded ${ref} from ${from7} to ${sha7}${version === null ? "" : ` (v${version})`}.`,
	"ff-not-safe": ({ reason, ref, remote, commands }) => {
		switch (reason) {
			case "shallow":
				return `${HOOK_PREFIX}: this is a shallow clone, so ${ref} was not updated. Run: ${commands.unshallow} && ${commands.pull}`;
			case "submodule":
				return `${HOOK_PREFIX}: this checkout is inside another repository, so ${ref} was not updated. Update it from the superproject.`;
			case "no-upstream":
				return `${HOOK_PREFIX}: ${ref} does not track ${remote}/${ref}, so it was not updated. Run: ${commands.setUpstream}`;
			case "upstream-mismatch":
				return `${HOOK_PREFIX}: ${ref} tracks another branch than ${remote}/${ref}, so it was not updated. Run: ${commands.setUpstream}`;
			case "git-busy":
				return `${HOOK_PREFIX}: git is busy in this checkout (an index.lock or HEAD.lock exists), so ${ref} was not updated. When it finishes, run: ${commands.pull}`;
			case "branch-busy":
				return `${HOOK_PREFIX}: ${ref} is checked out in another work tree of this repository, so it was not updated here. Update it there.`;
			default:
				return reason satisfies never;
		}
	},
	"ff-fetch-failed": ({ reason, repo, host, ref, login, commands }) => {
		switch (reason) {
			case "auth":
				return `${HOOK_PREFIX}: could not fetch ${repo}: git has no credentials for ${host}. Run: ${login}`;
			case "network":
				return `could not fetch ${repo}: ${host} did not answer; nothing was updated.`;
			case "missing-ref":
				return `could not fetch ${repo}: it has no branch ${ref}; nothing was updated.`;
			case "timeout":
				return `could not fetch ${repo}: ${host} answered too slowly; nothing was updated.`;
			case "old-git":
				return `${HOOK_PREFIX}: could not fetch ${repo}: this git is older than 2.31, which Fabric's repository transport needs. Update git.`;
			case "other":
				return `could not fetch ${repo}. Run: ${commands.fetch} to see why.`;
			default:
				return reason satisfies never;
		}
	},
	"ff-merge-failed": ({ failure, ref, remote, commands }) => {
		switch (failure.reason) {
			case "local-changes":
				return `${HOOK_PREFIX}: ${ref} is behind ${remote}/${ref}, but local changes would be overwritten${blockedFilesText(failure.files)}, so nothing was updated. Stash them or move them to another branch; the next session start updates this checkout on its own.`;
			case "diverged":
				return `${HOOK_PREFIX}: ${ref} and ${remote}/${ref} have diverged, so nothing was updated. Run: ${commands.rebase}, or merge ${remote}/${ref} yourself.`;
			case "timeout":
				return `updating ${ref} took too long; nothing was changed.`;
			case "other":
				return `git could not fast-forward ${ref}. Run: ${commands.pull} to see why.`;
			default:
				return failure satisfies never;
		}
	},
	"ff-locked": () =>
		`${HOOK_PREFIX}: another fabric process is updating this checkout; nothing was changed.`,
	"ff-abandoned-lock": ({ lockPath }) =>
		`${HOOK_PREFIX}: a previous Fabric process left its lock at ${JSON.stringify(lockPath)}; nothing was changed. Confirm it is no longer running, remove that lock, then run the hook again.`,
	"ff-fabric-lags": ({ reason, ref, sha7 }) =>
		`${HOOK_PREFIX}: ${ref} is at ${sha7}; Fabric's copy is behind (${LAG_TEXT[reason]}).`,
	"class-foreign": ({ repo }) =>
		`${HOOK_PREFIX}: no remote of this checkout fetches from ${repo}; nothing was checked.`,
	"class-ambiguous": ({ repo, remotes }) =>
		`${HOOK_PREFIX}: remotes ${remotes.join(", ")} all fetch from ${repo}; nothing was checked. Run: ${fabricCommand(`instructions init --remote ${remotes[0] ?? "origin"}`)}`,
	"class-unmapped": ({ repo, where }) =>
		`${HOOK_PREFIX}: this checkout is ${repo}, but the project's instructions are at ${where}, not this directory; nothing was checked.`,
	"class-unknown": ({ reason }) =>
		`${HOOK_PREFIX}: this git checkout could not be read (${reason}); nothing was checked.`,
	"class-unknown-identity": () =>
		`${HOOK_PREFIX}: the project is repository-sourced but reports no repository to compare with; nothing was checked.`,
	"class-unsupported-provider": ({ provider }) =>
		`${HOOK_PREFIX}: ${provider} repositories are not compared yet; nothing was checked.`,
	"lock-of-other-project": () =>
		"This folder was synced from a different project, so nothing was changed. Use another --dest, or delete .fabric/instructions.lock to start over.",
	"sign-in-expired": ({ origin, project }) =>
		`Your sign-in to ${origin} has expired. Run: ${loginCommand(origin, project)}`,
	forbidden: () =>
		"You do not have access to this project's coding instructions. Ask a project maintainer for access.",
	"missing-scope": ({ scope, origin }) =>
		`This credential is missing ${scope === null ? "a permission this needs" : `the ${scope} permission`}. Create a key that carries it, or run: ${loginCommand(origin)}`,
	"proposal-limit-proposer": () =>
		"You already have five active coding-instructions proposals on this project. Wait for one to be reviewed, or withdraw one. Nothing was sent.",
	"proposal-limit-project": () =>
		"This project already has as many active coding-instructions proposals as it allows. Wait for some to be reviewed. Nothing was sent.",
	"note-rejected": () =>
		"The note was refused: it is too long or holds text that is not allowed. Change --message and push again; nothing was sent.",
	"repository-needs-attention": () =>
		"This project's repository connection needs attention before a change can be suggested to it; nothing was sent.",
	"project-not-found": () => "Project not found, or you cannot see it.",
	"request-refused": () => "The deployment refused the request as invalid.",
	"upgrade-required": ({ line }) =>
		line ??
		(isServedBundle()
			? "This CLI is older than the deployment expects. Run the project's setup line from its Connect dialog again to get the current one."
			: "This CLI is older than the deployment expects. Run: npm install -g @fabricorg/cli"),
	"rate-limited": () => "Too many requests. Wait a minute and try again.",
	unreachable: ({ origin }) =>
		`Could not reach ${origin}. Check your network and try again.`,
	"server-error": ({ origin }) =>
		`${origin} had a problem answering. Try again in a moment.`,
	"request-failed": () =>
		"The request failed. Try again, or run with FABRIC_DEBUG=1 to see why.",
	"gave-up": ({ after }) => `gave up after ${after}`,
};

const EXIT_CODES: {
	[K in OutcomeId]: number | ((params: OutcomeParams[K]) => number);
} = {
	"needs-project": 2,
	"no-remote": 2,
	"remote-missing": 2,
	"unreadable-checkout": 7,
	"not-connected": 4,
	"several-projects": 2,
	"hook-needs-project": 2,
	"bad-base-url": 2,
	"unusable-base-url": 2,
	"bad-project-id": 2,
	"bad-org-slug": 2,
	"bad-remote-name": 2,
	"not-signed-in": 3,
	"hook-signed-out": 3,
	"sign-in-failed": 3,
	"unknown-tool": 2,
	"lessons-need-claude": 2,
	"set-up": 0,
	"no-tool-detected": 0,
	"empty-folder": 2,
	"not-a-clone": 7,
	"wrong-folder": 7,
	"several-remotes": 7,
	"cloned-needs-folder": 0,
	"cloned-into": 0,
	"clone-needs-project": 2,
	"clone-needs-repository": 7,
	"clone-folder-in-use": 7,
	"clone-checkout-needs-repair": 7,
	"clone-failed": ({ reason }) =>
		reason === "auth" ? 3 : reason === "missing-ref" ? 7 : 1,
	"no-clone-url": 7,
	"lock-removed": 0,
	"exclude-failed": 0,
	behind: 0,
	"behind-direct": 0,
	"earlier-source": 0,
	"nothing-published": 0,
	"already-current": 0,
	"ff-fast-forwarded": 0,
	"ff-not-safe": 0,
	"ff-fetch-failed": 0,
	"ff-merge-failed": 0,
	"ff-locked": 0,
	"ff-abandoned-lock": 0,
	"ff-fabric-lags": 0,
	"class-foreign": 7,
	"class-ambiguous": 7,
	"class-unmapped": 7,
	"class-unknown": 7,
	"class-unknown-identity": 7,
	"class-unsupported-provider": 7,
	"lock-of-other-project": 7,
	"sign-in-expired": 3,
	forbidden: 5,
	"missing-scope": 5,
	"proposal-limit-proposer": 7,
	"proposal-limit-project": 7,
	"note-rejected": 7,
	"repository-needs-attention": 7,
	"project-not-found": 4,
	"request-refused": 7,
	"upgrade-required": 2,
	"rate-limited": 6,
	unreachable: 1,
	"server-error": 1,
	"request-failed": 1,
	"gave-up": 1,
};

export function outcomeLine<K extends OutcomeId>(
	id: K,
	params: OutcomeParams[K],
): string {
	return LINES[id](params);
}

/** The failure a run ends with when it stopped at this outcome. */
export function outcomeFailure<K extends OutcomeId>(
	id: K,
	params: OutcomeParams[K],
): CliFailure {
	const code: number | ((params: OutcomeParams[K]) => number) =
		EXIT_CODES[id];
	return new CliFailure(
		outcomeLine(id, params),
		typeof code === "function" ? code(params) : code,
	);
}
