/**
 * What kind of directory a repository-sourced project's hook is running in,
 * and what it should say there (Fizzy #2708).
 *
 * A project whose coding instructions come from a git repository publishes a
 * snapshot from one commit on one branch. In a checkout of that repository
 * the files already arrive with `git pull`, so the hook's job there is to
 * REPORT — "the published commit is not in your history yet" — and never to
 * write: no download, no lock, no git command that changes anything.
 * Automatic fast-forwarding is separate work and not part of this module.
 *
 * Elsewhere — a directory that is not a git checkout at all — the project's
 * published snapshot is the only way to read its instructions, so the upload
 * behaviour applies unchanged. Everything in between (a checkout of some
 * other repository, one this cannot read, one with two remotes for the same
 * repository, the right repository in the wrong directory) gets one line
 * saying which case it is, and nothing is written.
 *
 * `classifyCheckout` decides which case; `inspectMatchingCheckout` gathers the
 * facts for the matching one; `matchingReport`, `matchingReportLine` and `classLine` are the
 * pure halves that turn those into the one line a session reads.
 */
import { realpath } from "node:fs/promises";
import path from "node:path";
import type {
	PublishedInstructionRepository,
	PublishedInstructionSnapshot,
} from "@fabricorg/sdk";
import { sanitizeDisplayText } from "./checks.js";
import type { CheckoutTraits, GitDeadline, GitOperation } from "./git.js";
import * as git from "./git.js";
import { type BehindCondition, outcomeLine } from "./outcome.js";
import {
	hasComparableIdentity,
	matches,
	parseRemoteUrl,
} from "./repository-identity.js";

type CheckoutClass =
	| "not-git"
	| "unknown"
	| "unknown-identity"
	| "unsupported-provider"
	| "foreign"
	| "ambiguous"
	| "unmapped"
	| "matching";

export type CheckoutClassification =
	| { class: "not-git" }
	| { class: "unknown"; reason: string }
	| { class: "unknown-identity" }
	| { class: "unsupported-provider"; provider: string }
	| { class: "foreign" }
	| { class: "ambiguous"; remotes: string[] }
	| { class: "unmapped"; rootPath: string; toplevel: string }
	| {
			class: "matching";
			remote: string;
			toplevel: string;
			traits: CheckoutTraits;
	  };

/**
 * When the tree's content is compared with the index: `always` (`check`'s
 * JSON reports it), or only `when-behind`, where a line needs it (the hook).
 */
export type ContentChanges = "always" | "when-behind";

/** Everything the matching report reads from the checkout. */
export interface CheckoutState {
	/** The checked-out branch, or `null` for a detached HEAD. */
	branch: string | null;
	head: string | null;
	/**
	 * No tracked file's CONTENT differs from the index or HEAD (a file that
	 * differs only in how its line endings are stored does not count).
	 * Untracked files are not changes. Read only where a line needs it.
	 */
	clean: boolean;
	operation: GitOperation | null;
	traits: CheckoutTraits;
}

/** `check --format json`'s `checkout` block. */
export interface CheckoutJson {
	class: CheckoutClass;
	remote?: string;
	branch?: string | null;
	head?: string | null;
	clean?: boolean;
	operation?: GitOperation | null;
	/**
	 * Whether the published commit is in HEAD's history: `null` when git
	 * could not say (normally, it has not been fetched yet). Absent when
	 * there was no repository-built, current snapshot to look for.
	 */
	contains?: boolean | null;
	traits: Array<keyof CheckoutTraits>;
	/** The line printed for this checkout, or `null` when it is current. */
	line: string | null;
	/** A direct-repository project's verdict on this checkout, as a word. */
	verdict?: string;
}

export interface CheckoutReport {
	classification: CheckoutClassification;
	/** Only in the matching class. */
	state: CheckoutState | null;
	contains: boolean | null | undefined;
	line: string | null;
	/** Only in the matching class: what `line` is about. */
	reportKind?: MatchingReport["kind"];
	json: CheckoutJson;
}

