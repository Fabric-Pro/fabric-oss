/**
 * The duplicate verifier's confirmation of a manually entered work item's
 * Proposal Inbox candidates (manual create, `stories.checkDuplicate`). As on
 * the roadmap, a candidate is listed only once the roadmap scan's verifier
 * has confirmed it, read as the scan reads a pair.
 *
 * The entry is not saved, so its verdicts are kept in Upstash (the client
 * the item vector cache uses) for a day, keyed by the verifier's contract
 * (`VERIFIER_VERSION`) and resolved model, both texts' verdict hashes and how
 * the pair was scored: a repeated check of the same text, or the final check
 * after a typing prefetch, bills nothing again, and a new prompt or model
 * decides afresh. A check that does not verify (a typing prefetch) lists
 * only the candidates a kept verdict confirmed, and counts the rest.
 *
 * Every cache read and write degrades to a miss; a failed verification is
 * no match and is not kept.
 */

import { getAIModelWithMetadata } from "@repo/ai";
import {
	buildVerifierPrompt,
	detectionVerdictHash,
	type FocusTexts,
	inboxItemSubject,
	type PendingProposalMatchItem,
	VERIFIER_VERSION,
} from "@repo/database";
import { logger } from "@repo/logs";
import {
	type DuplicateVerifier,
	verifyDuplicatePair,
} from "@repo/temporal/duplicate-scan-core";
import { z } from "zod";
import { getRedisClient } from "../../../lib/redis-client";
import type { PairCandidate } from "./proposal-duplicate-scoring";

const LOG_PREFIX = "[Duplicate Check]";

/** Long enough to cover a dialog session and its retries; a key is never
 * stale, since both texts are part of it. */
const VERDICT_TTL_SECONDS = 24 * 60 * 60;

/** Shown to the verifier in place of a ticket identifier. */
const MANUAL_ENTRY_IDENTIFIER = "New work item";

interface VerificationScope {
	projectId: string;
	userId: string;
	organizationId?: string;
	abortSignal?: AbortSignal;
}

/** The entry as the candidate rule read it. */
interface ManualEntrySubject {
	text: string;
	focusTexts: FocusTexts | null;
}

/** An inbox item the candidate rule selected against the entry. */
interface ManualEntryCandidate {
	item: PendingProposalMatchItem;
	found: PairCandidate;
}

interface ManualEntryConfirmation {
	/** Per candidate, in order: whether the verifier confirmed it. */
	confirmed: boolean[];
	/** Candidates with no kept verdict that this check did not verify. */
	unverified: number;
}

const keptVerdictSchema = z.object({ confirmed: z.boolean() });

/** Who decides: the verifier's contract and the model it resolved to. */
function verifierIdentity(metadata: {
	provider: string;
	modelString: string;
}): string {
	return `v${VERIFIER_VERSION}:${metadata.provider}:${metadata.modelString}`;
}

function verdictKey(
	scope: VerificationScope,
	verifier: string,
	entryHash: string,
	candidate: ManualEntryCandidate,
): string {
	const itemHash = detectionVerdictHash(inboxItemSubject(candidate.item));
	const scored = `${candidate.found.focusKind ?? "text"}:${candidate.found.proximate ? "near" : "far"}`;
	return `proposal-dup:manual-verdict:${scope.organizationId ?? "_"}:${scope.projectId}:${verifier}:${entryHash}:${itemHash}:${scored}`;
}

/** The kept verdicts of `keys`; a key not in the map was not found. */
async function readKeptVerdicts(
	scope: VerificationScope,
	keys: string[],
): Promise<Map<string, boolean>> {
	const found = new Map<string, boolean>();
	const redis = getRedisClient();
	if (!redis || keys.length === 0) {
		return found;
	}
	try {
		const values = await redis.mget<unknown[]>(keys);
		keys.forEach((key, index) => {
			const parsed = keptVerdictSchema.safeParse(values[index]);
			if (parsed.success) {
				found.set(key, parsed.data.confirmed);
			}
		});
	} catch (error) {
		logger.warn(`${LOG_PREFIX} could not read kept inbox verdicts`, {
			projectId: scope.projectId,
			error: error instanceof Error ? error.message : String(error),
		});
	}
	return found;
}

