/**
 * The member proposal branch's pull request: create, lookup of an
 * outstanding create, Retry opening and the release of a branch a human
 * refusal stranded (Fizzy #2738 spec §6.5, §4.4, Decision 17; #2563 §6.1
 * steps 3, 4, 7, 8 and `releaseAbandonedPush` on the branch).
 *
 * One ref, at most one create issuance per marker: the marker is written
 * before `open`, conditional on the attempt, and stands whatever `open`
 * answers. Only reconciliation (lookup) or a member's Retry opening after a
 * definitive `PR_CREATION_REFUSED` follows; CREATE_OUTCOME_UNKNOWN never
 * re-issues on the same ref.
 *
 * Not re-exported from the activities barrel: every export of a module the
 * barrel re-exports becomes a schedulable Temporal activity.
 */
import {
	type BranchOperationRow,
	type BranchWithClock,
	getBranchPresentationInputs,
	getProposalBranch,
	isReleasableBranch,
	isTerminalBranchState,
	listBranchOperations,
	nextRetryDelayMs,
	type PullRequestPhase,
	recordBranchReceipt,
	releaseBlockedBranch,
	transitionBranch,
} from "@repo/database";
import {
	type BranchDestination,
	type BranchPresentation,
	branchPresentationSchema,
} from "@repo/instructions";
import {
	InstructionPullRequestError,
	type PullRequestObservation,
} from "@repo/integrations/instruction-pull-requests";
import { safeHeartbeat } from "./activity-liveness";
import {
	type BranchCredential,
	destinationOf,
	withBranchRepoCredential,
} from "./instruction-branch-credential";
import {
	assertMemberBranch,
	fetchBranchHead,
	initBranchWorkspace,
} from "./instruction-branch-git";
import {
	assertBranchCreationAllowed,
	establishedShas,
	lookupBranchRef,
	observationOf,
	provenanceOf,
	renderBranchPresentation,
} from "./instruction-branch-support";
import type {
	CreateBranchPullRequestResult,
	LookupBranchPullRequestResult,
	ReleaseBranchResult,
	RetryBranchOpeningResult,
} from "./instruction-branch-types";
import {
	asJson,
	assertMayContinue,
	failureJson,
	nextAttemptAt,
	ProposalStepFailure,
} from "./instruction-proposal-boundary";
import { gitCall } from "./instruction-proposal-operation";
import { deleteBranch } from "./instruction-sync-git";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

type BranchFailure = {
	code: string | null;
	retryable: boolean | null;
	phase: string | null;
	recoveries: number | null;
};

function failureOf(value: unknown): BranchFailure {
	if (value === null || typeof value !== "object") {
		return { code: null, retryable: null, phase: null, recoveries: null };
	}
	const f = value as {
		code?: unknown;
		retryable?: unknown;
		phase?: unknown;
		params?: { recoveries?: unknown };
	};
	return {
		code: typeof f.code === "string" ? f.code : null,
		retryable: typeof f.retryable === "boolean" ? f.retryable : null,
		phase: typeof f.phase === "string" ? f.phase : null,
		recoveries:
			typeof f.params?.recoveries === "number"
				? f.params.recoveries
				: null,
	};
}

/** The branch's pull-request text, or ATTRIBUTION_REJECTED when none can be rendered safely. */
async function presentationOf(
	branch: BranchWithClock,
	phase: PullRequestPhase,
): Promise<BranchPresentation> {
	const stored = branchPresentationSchema.safeParse(branch.presentation);
	if (stored.success) {
		return stored.data;
	}
	const inputs = await getBranchPresentationInputs({
		branchId: branch.id,
		organizationId: branch.organizationId,
	});
	const rendered = renderBranchPresentation(
		inputs ?? { memberName: null, projectName: null },
	);
	if (!rendered.ok) {
		throw new ProposalStepFailure({
			code: "ATTRIBUTION_REJECTED",
			phase,
			retryable: false,
		});
	}
	return rendered.presentation;
}

