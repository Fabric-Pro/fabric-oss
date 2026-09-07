import { ORPCError } from "@orpc/server";
import { logger } from "@repo/logs";
import type { getTemporalClient } from "@repo/temporal";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";

/**
 * Shared half of "reconnect this monitor to me" (Fizzy #2355).
 *
 * Every channel/chat monitor runs as ONE project-level Temporal workflow
 * carrying one user's id, frozen into the workflow's arguments at enable-time.
 * When that person's delegated token stops working the fetch returns an empty
 * list rather than an error, so nothing increments, no banner appears, and the
 * panel keeps reporting a healthy monitor while it collects nothing. Rebinding
 * the workflow to the calling user is the only repair, and — since there is no
 * per-conversation owner — it is necessarily monitor-wide.
 *
 * Only the terminate/restart half lives here. The reachability probe stays with
 * each provider deliberately: the three responses have different shapes and
 * different error conventions, and a single generic probe signature is exactly
 * where the next "asked a different question than the scan asks" bug gets born.
 */

/**
 * Three outcomes, never two.
 *
 * "We could not check" is not "you can see nothing" — they lead to opposite
 * recommendations, and collapsing them is what made the meeting preflight advise
 * against a repair that would have worked. A rate limit or a 5xx is
 * `indeterminate`; only a definite negative from the provider is `unreachable`.
 */
export type ProbeOutcome = "reachable" | "unreachable" | "indeterminate";

/**
 * Which side of the three-way outcome a provider's error message falls on.
 *
 * The providers report a dead connection two ways — a throw, or a 200 carrying
 * an `error` field — and the second kind mixes two very different meanings: "you
 * are not allowed to see this" and "we are busy, ask again". Only the first is a
 * verdict about the calling account. Treating a rate limit as "you cannot see
 * this channel" would tell someone their reconnect will strand conversations
 * that are in fact perfectly reachable.
 *
 * Substring matching against a provider string is a blunt instrument, so it is
 * deliberately biased: anything not recognised as transient is reported as
 * `unreachable`, which the caller surfaces as "you cannot see this" — visible
 * and checkable — rather than silently swallowed.
 */
export function classifyProviderError(message: string): ProbeOutcome {
	const text = message.toLowerCase();
	const transient = [
		"rate limit",
		"ratelimited",
		"too many requests",
		"429",
		"500",
		"502",
		"503",
		"504",
		"timeout",
		"timed out",
		"econnreset",
		"etimedout",
		"service unavailable",
		"internal server error",
	];
	return transient.some((needle) => text.includes(needle))
		? "indeterminate"
		: "unreachable";
}

/** One linked conversation, reduced to what the preflight report needs. */
export type MonitorConversation = {
	id: string;
	/** What the confirmation names — a channel or chat title, never an id. */
	label: string;
};

export type MonitorPreflightReport = {
	total: number;
	reachableCount: number;
	/** Labels the calling account definitely cannot see. */
	unreachableLabels: string[];
	/** Labels we could not check — a retry, not a verdict. */
	indeterminateLabels: string[];
};

/**
 * Probing is bounded because it costs one provider call per conversation, and
 * Slack's `conversations.history` is a tier-3 method the backfill activity
 * already has to rate-limit. Beyond this many linked conversations the report
 * covers a sample; the rebind is not blocked by what it could not reach.
 */
const MAX_PROBES = 25;

/**
 * Ask, for each actively scanned conversation, the same question the scan asks.
 *
 * Probes run in sequence rather than in parallel: the point of the cap is to
 * stay under the provider's rate limit, and firing 25 concurrent calls would
 * defeat it.
 */
export async function runMonitorPreflight(params: {
	conversations: MonitorConversation[];
	probe: (conversation: MonitorConversation) => Promise<ProbeOutcome>;
}): Promise<MonitorPreflightReport> {
	const probed = params.conversations.slice(0, MAX_PROBES);
	const unreachableLabels: string[] = [];
	const indeterminateLabels: string[] = [];
	let reachableCount = 0;

	for (const conversation of probed) {
		let outcome: ProbeOutcome;
		try {
			outcome = await params.probe(conversation);
		} catch {
			// A throw tells us the call failed, not that the account is blind.
			outcome = "indeterminate";
		}

		if (outcome === "reachable") {
			reachableCount++;
		} else if (outcome === "unreachable") {
			unreachableLabels.push(conversation.label);
		} else {
			indeterminateLabels.push(conversation.label);
		}
	}

	return {
		total: probed.length,
		reachableCount,
		unreachableLabels,
		indeterminateLabels,
	};
}

/**
 * Turn a preflight into a decision, or throw the reason it cannot be one.
 *
 * Called only on the commit path — a preflight-only request reports and stops,
 * because the whole point of the preflight is to let someone see the cost before
 * paying it.
 */
export function assertPreflightAllowsRebind(
	report: MonitorPreflightReport,
	noun: string,
): void {
	if (report.reachableCount > 0) {
		return;
	}

	// Nothing reachable AND nothing checked is a failed check, not a verdict.
	if (report.indeterminateLabels.length > 0) {
		throw new ORPCError("SERVICE_UNAVAILABLE", {
			message: `We could not check which ${noun}s your account can see, so we cannot tell whether reconnecting would keep them syncing. Try again.`,
		});
	}

	throw new ORPCError("BAD_REQUEST", {
		message: `None of this project's ${noun}s are visible to your account, so reconnecting would stop the monitor collecting anything.`,
	});
}

/**
 * Cancel the workflow bound to the old account and start one bound to the new.
 *
 * The cancel is best-effort: the old run may already be gone, and a failed
 * cancel is survivable because ingestion is deduplicated at the seen-message
 * table, so two runs racing costs provider calls rather than duplicated data.
 */
export async function rebindMonitorWorkflow(params: {
	projectId: string;
	/** The run currently bound to the old account, if one was recorded. */
	previousWorkflowId: string | null;
	/** Signal name as `defineSignal` registered it — a wrong one fails silently. */
	cancelSignal: string;
	workflowType: string;
	taskQueue: string;
	workflowId: string;
	args: unknown[];
	/** Prefix for this monitor's log lines, e.g. `teamsChat`. */
	logKey: string;
}): Promise<{ workflowId: string; status: string }> {
	const temporal = await import("@repo/temporal");
	let client: Awaited<ReturnType<typeof getTemporalClient>>;
	try {
		client = await temporal.getTemporalClient();
	} catch (error) {
		logger.error(`${params.logKey}.reconnect.temporal_unavailable`, {
			projectId: params.projectId,
			error,
		});
		throw new ORPCError("SERVICE_UNAVAILABLE", {
			message: "Could not reach the workflow service. Try again.",
		});
	}

	if (params.previousWorkflowId) {
		try {
			const handle = client.workflow.getHandle(params.previousWorkflowId);
			await handle.signal(params.cancelSignal);
			await handle.cancel();
		} catch (error) {
			logger.warn(
				`${params.logKey}.reconnect.old_workflow_cancel_failed`,
				{
					projectId: params.projectId,
					workflowId: params.previousWorkflowId,
					error,
				},
			);
		}
	}

	const handle = await client.workflow.start(
		params.workflowType,
		withCorrelationMemo({
			taskQueue: params.taskQueue,
			workflowId: params.workflowId,
			args: params.args,
		}),
	);

	// Confirm it is actually running before reporting success — otherwise a
	// reconnect can report a rebind that never happened, which is the same class
	// of silent lie the feature exists to remove.
	const description = await client.workflow
		.getHandle(handle.workflowId)
		.describe();

	return {
		workflowId: handle.workflowId,
		status: description.status.name,
	};
}
