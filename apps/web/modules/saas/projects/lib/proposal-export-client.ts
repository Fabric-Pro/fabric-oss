/**
 * The download menu's side of the server-side Proposal export (Fizzy #2946).
 *
 * A client-document Proposal is printed by the worker from the same theme
 * the page wears: the menu starts the export, polls its status until a
 * short-lived download link is ready, and hands the outcome back. Every
 * other document keeps the browser-side export it has always had.
 *
 * Plain async code rather than a query hook: the menu renders in places
 * without a query client, and an export is one action, not cached state.
 */

import {
	PROPOSAL_EXPORT_UNSUPPORTED_CODE,
	type ProposalExportFormat,
} from "@repo/temporal/proposal-export-types";
import { orpcClient } from "../../../shared/lib/orpc-client";
import { getOrpcCode } from "../components/field-mapping/orpc-error";

/** How the menu waits for an export. */
const PROPOSAL_EXPORT_POLLING = {
	firstDelayMs: 1_000,
	maxDelayMs: 3_000,
	/**
	 * Past this the menu stops waiting and offers a retry: just under the
	 * workflow's own ten minutes, so an export that needed its second
	 * attempt is still waited for.
	 */
	deadlineMs: 9 * 60_000,
	/** Status reads in a row that may fail before the wait is given up. */
	maxConsecutiveFailures: 3,
} as const;

/** Status refusals no further read can turn around. */
const FINAL_STATUS_ERRORS = new Set(["NOT_FOUND", "FORBIDDEN", "UNAUTHORIZED"]);

export interface ProposalExportWarning {
	code: string;
	count: number;
}

export type ProposalExportOutcome =
	| {
			kind: "ready";
			url: string;
			fileName: string;
			warnings: ProposalExportWarning[];
	  }
	/** Not a client-document Proposal on the server: export in the browser. */
	| { kind: "unsupported" }
	| { kind: "failed"; code: string }
	/** Still running when the menu stopped waiting. */
	| { kind: "deadline" }
	| { kind: "rate-limited"; retryAfterSeconds: number | null };

/**
 * Whether the menu exports this document on the server: a Proposal while
 * the Proposal artifact gate is on for the route's organization. The server
 * decides again, and answers a code the menu falls back on.
 */
export function exportsOnServer(
	documentType: string,
	proposalArtifactEnabled: boolean,
): boolean {
	return proposalArtifactEnabled && documentType === "PROPOSAL";
}

function retryAfterOf(error: unknown): number | null {
	const value = (error as { data?: { retryAfter?: unknown } } | null)?.data
		?.retryAfter;
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isUnsupported(error: unknown): boolean {
	return (
		getOrpcCode(error) === "BAD_REQUEST" &&
		(error as { data?: { code?: unknown } } | null)?.data?.code ===
			PROPOSAL_EXPORT_UNSUPPORTED_CODE
	);
}

const realSleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Start a server-side export and wait for it. Errors other than the ones the
 * outcome names (a refusal, a network failure) are thrown to the caller.
 */
export async function runProposalExport(args: {
	projectId: string;
	documentId: string;
	format: ProposalExportFormat;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
}): Promise<ProposalExportOutcome> {
	const sleep = args.sleep ?? realSleep;
	const now = args.now ?? Date.now;

	let exportId: string;
	try {
		({ exportId } = await orpcClient.projects.proposalArtifact.export({
			projectId: args.projectId,
			documentId: args.documentId,
			format: args.format,
		}));
	} catch (error) {
		if (isUnsupported(error)) {
			return { kind: "unsupported" };
		}
		if (getOrpcCode(error) === "TOO_MANY_REQUESTS") {
			return {
				kind: "rate-limited",
				retryAfterSeconds: retryAfterOf(error),
			};
		}
		throw error;
	}

	const deadline = now() + PROPOSAL_EXPORT_POLLING.deadlineMs;
	let delay: number = PROPOSAL_EXPORT_POLLING.firstDelayMs;
	let failures = 0;
	while (now() < deadline) {
		await sleep(delay);
		delay = Math.min(delay * 1.5, PROPOSAL_EXPORT_POLLING.maxDelayMs);
		let status: Awaited<
			ReturnType<typeof orpcClient.projects.proposalArtifact.exportStatus>
		>;
		try {
			status = await orpcClient.projects.proposalArtifact.exportStatus({
				projectId: args.projectId,
				exportId,
			});
			failures = 0;
		} catch (error) {
			// A dropped connection or a slow read must not lose an export that
			// is still running; a refusal ends the wait at once.
			failures++;
			const code = getOrpcCode(error);
			if (
				(code !== undefined && FINAL_STATUS_ERRORS.has(code)) ||
				failures >= PROPOSAL_EXPORT_POLLING.maxConsecutiveFailures
			) {
				throw error;
			}
			continue;
		}
		if (status.status === "READY") {
			return {
				kind: "ready",
				url: status.url,
				fileName: status.fileName,
				warnings: status.warnings,
			};
		}
		if (status.status === "FAILED") {
			return { kind: "failed", code: status.code };
		}
	}
	return { kind: "deadline" };
}