// ---------------------------------------------------------------------------
// Recording a create-side failure on the branch (spec §4.4 "Create failure")
// ---------------------------------------------------------------------------

/**
 * A create-side failure on the branch: OPENING becomes BLOCKED, BLOCKED
 * keeps its state (failure-only), at the attempt the caller holds, with the
 * next automatic attempt on the database clock. The marker, when written,
 * stands. False when the branch moved first.
 */
export async function recordBranchCreateFailure(
	i: { branchId: string; organizationId: string; attempt: number },
	failure: ProposalStepFailure,
): Promise<boolean> {
	const branch = await getProposalBranch({
		branchId: i.branchId,
		organizationId: i.organizationId,
	});
	if (
		!branch ||
		branch.attempt !== i.attempt ||
		(branch.state !== "OPENING" && branch.state !== "BLOCKED")
	) {
		return false;
	}
	const moved = await transitionBranch({
		branchId: branch.id,
		organizationId: i.organizationId,
		from: [branch.state],
		expectedAttempt: i.attempt,
		to: branch.state === "OPENING" ? "BLOCKED" : "unchanged",
		bumpAttempt: false,
		data: {
			failure: asJson(failureJson(failure)),
			nextAttemptAt: nextAttemptAt(branch, failure),
		},
	});
	return moved.ok;
}

// ---------------------------------------------------------------------------
// open and its receipt (spec §6.5, #2563 §6.1 steps 7-8)
// ---------------------------------------------------------------------------

/**
 * One `open` after the marker, then the receipt: a duplicate refusal is
 * looked up and adopted; any other refusal is the create failure, the marker
 * standing; a found-nothing duplicate is CREATE_OUTCOME_UNKNOWN.
 */
async function openAndRecord(
	credential: BranchCredential,
	i: {
		branch: BranchWithClock;
		destination: BranchDestination;
		presentation: BranchPresentation;
		markerAttempt: number;
	},
): Promise<"opened" | "adopted" | "stopped"> {
	const { branch } = i;
	let observation: PullRequestObservation;
	let adopted = false;
	try {
		assertMayContinue(credential.signal);
		observation = await credential.adapter.open({
			...credential.target,
			sourceRef: branch.ref,
			targetRef: i.destination.targetRef,
			title: i.presentation.title,
			body: i.presentation.body,
		});
	} catch (error) {
		if (credential.signal.aborted) {
			throw error; // the marker stands; lookup reconciles
		}
		if (!(error instanceof InstructionPullRequestError)) {
			throw error;
		}
		if (!error.duplicate) {
			throw new ProposalStepFailure({
				code: error.code,
				phase: "create",
				retryable: error.retryable,
				retryAfterSeconds: error.retryAfterSeconds,
			});
		}
		const found = await lookupBranchRef(credential, branch.ref, "create");
		if (found.kind !== "found") {
			throw new ProposalStepFailure({
				code: "CREATE_OUTCOME_UNKNOWN",
				phase: "create",
				retryable: true,
				recoveries: 0,
				params: { recoveries: 0 },
			});
		}
		observation = found.observation;
		adopted = true;
	}
	const recorded = await recordBranchReceipt({
		branchId: branch.id,
		organizationId: branch.organizationId,
		expectedAttempt: i.markerAttempt,
		from: ["OPENING"],
		observation: observationOf(observation),
		adopted,
	});
	if (recorded.kind === "stale") {
		return "stopped";
	}
	return adopted ? "adopted" : "opened";
}

/** The attempt a create-side activity holds, updated when its marker bumps it. */
type Held = { attempt: number };

function outcomeOfFailure(failure: ProposalStepFailure): "blocked" | "unknown" {
	return failure.code === "CREATE_OUTCOME_UNKNOWN" ? "unknown" : "blocked";
}

