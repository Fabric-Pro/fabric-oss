/**
 * `fabric instructions push` following a repository proposal's pull request
 * (Fizzy #2563 spec §12).
 *
 * For a project whose coding instructions come from its repository, a
 * suggestion becomes a pull request there, opened by Fabric's workflow after
 * the files pass their checks. The push waits a bounded while to report where
 * that pull request stands: every 2 s, to an ABSOLUTE 60 s deadline. The
 * deadline is the wait's, not a request's: a status request still in flight
 * when it passes is cancelled, whether it is in the fetch, the body read or
 * the SDK's retry backoff, and no request or sleep starts after it.
 *
 * Expiry is classified by the deadline signal's own `aborted` state, never by
 * an error's name: the SDK rejects a cancelled request with the signal's
 * reason, and any other failure is the caller's to report.
 */
import type { FabricClient, ProposalPullRequestStatus } from "@fabricorg/sdk";

export const PULL_REQUEST_POLL_MS = 2_000;
export const PULL_REQUEST_WAIT_MS = 60_000;

/**
 * States the wait stops at. `OPEN` has its URL; `BLOCKED` needs a person;
 * `MERGED`, `CLOSED` and `CANCELED` are final; `CLOSE_REQUESTED` is an earlier
 * attempt's withdrawal, which no amount of waiting turns into an open pull
 * request.
 */
const SETTLED_STATES = new Set([
	"OPEN",
	"BLOCKED",
	"MERGED",
	"CLOSED",
	"CANCELED",
	"CLOSE_REQUESTED",
]);

export type PullRequestWait =
	| { kind: "settled"; pullRequest: ProposalPullRequestStatus }
	/** The deadline passed; `pullRequest` is the last state seen, if any. */
	| { kind: "timed_out"; pullRequest: ProposalPullRequestStatus | null }
	/** The proposal has no pull request: Fabric reviews it itself. */
	| { kind: "none" };

class PullRequestWaitDeadline extends Error {
	constructor() {
		super("the wait for the pull request reached its deadline");
		this.name = "PullRequestWaitDeadline";
	}
}

/** A signal that aborts after `ms`, and the way to stop its timer early. */
function deadlineSignal(ms: number): { signal: AbortSignal; clear(): void } {
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(new PullRequestWaitDeadline()),
		ms,
	);
	return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForPullRequest(
	client: FabricClient,
	projectId: string,
	snapshotId: string,
	options: { org?: string } = {},
): Promise<PullRequestWait> {
	const deadline = Date.now() + PULL_REQUEST_WAIT_MS;
	let last: ProposalPullRequestStatus | null = null;
	for (;;) {
		// Checked before every request.
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			return { kind: "timed_out", pullRequest: last };
		}
		const expiry = deadlineSignal(remaining);
		let pullRequest: ProposalPullRequestStatus | null;
		try {
			pullRequest = await client.instructions.getProposalPullRequest(
				projectId,
				snapshotId,
				{ org: options.org, signal: expiry.signal },
			);
		} catch (error) {
			if (expiry.signal.aborted) {
				return { kind: "timed_out", pullRequest: last };
			}
			throw error;
		} finally {
			expiry.clear();
		}
		if (pullRequest === null) {
			return { kind: "none" };
		}
		if (SETTLED_STATES.has(pullRequest.state)) {
			return { kind: "settled", pullRequest };
		}
		last = pullRequest;
		// Checked before every sleep: a sleep that would end at or past the
		// deadline leaves no time for the request after it.
		if (deadline - Date.now() <= PULL_REQUEST_POLL_MS) {
			return { kind: "timed_out", pullRequest: last };
		}
		await delay(PULL_REQUEST_POLL_MS);
	}
}

/**
 * `--message`: the first line is the title and the rest the body, with CRLF
 * and a lone CR read as LF (Review Focus 5). Blank lines between the title
 * and the body are dropped; a message with nothing after its first line is a
 * title alone. Length and credential rules are the server's.
 */
export function splitMessage(message: string): {
	title: string;
	body?: string;
} {
	const [title = "", ...rest] = message.replace(/\r\n?/g, "\n").split("\n");
	const body = rest.join("\n").replace(/^\n+/, "");
	return body === "" ? { title } : { title, body };
}
