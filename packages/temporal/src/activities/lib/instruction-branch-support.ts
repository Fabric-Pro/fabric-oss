/**
 * What the member proposal branch activities share (Fizzy #2738 spec §6.3,
 * §6.4, §6.5, §6.7, §6.8): the creation checks against the branch's frozen
 * destination, the branch workspace and its object helpers, the
 * provenance primitives read together, the per-path entry comparison, one
 * lookup by the branch's ref, and the pull request's fixed presentation.
 *
 * Not re-exported from the activities barrel: every export of a module the
 * barrel re-exports becomes a schedulable Temporal activity.
 */
import {
	type BranchOperationRow,
	type BranchPullRequestObservation,
	type BranchRow,
	canCreateProjectInstructions,
	canReadProjectInstructions,
	getInstructionRepositorySyncForProposal,
	getProjectInstructionSettings,
	type PullRequestPhase,
} from "@repo/database";
import {
	type BranchDestination,
	type BranchPresentation,
	escapeMarkdown,
	FALLBACK_PROJECT_NAME,
	FALLBACK_PROPOSER_NAME,
	normaliseName,
	type PullRequestContextV2,
	pullRequestContextSchemaV2,
	scanTextForSecrets,
	type TreeEntry,
	unsafeName,
} from "@repo/instructions";
import {
	InstructionPullRequestError,
	type PullRequestObservation,
	repositoryIdentity,
	sameRepository,
} from "@repo/integrations/instruction-pull-requests";
import type { BranchCredential } from "./instruction-branch-credential";
import { isAncestor, revListOutside } from "./instruction-branch-git";
import { ProposalStepFailure } from "./instruction-proposal-boundary";
import { providerCall } from "./instruction-proposal-operation";
import {
	assertObjectId,
	type GitCallBase,
	MAX_CLONE_BYTES,
	runGit,
} from "./instruction-sync-git";

// ---------------------------------------------------------------------------
// The proposal's frozen context
// ---------------------------------------------------------------------------

/** The v2 context (spec §4.2), or a non-retryable refusal when the stored value is not one. */
export function contextOf(
	value: unknown,
	phase: PullRequestPhase,
): PullRequestContextV2 {
	const parsed = pullRequestContextSchemaV2.safeParse(value);
	if (!parsed.success) {
		throw new ProposalStepFailure({
			code: "CONFIGURATION_CHANGED",
			phase,
			retryable: false,
		});
	}
	return parsed.data;
}

// ---------------------------------------------------------------------------
// Creation checks (spec §6.3, Decision 18)
// ---------------------------------------------------------------------------

function unhandledIntegrationStatus(status: never): never {
	throw new Error(
		`Unhandled repository integration status: ${String(status)}`,
	);
}

/**
 * Spec §6.3 "Creation checks": #2563 §6.1 step 4 against the branch's frozen
 * destination (never the generation, Decision 15) and the live repository
 * identity, plus the member's live permission. Re-read on every call:
 * before an append's build, immediately before its record, and before a
 * create's marker. Throws the refusal; a changed repository identity is
 * REPOSITORY_CHANGED (Decision 19).
 */
export async function assertBranchCreationAllowed(i: {
	branch: Pick<BranchRow, "projectId" | "organizationId" | "userId">;
	destination: BranchDestination;
	phase: PullRequestPhase;
}): Promise<void> {
	const { branch, destination, phase } = i;
	const refuse = (
		code:
			| "CONFIGURATION_CHANGED"
			| "REPOSITORY_CHANGED"
			| "AUTHENTICATION_FAILED"
			| "PERMISSION_REVOKED",
	) =>
		new ProposalStepFailure({
			code,
			phase,
			retryable: code === "AUTHENTICATION_FAILED",
		});
	const [sync, settings] = await Promise.all([
		getInstructionRepositorySyncForProposal(
			branch.projectId,
			branch.organizationId,
		),
		getProjectInstructionSettings(branch.projectId, branch.organizationId),
	]);
	if (
		!sync ||
		settings.sourceOfTruth !== "REPOSITORY" ||
		sync.id !== destination.syncId ||
		sync.repositoryIntegrationId !== destination.integrationId ||
		sync.ref !== destination.targetRef ||
		sync.rootPath !== destination.rootPath ||
		sync.repositoryIntegration.projectId !== branch.projectId
	) {
		throw refuse("CONFIGURATION_CHANGED");
	}
	const live = repositoryIdentity(
		sync.repositoryIntegration.provider,
		sync.repositoryIntegration.repositoryUrl,
	);
	if (live === null || !sameRepository(live, destination.repository)) {
		throw refuse("REPOSITORY_CHANGED");
	}
	const status = sync.repositoryIntegration.status;
	switch (status) {
		case "ACTIVE":
			break;
		case "TOKEN_EXPIRED":
			throw refuse("AUTHENTICATION_FAILED");
		case "REPO_UNAVAILABLE":
		case "ERROR":
		case "DISCONNECTED":
			throw refuse("CONFIGURATION_CHANGED");
		default:
			return unhandledIntegrationStatus(status);
	}
	const allowed =
		(await canCreateProjectInstructions(branch.projectId, branch.userId)) ||
		(sync.allowReaderProposals &&
			(await canReadProjectInstructions(
				branch.projectId,
				branch.userId,
			)));
	if (!allowed) {
		throw refuse("PERMISSION_REVOKED");
	}
}