// ---------------------------------------------------------------------------
// createBranchPullRequest (spec §6.5)
// ---------------------------------------------------------------------------

/**
 * Loop item `create`: an established head, no receipt and no marker, on an
 * OPENING branch or a due retryable create-phase BLOCKED one. Recovery by
 * `findOperation` first, the creation checks (the member's live
 * permission), the marker, one `open` with the stored presentation, and the
 * receipt (`pull_request_opened`).
 */
export async function runCreate(i: {
	branchId: string;
	organizationId: string;
	branchAttempt: number;
	signal: AbortSignal;
}): Promise<CreateBranchPullRequestResult["outcome"]> {
	const branch = await getProposalBranch(i);
	if (!branch || branch.untracked || branch.attempt !== i.branchAttempt) {
		return "stopped";
	}
	const f = failureOf(branch.failure);
	const creatable =
		branch.headSha !== null &&
		branch.pullRequestExternalId === null &&
		branch.createIssuedAt === null &&
		(branch.state === "OPENING" ||
			(branch.state === "BLOCKED" &&
				f.retryable === true &&
				f.phase === "create"));
	if (!creatable) {
		return "stopped";
	}
	const held: Held = { attempt: branch.attempt };
	try {
		const destination = destinationOf(branch, "create");
		const presentation = await presentationOf(branch, "create");
		await assertBranchCreationAllowed({
			branch,
			destination,
			phase: "create",
		});
		return await withBranchRepoCredential(
			{ branch, phase: "create", signal: i.signal },
			async (credential) => {
				const found = await lookupBranchRef(
					credential,
					branch.ref,
					"create",
				);
				if (found.kind === "found") {
					const r = await recordBranchReceipt({
						branchId: branch.id,
						organizationId: i.organizationId,
						expectedAttempt: held.attempt,
						from: [branch.state],
						observation: observationOf(found.observation),
						adopted: true,
					});
					return r.kind === "stale" ? "stopped" : "adopted";
				}
				if (found.kind === "inconclusive") {
					throw found.failure;
				}
				// The creation checks once more, then the marker commits to
				// exactly one `open`.
				await assertBranchCreationAllowed({
					branch,
					destination,
					phase: "create",
				});
				assertMayContinue(credential.signal);
				const marked = await transitionBranch({
					branchId: branch.id,
					organizationId: i.organizationId,
					from: [branch.state],
					expectedAttempt: held.attempt,
					to: branch.state === "BLOCKED" ? "OPENING" : "unchanged",
					bumpAttempt: true,
					data: {
						createIssuedAt: branch.databaseNow,
						failure: null,
						nextAttemptAt: null,
					},
				});
				if (!marked.ok) {
					return "stopped";
				}
				held.attempt = marked.attempt;
				return openAndRecord(credential, {
					branch,
					destination,
					presentation,
					markerAttempt: marked.attempt,
				});
			},
		);
	} catch (error) {
		if (!(error instanceof ProposalStepFailure)) {
			throw error;
		}
		await recordBranchCreateFailure({ ...i, attempt: held.attempt }, error);
		return outcomeOfFailure(error);
	}
}

// ---------------------------------------------------------------------------
// lookupBranchPullRequest (spec §6 loop item 9)
// ---------------------------------------------------------------------------

/**
 * CREATE_OUTCOME_UNKNOWN with #2563's clock (spec §6.5 "the 24 h rule and
 * backoff are #2563's"): retryable until the marker is a day old, then
 * non-retryable and looked at hourly.
 */
function createOutcomeUnknown(
	branch: BranchWithClock,
	createIssuedAt: Date,
): ProposalStepFailure {
	const markerAgeMs = Math.max(
		0,
		branch.databaseNow.getTime() - createIssuedAt.getTime(),
	);
	const f = failureOf(branch.failure);
	const previous =
		f.code === "CREATE_OUTCOME_UNKNOWN" && f.recoveries !== null
			? f.recoveries
			: 0;
	const expired = markerAgeMs >= DAY_MS;
	return new ProposalStepFailure({
		code: "CREATE_OUTCOME_UNKNOWN",
		phase: "recover",
		retryable: !expired,
		markerAgeMs,
		recoveries: previous,
		params: { recoveries: previous + 1 },
		...(expired ? { nextAttemptDelayMs: HOUR_MS } : {}),
	});
}