async function keepVerdicts(
	scope: VerificationScope,
	verdicts: ReadonlyMap<string, boolean>,
): Promise<void> {
	const redis = getRedisClient();
	if (!redis || verdicts.size === 0) {
		return;
	}
	try {
		const pipeline = redis.pipeline();
		for (const [key, confirmed] of verdicts) {
			pipeline.set(key, { confirmed }, { ex: VERDICT_TTL_SECONDS });
		}
		await pipeline.exec();
	} catch (error) {
		logger.warn(`${LOG_PREFIX} could not keep inbox verdicts`, {
			projectId: scope.projectId,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/**
 * Whether the verifier flags the entry and one inbox candidate, read as the
 * scan reads a pair: on the section it was scored on, as two features when
 * the item is one (the entry is read as a feature). Null when the call
 * failed or was abandoned.
 */
async function verifyCandidate(
	scope: VerificationScope,
	verifier: DuplicateVerifier,
	entry: ManualEntrySubject,
	candidate: ManualEntryCandidate,
): Promise<boolean | null> {
	const subject = inboxItemSubject(candidate.item);
	const kind = candidate.found.focusKind;
	const textA = kind ? entry.focusTexts?.[kind] : undefined;
	const textB = kind ? subject.focusTexts?.[kind] : undefined;
	const bothFeatures = subject.kind === "FEATURE";
	const prompt = buildVerifierPrompt(
		{ identifier: MANUAL_ENTRY_IDENTIFIER, text: entry.text },
		subject,
		{
			proximate: candidate.found.proximate,
			focus: kind && textA && textB ? { kind, textA, textB } : undefined,
			bothFeatures,
		},
	);
	try {
		const { effect } = await verifyDuplicatePair({
			verifier,
			prompt,
			bothFeatures,
			abortSignal: scope.abortSignal,
		});
		return effect === "link:DUPLICATE" || effect === "link:OVERLAP";
	} catch (error) {
		logger.warn(`${LOG_PREFIX} could not verify an inbox match`, {
			projectId: scope.projectId,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

/**
 * Which of the entry's candidates the verifier confirms: by their kept
 * verdicts, and, when `verify` is set, by the verifier for the rest, whose
 * verdicts are then kept.
 */
export async function confirmManualEntryCandidates(params: {
	scope: VerificationScope;
	entry: ManualEntrySubject;
	candidates: readonly ManualEntryCandidate[];
	verify: boolean;
}): Promise<ManualEntryConfirmation> {
	const { scope, entry } = params;
	// Resolved first, even for a check that will not call it: the kept
	// verdicts are the resolved model's own.
	const verifier = await getAIModelWithMetadata(
		{ taskType: "SIMPLE" },
		{
			userId: scope.userId,
			organizationId: scope.organizationId,
			projectId: scope.projectId,
			featureKey: "duplicate-scan",
		},
	);
	const identity = verifierIdentity(verifier.metadata);
	const entryHash = detectionVerdictHash({ ...entry, kind: "FEATURE" });
	const keyed = params.candidates.map((candidate) => ({
		candidate,
		key: verdictKey(scope, identity, entryHash, candidate),
	}));
	const keys = keyed.map(({ key }) => key);
	const kept = await readKeptVerdicts(scope, keys);
	const missing = keyed.filter(({ key }) => !kept.has(key));
	if (!params.verify || missing.length === 0) {
		return {
			confirmed: keys.map((key) => kept.get(key) === true),
			unverified: missing.length,
		};
	}
	const verified = new Map<string, boolean>();
	await Promise.all(
		missing.map(async ({ candidate, key }) => {
			const confirmed = await verifyCandidate(
				scope,
				verifier,
				entry,
				candidate,
			);
			if (confirmed !== null) {
				verified.set(key, confirmed);
			}
		}),
	);
	await keepVerdicts(scope, verified);
	return {
		confirmed: keys.map(
			(key) => (kept.get(key) ?? verified.get(key)) === true,
		),
		unverified: 0,
	};
}