// ---------------------------------------------------------------------------
// Workspace objects
// ---------------------------------------------------------------------------

const watched = (dir: string) => ({
	watchDir: dir,
	maxDirBytes: MAX_CLONE_BYTES,
});

/**
 * Makes `sha` present in the branch workspace, which `initBranchWorkspace`
 * cloned at the target ref: normally the proposal's base commit is already
 * in that history. Otherwise it is fetched by id, complete and blobless,
 * never shallow. Availability only: never evidence of ancestry (spec §7).
 */
export async function ensureCommit(
	input: GitCallBase & { dir: string; sha: string },
): Promise<void> {
	assertObjectId(input.sha, "cat-file");
	try {
		await runGit({
			cwd: input.dir,
			args: ["cat-file", "-e", `${input.sha}^{commit}`],
			env: input.env,
			signal: input.signal,
			label: "cat-file",
			maxStdoutBytes: 256,
		});
		return;
	} catch {
		// Not local: fetched below.
	}
	await runGit({
		cwd: input.dir,
		args: [
			"fetch",
			"--quiet",
			"--no-tags",
			"--filter=blob:none",
			"origin",
			input.sha,
		],
		env: input.env,
		signal: input.signal,
		label: "fetch",
		...watched(input.dir),
	});
}

/** A blob from storage bytes into the workspace (`hash-object -w`, no filters): its object id. */
export async function hashBlob(
	input: GitCallBase & { dir: string; bytes: Buffer },
): Promise<string> {
	const { stdout } = await runGit({
		cwd: input.dir,
		args: ["hash-object", "-w", "--no-filters", "--stdin"],
		env: input.env,
		signal: input.signal,
		stdin: input.bytes,
		label: "hash-object",
		maxStdoutBytes: 256,
		...watched(input.dir),
	});
	const oid = stdout.toString("utf8").trim();
	assertObjectId(oid, "hash-object");
	return oid;
}

/** Entry equality (spec Decision 6 (d)): type, mode and object id, or both absent. */
export function sameEntry(
	a: TreeEntry | null | undefined,
	b: TreeEntry | null | undefined,
): boolean {
	if (!a || !b) {
		return !a && !b;
	}
	return a.type === b.type && a.mode === b.mode && a.oid === b.oid;
}

// ---------------------------------------------------------------------------
// Journal and provenance
// ---------------------------------------------------------------------------

const established = (op: Pick<BranchOperationRow, "outcome">) =>
	op.outcome === "acked" || op.outcome === "observed";

/** `known` of spec §6.4 step 4: the established journal's commits. */
export function establishedShas(
	ops: readonly BranchOperationRow[],
): Set<string> {
	return new Set(ops.filter(established).map((op) => op.sha));
}

export type Provenance = {
	ancestry: "true" | "false" | "error";
	/** Commits outside the established journal since `from`, or `error`. */
	outside: { kind: "ok"; outside: string[] } | { kind: "error" };
	/** A failed ancestry or any outside commit: `foreignTipAt` (Decision 7). */
	foreign: boolean;
};

/**
 * Spec §6.4 step 4 / §6.7 step 0: `isAncestor(from, tip)` and
 * `revListOutside(from..tip, known)` read together. `error` from either is
 * never "clean".
 */
export async function provenanceOf(
	input: GitCallBase & {
		dir: string;
		from: string;
		tip: string;
		known: ReadonlySet<string>;
	},
): Promise<Provenance> {
	const ancestry = await isAncestor({
		dir: input.dir,
		ancestor: input.from,
		descendant: input.tip,
		env: input.env,
		signal: input.signal,
	});
	const outside = await revListOutside({
		dir: input.dir,
		from: input.from,
		to: input.tip,
		known: input.known,
		env: input.env,
		signal: input.signal,
	});
	return {
		ancestry,
		outside,
		foreign:
			ancestry !== "true" ||
			outside.kind === "error" ||
			outside.outside.length > 0,
	};
}

/**
 * Per-path history (spec Decision 6 (w), §6.8 step 2): `from` is an ancestor
 * of the tip and no commit outside the established journal since `from`
 * touched `rawPath`. History-based, never content-based.
 */