/** Failure-only on the branch: its failure kept, only the next look moved. */
export async function deferLookup(
	branch: BranchWithClock,
	delayMs: number,
): Promise<void> {
	await transitionBranch({
		branchId: branch.id,
		organizationId: branch.organizationId,
		from: [branch.state],
		expectedAttempt: branch.attempt,
		to: "unchanged",
		bumpAttempt: false,
		data: {
			nextAttemptAt: new Date(branch.databaseNow.getTime() + delayMs),
		},
	});
}

/**
 * Loop item `lookup`: a create marker without a receipt, due by its
 * backoff. A pull request found on the ref is adopted. None found keeps a
 * definitive PR_CREATION_REFUSED as it is (only Retry opening re-issues;
 * the next look is an hour out), and a START_OVER_REFUSED likewise (spec
 * §6.7: the refused restart's card stays until the member acts); otherwise
 * it is CREATE_OUTCOME_UNKNOWN on #2563's clock. Recorded authority: no permission check (Decision 18).
 */
export async function runLookup(i: {
	branchId: string;
	organizationId: string;
	signal: AbortSignal;
}): Promise<LookupBranchPullRequestResult["outcome"]> {
	const branch = await getProposalBranch(i);
	if (
		!branch ||
		branch.untracked ||
		isTerminalBranchState(branch.state) ||
		branch.createIssuedAt === null ||
		branch.pullRequestExternalId !== null ||
		branch.settledAt !== null
	) {
		return "absent";
	}
	const createIssuedAt = branch.createIssuedAt;
	return withBranchRepoCredential(
		{ branch, phase: "recover", signal: i.signal },
		async (credential) => {
			const found = await lookupBranchRef(
				credential,
				branch.ref,
				"recover",
			);
			if (found.kind === "found") {
				const r = await recordBranchReceipt({
					branchId: branch.id,
					organizationId: i.organizationId,
					expectedAttempt: branch.attempt,
					from: [branch.state],
					observation: observationOf(found.observation),
					adopted: true,
				});
				return r.kind === "stale" ? "inconclusive" : "adopted";
			}
			const f = failureOf(branch.failure);
			if (found.kind === "inconclusive") {
				if (
					f.code === "CREATE_OUTCOME_UNKNOWN" ||
					f.code === "PR_CREATION_REFUSED" ||
					f.code === "START_OVER_REFUSED"
				) {
					await deferLookup(
						branch,
						nextRetryDelayMs(found.failure.code, {
							retryAfterSeconds: found.failure.retryAfterSeconds,
						}) ?? 15 * 60 * 1000,
					);
				} else {
					await recordBranchCreateFailure(
						{ ...i, attempt: branch.attempt },
						found.failure,
					);
				}
				return "inconclusive";
			}
			if (
				f.code === "PR_CREATION_REFUSED" ||
				f.code === "START_OVER_REFUSED"
			) {
				// A human answers these (Retry opening; the refused Start
				// over's card): kept, looked at again in an hour.
				await deferLookup(branch, HOUR_MS);
				return "absent";
			}
			await recordBranchCreateFailure(
				{ ...i, attempt: branch.attempt },
				createOutcomeUnknown(branch, createIssuedAt),
			);
			return "absent";
		},
	);
}

// ---------------------------------------------------------------------------
// retryBranchOpening (Decision 17)
// ---------------------------------------------------------------------------

