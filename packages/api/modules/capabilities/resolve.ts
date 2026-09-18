/**
 * Turning rule verdicts into the gate a surface renders (Fizzy #1930).
 *
 * Three things happen here and nowhere else: composite prerequisites collapse
 * to the strictest state, a job that has stopped reporting progress stops being
 * "Processing", and a suppressed warning is hidden. The order matters — see
 * `applySuppression`.
 */

import { STALL_MINUTES_BY_SOURCE, type StallSource } from "./thresholds";
import {
	type CapabilityEvidence,
	type CapabilityGate,
	type CapabilityRule,
	type CapabilityState,
	type JobSnapshot,
	type RetryAffordance,
	type RuleVerdict,
	STATE_SEVERITY,
} from "./types";

const NO_RETRY: RetryAffordance = {
	supported: false,
	permitted: false,
	available: false,
};

/**
 * Has this job stopped reporting progress for longer than its source allows?
 *
 * Only ever true for a job that is actually running: a finished job is not
 * stalled, it is finished. A job whose clock cannot be read is never stalled
 * either — an unknown age is not evidence of death, and declaring a live run
 * dead is the worse of the two errors available here.
 */
export function isStalled(
	job: JobSnapshot,
	source: StallSource,
	now: Date,
): boolean {
	if (!job.running) {
		return false;
	}
	if (job.lastProgressAt === null) {
		return false;
	}
	const windowMs = STALL_MINUTES_BY_SOURCE[source] * 60 * 1000;
	return now.getTime() - job.lastProgressAt.getTime() > windowMs;
}

/**
 * Collapse several prerequisites to the one the user must act on.
 *
 * The strictest state wins, and — this is the part the requirements are
 * explicit about — the *cause* that wins with it is the cause belonging to that
 * state, not a summary. Telling somebody an action "is not ready" without
 * naming which of its three prerequisites is missing leaves them exactly where
 * they started.
 *
 * `HIDDEN` short-circuits: an action with nothing to act on should not be on
 * the page, and there is no sense in which that competes with a block.
 */
export function strictest(verdicts: readonly RuleVerdict[]): RuleVerdict {
	if (verdicts.length === 0) {
		return {
			state: "AVAILABLE",
			reasonKey: null,
			blockingDependency: null,
			remedy: null,
		};
	}
	const hidden = verdicts.find((v) => v.state === "HIDDEN");
	if (hidden) {
		return hidden;
	}
	return verdicts.reduce((worst, candidate) => {
		const a =
			STATE_SEVERITY[worst.state as Exclude<CapabilityState, "HIDDEN">];
		const b =
			STATE_SEVERITY[
				candidate.state as Exclude<CapabilityState, "HIDDEN">
			];
		return b < a ? candidate : worst;
	});
}

/**
 * A suppression the viewer has stored for one warning on one project.
 *
 * `fingerprint` is what makes "reappears when the dependency materially
 * changes" enforceable rather than aspirational. It is taken over the durable
 * facts behind the warning, so a routine re-render or a transient status flip
 * leaves it matching, while a genuine change — the reason moves, the missing
 * dependency changes, the source is reconnected — does not.
 */
export interface StoredSuppression {
	/** `<capabilityKey>:<reasonKey>` */
	key: string;
	fingerprint: string;
	/** ISO timestamp, or absent for "do not show again for this project". */
	expiresAt?: string;
}

/**
 * Hide a warning the viewer chose to silence — and nothing else.
 *
 * Applied strictly after resolution, and only ever to `WARNING`. Every other
 * state is a statement about whether the capability can run, which is not a
 * viewer's to overrule: suppression never satisfies a dependency, never changes
 * readiness, and never makes a blocked action available. The write procedure
 * refuses a non-warning state as well, so this is defended twice — once where
 * it is stored and once where it is read.
 *
 * An expired or non-matching suppression is simply ignored; it is not an error,
 * and it is not cleaned up here. A read path that deletes rows is a read path
 * that surprises somebody.
 */
export function applySuppression(
	gate: CapabilityGate,
	suppressions: readonly StoredSuppression[],
	fingerprint: string,
	now: Date,
): CapabilityGate {
	if (gate.state !== "WARNING" || gate.reasonKey === null) {
		return gate;
	}
	const key = `${gate.capabilityKey}:${gate.reasonKey}`;
	const match = suppressions.find(
		(s) => s.key === key && s.fingerprint === fingerprint,
	);
	if (!match) {
		return gate;
	}
	if (match.expiresAt !== undefined && new Date(match.expiresAt) <= now) {
		return gate;
	}
	return { ...gate, suppressed: true };
}

/**
 * The fingerprint a suppression is matched against.
 *
 * Durable facts only. Deliberately NOT the gate's state or the current run's
 * status: those flip on every re-index and every retry, and a fingerprint that
 * tracked them would resurrect a warning the viewer silenced thirty seconds
 * ago — which reads as the dismissal being broken.
 */
export function dependencyFingerprint(evidence: CapabilityEvidence): string {
	return [
		evidence.codebase.connected ? "repo" : "no-repo",
		evidence.codebase.usable ? "indexed" : "not-indexed",
		evidence.codebase.integrationStatus ?? "no-integration",
		`ctx:${evidence.context.total}`,
		`tech:${evidence.context.technical}`,
		`prod:${evidence.context.product}`,
		`docs:${[...evidence.documents.usableTypes].sort().join("+") || "none"}`,
		`desc:${evidence.descriptionLength > 0 ? "set" : "empty"}`,
	].join("|");
}

/** Resolve one rule to the gate a surface renders. */
export function resolveGate(
	rule: CapabilityRule,
	evidence: CapabilityEvidence,
	now: Date,
	suppressions: readonly StoredSuppression[] = [],
): CapabilityGate {
	const verdict = rule.evaluate(evidence, now);
	const retry: RetryAffordance = { ...NO_RETRY, ...verdict.retry };
	// A rule knows whether a retry exists and whether one is already in flight.
	// It does not know who is looking, and it must not: re-running an index
	// needs a higher permission than viewing the gate does, so an ordinary
	// member routinely meets a block they cannot clear themselves. Resolving it
	// centrally keeps every rule from having to remember the distinction — and
	// keeps the answer consistent when a capability is reached through a tool
	// or the API rather than the page.
	retry.permitted = retry.supported && evidence.viewer.canEditProjectSettings;
	const gate: CapabilityGate = {
		capabilityKey: rule.key,
		state: verdict.state,
		reasonKey: verdict.reasonKey,
		blockingDependency: verdict.blockingDependency,
		remedy: verdict.remedy,
		retry,
		suppressed: false,
	};
	return applySuppression(
		gate,
		suppressions,
		dependencyFingerprint(evidence),
		now,
	);
}