export async function pathUntouchedSince(
	input: GitCallBase & {
		dir: string;
		from: string;
		tip: string;
		known: ReadonlySet<string>;
		rawPath: string;
		ancestry: "true" | "false" | "error";
	},
): Promise<boolean> {
	if (input.ancestry !== "true") {
		return false;
	}
	const outside = await revListOutside({
		dir: input.dir,
		from: input.from,
		to: input.tip,
		known: input.known,
		rawPath: input.rawPath,
		env: input.env,
		signal: input.signal,
	});
	return outside.kind === "ok" && outside.outside.length === 0;
}

/** `{paths, count}` for a failure naming files (spec §6.4 step 5): the first 20. */
export function pathParams(paths: readonly string[]): {
	paths: string;
	count: number;
} {
	return { paths: paths.slice(0, 20).join(", "), count: paths.length };
}

/** The first line of a commit message, the revert subject's title (spec §6.8 step 3). */
export function firstLine(message: string): string {
	const line = message.split("\n", 1)[0] ?? "";
	return line.trim();
}

/** ISO 8601 UTC, whole seconds: a commit date. */
export function commitDate(at: Date): string {
	return `${at.toISOString().slice(0, 19)}Z`;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export type BranchRefLookup =
	| { kind: "found"; observation: PullRequestObservation }
	| { kind: "absent" }
	| { kind: "inconclusive"; failure: ProposalStepFailure };

/** `findOperation` on the branch's one ref (spec §6.5), as #2563's `lookupRef`. */
export async function lookupBranchRef(
	credential: BranchCredential,
	ref: string,
	phase: PullRequestPhase,
): Promise<BranchRefLookup> {
	const found = await providerCall(phase, credential, () =>
		credential.adapter.findOperation({
			...credential.target,
			sourceRef: ref,
		}),
	);
	if (found.kind === "FOUND") {
		return { kind: "found", observation: found.value };
	}
	if (found.kind === "ABSENT") {
		return { kind: "absent" };
	}
	if (found.cause === "auth") {
		throw new InstructionPullRequestError({
			code: "AUTHENTICATION_FAILED",
			retryable: true,
			cause: "auth",
		});
	}
	if (found.cause === "rate_limit") {
		return {
			kind: "inconclusive",
			failure: new ProposalStepFailure({
				code: "PROVIDER_RATE_LIMITED",
				phase,
				retryable: true,
				retryAfterSeconds: found.retryAfterSeconds,
			}),
		};
	}
	return {
		kind: "inconclusive",
		failure: new ProposalStepFailure({
			code:
				found.cause === "permission" || found.cause === "not_found"
					? "REPOSITORY_UNAVAILABLE"
					: "LOOKUP_INCONCLUSIVE",
			phase,
			retryable: true,
		}),
	};
}

/** What the branch records of a provider observation. */
export function observationOf(
	o: PullRequestObservation,
): BranchPullRequestObservation {
	return {
		externalId: o.externalId,
		url: o.url,
		state: o.state,
		targetRef: o.targetRef,
		headSha: o.headSha,
		...(o.mergedAt !== undefined ? { mergedAt: o.mergedAt } : {}),
		...(o.closedAt !== undefined ? { closedAt: o.closedAt } : {}),
		...(o.mergeCommitSha !== undefined
			? { mergeCommitSha: o.mergeCommitSha }
			: {}),
	};
}

// ---------------------------------------------------------------------------
// Presentation (spec Decision 13, §6.1)
// ---------------------------------------------------------------------------

/** The fixed paragraph above the #2563 footer (spec Decision 13). */
export const BRANCH_PULL_REQUEST_PARAGRAPH =
	"This pull request collects the coding instruction changes one member proposed in Fabric, one commit each. Review, merge or close it here.";

/**
 * The branch pull request's title and description (Decision 13), rendered
 * at the branch's first claim in #2563's order (spec §5.2): names
 * normalised and replaced by a fixed fallback when unsafe, the composed text
 * scanned before any Markdown escaping, then escaped. A hit that survives
 * the fallback refuses attribution (`ATTRIBUTION_REJECTED`, §6.1).
 */
export function renderBranchPresentation(i: {
	memberName: string | null;
	projectName: string | null;
}): { ok: true; presentation: BranchPresentation } | { ok: false } {
	const member = normaliseName(i.memberName ?? "");
	const project = normaliseName(i.projectName ?? "");
	const memberName = unsafeName(member) ? FALLBACK_PROPOSER_NAME : member;
	const projectName = unsafeName(project) ? FALLBACK_PROJECT_NAME : project;
	const title = `Coding instruction changes from ${memberName}`;
	const footer = `Opened from Fabric project ${projectName} by ${memberName}`;
	const body = [BRANCH_PULL_REQUEST_PARAGRAPH, "---", footer].join("\n\n");
	if (
		scanTextForSecrets(title).length > 0 ||
		scanTextForSecrets(body).length > 0
	) {
		return { ok: false };
	}
	return {
		ok: true,
		presentation: {
			title: escapeMarkdown(title),
			body: escapeMarkdown(body),
		},
	};
}