/**
 * Loop item `retry`: a member's persisted Retry opening, only on a BLOCKED
 * PR_CREATION_REFUSED branch. The lookup runs first and adopts what it
 * finds; with nothing found, `open` is re-issued on the same ref with a
 * fresh marker, `retryRequestedAt` cleared by the same write. A lookup that
 * cannot answer clears the request and keeps the refusal, so the member
 * may ask again.
 */
export async function runRetry(i: {
	branchId: string;
	organizationId: string;
	branchAttempt: number;
	signal: AbortSignal;
}): Promise<RetryBranchOpeningResult["outcome"]> {
	const branch = await getProposalBranch(i);
	if (!branch || branch.untracked) {
		return "blocked";
	}
	const f = failureOf(branch.failure);
	const clearRequest = () =>
		transitionBranch({
			branchId: branch.id,
			organizationId: i.organizationId,
			from: [branch.state],
			expectedAttempt: branch.attempt,
			to: "unchanged",
			bumpAttempt: false,
			data: { retryRequestedAt: null },
		});
	if (
		branch.state !== "BLOCKED" ||
		f.code !== "PR_CREATION_REFUSED" ||
		branch.retryRequestedAt === null ||
		branch.attempt !== i.branchAttempt ||
		branch.headSha === null ||
		branch.pullRequestExternalId !== null
	) {
		if (
			branch.retryRequestedAt !== null &&
			!isTerminalBranchState(branch.state)
		) {
			await clearRequest();
		}
		return "blocked";
	}
	const held: Held = { attempt: branch.attempt };
	try {
		const destination = destinationOf(branch, "create");
		const presentation = await presentationOf(branch, "create");
		await assertBranchCreationAllowed({
			branch,
			destination,
			phase: "create",
		});
		return await withBranchRepoCredential(
			{ branch, phase: "create", signal: i.signal },
			async (credential) => {
				const found = await lookupBranchRef(
					credential,
					branch.ref,
					"create",
				);
				if (found.kind === "found") {
					const r = await recordBranchReceipt({
						branchId: branch.id,
						organizationId: i.organizationId,
						expectedAttempt: held.attempt,
						from: ["BLOCKED"],
						observation: observationOf(found.observation),
						adopted: true,
					});
					return r.kind === "stale" ? "blocked" : "adopted";
				}
				if (found.kind === "inconclusive") {
					await clearRequest();
					return "blocked";
				}
				assertMayContinue(credential.signal);
				const marked = await transitionBranch({
					branchId: branch.id,
					organizationId: i.organizationId,
					from: ["BLOCKED"],
					expectedAttempt: held.attempt,
					to: "OPENING",
					bumpAttempt: true,
					data: {
						createIssuedAt: branch.databaseNow,
						failure: null,
						nextAttemptAt: null,
						retryRequestedAt: null,
					},
				});
				if (!marked.ok) {
					return "blocked";
				}
				held.attempt = marked.attempt;
				const opened = await openAndRecord(credential, {
					branch,
					destination,
					presentation,
					markerAttempt: marked.attempt,
				});
				return opened === "stopped" ? "blocked" : opened;
			},
		);
	} catch (error) {
		if (!(error instanceof ProposalStepFailure)) {
			throw error;
		}
		const recorded = await recordBranchCreateFailure(
			{ ...i, attempt: held.attempt },
			error,
		);
		if (!recorded || held.attempt === branch.attempt) {
			// Refused before any re-issue: the request is answered.
			await clearRequest();
		}
		return "blocked";
	}
}

// ---------------------------------------------------------------------------
// releaseBranch (spec §4.4 "Release", §6.5, §6.7 step 2)
// ---------------------------------------------------------------------------

/**
 * Spec §6.7 step 2: the ref is deleted only when it is a member branch ref
 * equal to the row's, every pushed operation has deletion authority
 * (`acked`, never `observed`, `unknown` or issued), `foreignTipAt` is null,
 * a fresh fetch shows the tip at `headSha`, the start commit is an
 * ancestor of it and nothing outside the journal is in between. The delete
 * is leased at that tip. `refused` is the provider's own refusal (an active
 * pull request, most often), answered by the next lookup.
 */