/** The providers whose remotes `repository-identity.ts` knows how to compare. */
const SUPPORTED_PROVIDERS: ReadonlySet<string> = new Set([
	"GITHUB",
	"GITLAB",
	"AZURE_DEVOPS",
]);

/** Display bounds for every interpolated identifier. */
const MAX = { host: 253, path: 300, ref: 200, remote: 100, reason: 200 };

/**
 * Classes in which the upload behaviour (download and lock) still applies:
 * a directory that is not a git checkout at all, and — only when a person
 * runs `sync` by hand, deliberately — a checkout of some OTHER repository.
 * Everything else fails closed in every mode: a checkout of the repository
 * itself (git keeps it current), and every case where this cannot tell
 * whether it is one (unknown, unknown repository, unsupported provider,
 * ambiguous, unmapped).
 */
export function downloadsIn(
	classification: CheckoutClassification,
	manual: boolean,
): boolean {
	if (classification.class === "not-git") {
		return true;
	}
	return manual && classification.class === "foreign";
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function isSafeRootPath(rootPath: string): boolean {
	if (
		path.posix.isAbsolute(rootPath) ||
		path.win32.isAbsolute(rootPath) ||
		rootPath.startsWith("~")
	) {
		return false;
	}
	return !rootPath.split(/[\\/]/).some((segment) => segment === "..");
}

export async function sameDirectory(a: string, b: string): Promise<boolean> {
	const [left, right] = await Promise.all([
		realpath(a).catch(() => null),
		realpath(b).catch(() => null),
	]);
	return left !== null && left === right;
}

/**
 * Which of the eight cases `destination` is, for this project's CURRENT
 * repository configuration. Never throws for anything git or the filesystem
 * can do; an unexpected failure is `unknown`.
 */
export async function classifyCheckout(input: {
	destination: string;
	repository: PublishedInstructionRepository | null | undefined;
	deadline: GitDeadline;
	/** Only this remote is looked at, for a checkout where two fetch from the repository. */
	remote?: string;
}): Promise<CheckoutClassification> {
	try {
		return await classify(input);
	} catch {
		return { class: "unknown", reason: "the checkout could not be read" };
	}
}

async function classify({
	destination,
	repository,
	deadline,
	remote,
}: {
	destination: string;
	repository: PublishedInstructionRepository | null | undefined;
	deadline: GitDeadline;
	remote?: string;
}): Promise<CheckoutClassification> {
	const tree = await git.findWorkTree(destination, deadline);
	if (tree.kind === "absent") {
		return { class: "not-git" };
	}
	if (tree.kind === "unavailable") {
		return { class: "unknown", reason: tree.reason };
	}
	if (!repository) {
		return { class: "unknown-identity" };
	}
	if (!SUPPORTED_PROVIDERS.has(repository.provider)) {
		return {
			class: "unsupported-provider",
			provider: String(repository.provider),
		};
	}
	if (!hasComparableIdentity(repository)) {
		return { class: "unknown-identity" };
	}
	const root = tree.value.toplevel;
	if (!isSafeRootPath(repository.rootPath)) {
		return {
			class: "unknown",
			reason: "the project's instruction folder is not a path inside the repository",
		};
	}
	const refOk = await git.checkRefFormat(root, repository.ref, deadline);
	if (refOk.kind !== "ok") {
		return {
			class: "unknown",
			reason:
				refOk.kind === "absent" ? "not a git checkout" : refOk.reason,
		};
	}
	if (!refOk.value) {
		return {
			class: "unknown",
			reason: "the project's branch name is not one this hook will use",
		};
	}

	const names = await git.remotes(root, deadline);
	if (names.kind !== "ok") {
		return {
			class: "unknown",
			reason:
				names.kind === "absent" ? "not a git checkout" : names.reason,
		};
	}
	const matching: string[] = [];
	for (const name of remote === undefined
		? names.value
		: names.value.filter((candidate) => candidate === remote)) {
		const url = await git.effectiveFetchUrl(root, name, deadline);
		if (url.kind !== "ok") {
			return {
				class: "unknown",
				reason:
					url.kind === "absent" ? "not a git checkout" : url.reason,
			};
		}
		if (url.value === null) {
			continue;
		}
		const parsed = parseRemoteUrl(url.value);
		if (parsed && matches(parsed, repository) === "match") {
			matching.push(name);
		}
	}
	if (matching.length === 0) {
		return { class: "foreign" };
	}
	if (matching.length > 1) {
		return { class: "ambiguous", remotes: matching };
	}

	const mapped = path.join(root, repository.rootPath);
	if (!(await sameDirectory(destination, mapped))) {
		return {
			class: "unmapped",
			rootPath: repository.rootPath,
			toplevel: root,
		};
	}
	const traits = await git.checkoutTraits(root, deadline);
	if (traits.kind !== "ok") {
		return {
			class: "unknown",
			reason:
				traits.kind === "absent" ? "not a git checkout" : traits.reason,
		};
	}
	return {
		class: "matching",
		remote: matching[0] as string,
		toplevel: root,
		traits: traits.value,
	};
}

// ---------------------------------------------------------------------------
// The matching class: facts, then the line
// ---------------------------------------------------------------------------

/**
 * Read the checkout and decide the line. `snapshot` is the published one;
 * its `source` says which commit it was built from, when it was built from
 * the repository at all.
 */
async function inspectMatchingCheckout(input: {
	classification: Extract<CheckoutClassification, { class: "matching" }>;
	repository: PublishedInstructionRepository;
	snapshot: PublishedInstructionSnapshot | undefined;
	deadline: GitDeadline;
	contentChanges: ContentChanges;
}): Promise<CheckoutReport> {
	const { classification, repository, snapshot, deadline } = input;
	const root = classification.toplevel;
	const unknown = (reason: string): CheckoutReport =>
		reportFor(repository, { class: "unknown", reason });

	const [branch, head, operation, readClean] = await Promise.all([
		git.currentBranch(root, deadline),
		git.headSha(root, deadline),
		git.operationInProgress(root, deadline),
		input.contentChanges === "always"
			? git.hasNoTrackedContentChanges(root, deadline)
			: Promise.resolve(null),
	]);
	for (const answer of [branch, head, operation, readClean]) {
		if (answer === null) {
			continue;
		}
		if (answer.kind !== "ok") {
			return unknown(
				answer.kind === "absent" ? "not a git checkout" : answer.reason,
			);
		}
	}
	if (branch.kind !== "ok" || head.kind !== "ok" || operation.kind !== "ok") {
		return unknown("the checkout could not be read");
	}
	let state: CheckoutState = {
		branch: branch.value,
		head: head.value,
		clean:
			readClean === null
				? true
				: readClean.kind === "ok" && readClean.value,
		operation: operation.value,
		traits: classification.traits,
	};

	const source = snapshot?.source;
	let contains: boolean | null | undefined;
	if (
		snapshot &&
		source?.kind === "REPOSITORY" &&
		source.current &&
		git.isCommitSha(source.commitSha)
	) {
		if (state.head === null) {
			contains = null;
		} else {
			const answer = await git.isAncestor(
				root,
				source.commitSha,
				state.head,
				deadline,
			);
			contains = answer.kind === "ok" ? answer.value : null;
		}
	}

	const report = (): MatchingReport =>
		matchingReport({
			repository,
			remote: classification.remote,
			snapshot: snapshot
				? { version: snapshot.version, source: snapshot.source }
				: null,
			state,
			contains,
		});
	let { kind: reportKind, line } = report();
	if (readClean === null && reportKind === "behind") {
		// Compared only where a line is about to say `behind`: it is two
		// `git diff` runs over every tracked file, and the current checkout,
		// the common case, needs neither.
		const content = await git.hasNoTrackedContentChanges(root, deadline);
		if (content.kind === "ok") {
			state = { ...state, clean: content.value };
			({ kind: reportKind, line } = report());
		}
	}
	return {
		classification,
		state,
		contains,
		line,
		reportKind,
		json: {
			class: "matching",
			remote: classification.remote,
			branch: state.branch,
			head: state.head,
			clean: state.clean,
			operation: state.operation,
			...(contains !== undefined ? { contains } : {}),
			traits: traitNames(state.traits),
			line,
		},
	};
}

/** The report for a class that is not `matching`: its line, nothing read. */
export function reportFor(
	repository: PublishedInstructionRepository | null | undefined,
	classification: Exclude<CheckoutClassification, { class: "matching" }>,
): CheckoutReport {
	const line =
		classification.class === "not-git"
			? null
			: classLine(classification, repository ?? null);
	return {
		classification,
		state: null,
		contains: undefined,
		line,
		json: { class: classification.class, traits: [], line },
	};
}

function traitNames(traits: CheckoutTraits): Array<keyof CheckoutTraits> {
	return (["shallow", "sparse", "superproject"] as const).filter(
		(trait) => traits[trait],
	);
}

const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** POSIX single-quoting, the rule doctor's generated commands use. */
export function shellQuote(value: string): string {
	if (value.length > 0 && SHELL_SAFE.test(value)) {
		return value;
	}
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function show(value: string, max: number): string {
	return sanitizeDisplayText(value, max);
}

export function repositoryName(repository: {
	host: string;
	path: string;
}): string {
	return `${show(repository.host, MAX.host)}/${show(repository.path, MAX.path)}`;
}

/**
 * What the matching class says: `current` (nothing to say), `behind` (the
 * checkout lacks the published commit) or `other` (nothing published yet, or
 * published from another branch), and the one line for it. The decision table,
 * over plain data.
 */
export interface MatchingReport {
	kind: "current" | "behind" | "other";
	line: string | null;
}

export function matchingReport(input: {
	repository: Pick<PublishedInstructionRepository, "host" | "path" | "ref">;
	remote: string;
	snapshot: {
		version: number;
		source?: PublishedInstructionSnapshot["source"];
	} | null;
	state: CheckoutState;
	/** `undefined` when not evaluated; `null` when git could not say. */
	contains: boolean | null | undefined;
}): MatchingReport {
	const { repository, remote, snapshot, state, contains } = input;
	const name = repositoryName(repository);
	const ref = show(repository.ref, MAX.ref);
	const source = snapshot?.source;

	if (!snapshot || source?.kind !== "REPOSITORY") {
		return {
			kind: "other",
			line: outcomeLine("nothing-published", { repo: name }),
		};
	}
	const version = Number(snapshot.version);
	if (!source.current) {
		return {
			kind: "other",
			line: outcomeLine("earlier-source", {
				version,
				sourceRef: show(source.ref, MAX.ref),
				ref,
				repo: name,
			}),
		};
	}
	if (contains === true) {
		return { kind: "current", line: null };
	}

	return {
		kind: "behind",
		line: outcomeLine("behind", {
			version,
			sha7: show(source.commitSha.slice(0, 7), 7),
			ref,
			notFetched: contains !== false,
			traits: traitNames(state.traits),
			condition: behindCondition(state, repository.ref, remote),
		}),
	};
}

/**
 * Why a checkout that lacks the commit cannot simply pull, and the one thing
 * to do for the state it is in.
 */
function behindCondition(
	state: CheckoutState,
	branchRef: string,
	remote: string,
): BehindCondition {
	// An operation first: a rebase detaches HEAD, and "check out the branch"
	// is the wrong advice in the middle of one.
	if (state.operation !== null) {
		return { kind: "operation", operation: state.operation };
	}
	if (state.branch === null) {
		return { kind: "detached" };
	}
	if (state.branch !== branchRef) {
		return { kind: "other-branch", branch: show(state.branch, MAX.ref) };
	}
	if (!state.clean) {
		return { kind: "dirty" };
	}
	return {
		kind: "clean",
		pull: [
			"git",
			"pull",
			"--ff-only",
			shellQuote(show(remote, MAX.remote)),
			shellQuote(show(branchRef, MAX.ref)),
		].join(" "),
	};
}

/** The line for a checkout that lacks the commit a direct repository read named. */
export function directBehindLine(input: {
	repository: Pick<PublishedInstructionRepository, "host" | "path">;
	commitSha: string;
	ref: string;
	remote: string;
	state: CheckoutState;
}): string {
	return outcomeLine("behind-direct", {
		repo: repositoryName(input.repository),
		sha7: show(input.commitSha.slice(0, 7), 7),
		ref: show(input.ref, MAX.ref),
		traits: traitNames(input.state.traits),
		condition: behindCondition(input.state, input.ref, input.remote),
	});
}

/** The one line for the matching class, or `null` when the checkout already holds the published commit. */
export function matchingReportLine(
	input: Parameters<typeof matchingReport>[0],
): string | null {
	return matchingReport(input).line;
}

/** The one line for every class that is neither `matching` nor `not-git`. */
export function classLine(
	classification: Exclude<
		CheckoutClassification,
		{ class: "matching" } | { class: "not-git" }
	>,
	repository: Pick<PublishedInstructionRepository, "host" | "path"> | null,
): string {
	const name = repository ? repositoryName(repository) : "its repository";
	switch (classification.class) {
		case "foreign":
			return outcomeLine("class-foreign", { repo: name });
		case "ambiguous":
			return outcomeLine("class-ambiguous", {
				repo: name,
				remotes: classification.remotes.map((remote) =>
					show(remote, MAX.remote),
				),
			});
		case "unmapped":
			return outcomeLine("class-unmapped", {
				repo: name,
				where:
					classification.rootPath === ""
						? "the repository root"
						: show(classification.rootPath, MAX.path),
			});
		case "unknown":
			return outcomeLine("class-unknown", {
				reason: show(classification.reason, MAX.reason),
			});
		case "unknown-identity":
			return outcomeLine("class-unknown-identity", {});
		case "unsupported-provider":
			return outcomeLine("class-unsupported-provider", {
				provider: show(classification.provider, 32),
			});
		default:
			return classification satisfies never;
	}
}

/**
 * Classify, then — in the matching class — read the checkout. The one entry
 * point `check`, `sync` and doctor share, so all three say the same thing.
 */
export async function inspectCheckout(input: {
	destination: string;
	repository: PublishedInstructionRepository | null | undefined;
	snapshot: PublishedInstructionSnapshot | undefined;
	deadline: GitDeadline;
	remote?: string;
	contentChanges?: ContentChanges;
}): Promise<CheckoutReport> {
	const classification = await classifyCheckout(input);
	return reportForClassification({
		contentChanges: "always",
		...input,
		classification,
	});
}

/** The report for a classification already made. */
export async function reportForClassification(input: {
	classification: CheckoutClassification;
	repository: PublishedInstructionRepository | null | undefined;
	snapshot: PublishedInstructionSnapshot | undefined;
	deadline: GitDeadline;
	contentChanges?: ContentChanges;
}): Promise<CheckoutReport> {
	const { classification, repository } = input;
	if (classification.class !== "matching") {
		return reportFor(repository, classification);
	}
	if (!repository) {
		return reportFor(repository, { class: "unknown-identity" });
	}
	try {
		return await inspectMatchingCheckout({
			...input,
			contentChanges: input.contentChanges ?? "always",
			classification,
			repository,
		});
	} catch {
		return reportFor(repository, {
			class: "unknown",
			reason: "the checkout could not be read",
		});
	}
}

/**
 * What a person running `sync` by hand reads when the matching checkout
 * already holds the published commit — the case the hook stays silent for.
 */
export function currentLine(
	repository: Pick<PublishedInstructionRepository, "host" | "path" | "ref">,
	snapshot: Pick<PublishedInstructionSnapshot, "version" | "source">,
): string {
	const source = snapshot.source;
	return outcomeLine("already-current", {
		version: Number(snapshot.version),
		sha7:
			source?.kind === "REPOSITORY"
				? show(source.commitSha.slice(0, 7), 7)
				: null,
		ref: show(repository.ref, MAX.ref),
		repo: repositoryName(repository),
	});
}

/** `init`'s note when nothing has been published from the repository yet. */
export function nothingPublishedLine(
	repository: Pick<PublishedInstructionRepository, "host" | "path">,
): string {
	return `Nothing has been published from ${repositoryName(repository)} yet; the hook reports once it is.`;
}