export async function deleteIfFabricOwned(
	credential: BranchCredential,
	branch: BranchWithClock,
	ops: readonly BranchOperationRow[],
): Promise<"deleted" | "kept" | "refused"> {
	try {
		assertMemberBranch(branch.ref);
	} catch {
		return "kept";
	}
	const pushed = ops.filter((op) => op.outcome !== "not_pushed");
	if (
		branch.headSha === null ||
		branch.startSha === null ||
		branch.foreignTipAt !== null ||
		pushed.some((op) => op.outcome !== "acked")
	) {
		return "kept";
	}
	const { env, signal } = credential;
	const dir = credential.workDir;
	const headSha = branch.headSha;
	const startSha = branch.startSha;
	const fetched = await gitCall("close", credential, async () => {
		await initBranchWorkspace({
			url: credential.url,
			targetRef: credential.destination.targetRef,
			dir,
			env,
			signal,
		});
		safeHeartbeat();
		return fetchBranchHead({ dir, branch: branch.ref, env, signal });
	});
	if (fetched.kind !== "present" || fetched.sha !== headSha) {
		return "kept";
	}
	const provenance = await gitCall("close", credential, () =>
		provenanceOf({
			dir,
			env,
			signal,
			from: startSha,
			tip: fetched.sha,
			known: establishedShas(ops),
		}),
	);
	if (provenance.foreign) {
		return "kept";
	}
	assertMayContinue(signal);
	const deleted = await gitCall("close", credential, () =>
		deleteBranch({
			cwd: credential.runDir,
			url: credential.url,
			branch: branch.ref,
			sha: fetched.sha,
			env,
			signal,
		}),
	);
	if (deleted.kind === "deleted") {
		return "deleted";
	}
	return deleted.kind === "refused" ? "refused" : "kept";
}

/**
 * Loop item `release`: a BLOCKED branch whose non-retryable pre-create
 * refusal (PERMISSION_REVOKED, CONFIGURATION_CHANGED) stranded an
 * established head with no pull request and no marker. A pull request that
 * appeared is adopted; otherwise the ref is deleted under §6.7's rule (or
 * kept, and the card says why) and the branch and its proposals become
 * CANCELED in one transaction. Recorded authority (Decision 18).
 */
export async function runRelease(i: {
	branchId: string;
	organizationId: string;
	branchAttempt: number;
	signal: AbortSignal;
}): Promise<ReleaseBranchResult["outcome"]> {
	const branch = await getProposalBranch(i);
	if (
		!branch ||
		branch.untracked ||
		branch.attempt !== i.branchAttempt ||
		!isReleasableBranch(branch)
	) {
		return "kept";
	}
	const ops = await listBranchOperations(i);
	return withBranchRepoCredential(
		{ branch, phase: "close", signal: i.signal },
		async (credential) => {
			const found = await lookupBranchRef(
				credential,
				branch.ref,
				"close",
			);
			if (found.kind === "found") {
				const r = await recordBranchReceipt({
					branchId: branch.id,
					organizationId: i.organizationId,
					expectedAttempt: branch.attempt,
					from: ["BLOCKED"],
					observation: observationOf(found.observation),
					adopted: true,
				});
				return r.kind === "stale" ? "kept" : "adopted";
			}
			if (found.kind === "inconclusive") {
				return "kept";
			}
			const deleted = await deleteIfFabricOwned(credential, branch, ops);
			if (deleted === "refused") {
				return "kept";
			}
			const released = await releaseBlockedBranch({
				branchId: branch.id,
				organizationId: i.organizationId,
				expectedAttempt: branch.attempt,
				refDeleted: deleted === "deleted",
			});
			return released.ok ? "released" : "kept";
		},
	);
}
