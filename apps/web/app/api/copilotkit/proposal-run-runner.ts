/**
 * Keeps the route-owned Proposal `forwardedProps` on the server, and each
 * chat thread with the user who started it.
 *
 * The runtime's default `InMemoryAgentRunner` stamps the run input it was
 * handed onto the agent's `RUN_STARTED` event, `forwardedProps` included,
 * streams that event to the browser and keeps it for every later
 * `agent/connect` replay of the thread. The route writes the bound client
 * revision prompt, the settled-decisions block and the echo texts into
 * `forwardedProps`, so left alone a guest would receive the prompt and a
 * member the block.
 *
 * This runner hands the inner runner the input without those keys, so nothing
 * it emits or stores can carry them, and gives them back to the agent itself
 * when the agent sends its request.
 *
 * The in-memory store is shared by the whole process and replays any thread
 * by id, so the runner also binds a thread to the session user on its first
 * run (`./thread-owners`) and refuses another user's run, replay, stop or
 * running check on it. A running thread whose owner the registry's bound has
 * dropped is joined and stopped by nobody; its owner reloads.
 *
 * An assistant's thread id is its saved conversation's id
 * (`assistant-thread.tsx`), which the other members of a document can read
 * on a shared conversation. So before the registry, a thread that names a
 * conversation is served only to that conversation's owner, in its
 * organization (`threadAccess`, the route's `readThreadAccess`): nobody else
 * can bind it first and lock its owner out. A thread that names none yet (a
 * new conversation's minted id, or another chat's) is the registry's alone.
 *
 * A refused run or replay ends with one `RUN_ERROR` carrying
 * `THREAD_ACCESS_DENIED`: the runtime has already answered 200 by the time it
 * asks the runner, and a thrown error would reach the browser only as a
 * generic "Agent run failed". The route builds a runner per request, so the
 * user is the session's, never a value the browser sent.
 *
 * It sets no `ɵsupportsLocalThreadEndpoints`, which keeps the runtime's
 * thread list, events and clear endpoints off: they read the same store with
 * no owner check.
 */

import { EventType } from "@ag-ui/client";
import type {
	AgentRunner,
	AgentRunnerConnectRequest,
	AgentRunnerIsRunningRequest,
	AgentRunnerRunRequest,
	AgentRunnerStopRequest,
} from "@copilotkit/runtime/v2";
import { logger } from "@repo/logs";
import type { ThreadAccess } from "@saas/agents/runtime/thread";
import { finalize, from, mergeMap, of } from "rxjs";
import { PROPOSAL_FORWARDED_PROP_KEYS } from "./proposal-client-run";
import { type ThreadOwners, threadOwners } from "./thread-owners";

type RunAgent = AgentRunnerRunRequest["agent"]["runAgent"];
type RunnerEvents = ReturnType<AgentRunner["run"]>;

const THREAD_ACCESS_DENIED_CODE = "THREAD_ACCESS_DENIED";

/**
 * The session user's access to a thread by the conversation it names: the
 * route binds `readThreadAccess` to the session's user and organization.
 */
export type ThreadAccessCheck = (threadId: string) => Promise<ThreadAccess>;

export class ProposalPropsRedactingRunner implements AgentRunner {
	constructor(
		private readonly inner: AgentRunner,
		private readonly userId: string,
		private readonly threadAccess: ThreadAccessCheck,
		private readonly owners: ThreadOwners = threadOwners,
	) {}

	run(request: AgentRunnerRunRequest): RunnerEvents {
		const { threadId } = request;
		return from(this.isForeignConversation(threadId)).pipe(
			mergeMap((foreign) =>
				foreign
					? this.refuse(threadId, "run")
					: this.runForCaller(request),
			),
		);
	}

	connect(request: AgentRunnerConnectRequest): RunnerEvents {
		const { threadId } = request;
		return from(this.isForeignConversation(threadId)).pipe(
			mergeMap((foreign) =>
				foreign
					? this.refuse(threadId, "connect")
					: this.connectForCaller(request),
			),
		);
	}

	async isRunning(request: AgentRunnerIsRunningRequest): Promise<boolean> {
		if (
			(await this.isForeignConversation(request.threadId)) ||
			!this.owners.admits(request.threadId, this.userId)
		) {
			return false;
		}
		return this.inner.isRunning(request);
	}

	async stop(request: AgentRunnerStopRequest): Promise<boolean | undefined> {
		// Only the owner stops a run, and a refusal answers as "no active
		// run", so it reveals nothing either.
		if (
			(await this.isForeignConversation(request.threadId)) ||
			!this.owners.admits(request.threadId, this.userId)
		) {
			this.logRefusal(request.threadId, "stop");
			return false;
		}
		// A thread nobody owns is either idle, so there is nothing to stop,
		// or running with its owner dropped by the registry's bound.
		if (!this.owners.isOwned(request.threadId)) {
			return false;
		}
		return this.inner.stop(request);
	}

	/**
	 * True when the thread names a conversation that is not the session
	 * user's in this organization (or is no thread id at all).
	 */
	private async isForeignConversation(threadId: string): Promise<boolean> {
		return (await this.threadAccess(threadId)).kind === "forbidden";
	}

	private runForCaller(request: AgentRunnerRunRequest): RunnerEvents {
		const { threadId } = request;
		const firstClaim = !this.owners.isOwned(threadId);
		// Before anything reaches the store: a refused run must not join,
		// supersede or append to the owner's thread.
		if (!this.owners.claim(threadId, this.userId)) {
			return this.refuse(threadId, "run");
		}

		let events: RunnerEvents;
		try {
			events = this.runRedacted(request);
		} catch (error) {
			// The store refused the run, typically one already in flight on a
			// thread the registry had dropped: the thread is not this caller's.
			if (firstClaim) {
				this.owners.release(threadId, this.userId);
			}
			throw error;
		}
		// Refreshed again as the stream ends (the run finishes or fails, or the
		// browser leaves), so a long run is not the oldest entry right after.
		return events.pipe(
			finalize(() => this.owners.claim(threadId, this.userId)),
		);
	}

	private connectForCaller(request: AgentRunnerConnectRequest): RunnerEvents {
		const { threadId } = request;
		if (!this.owners.admits(threadId, this.userId)) {
			return this.refuse(threadId, "connect");
		}
		if (this.owners.isOwned(threadId)) {
			return this.inner.connect(request);
		}
		return from(this.isUnownedAndIdle(threadId)).pipe(
			mergeMap((idle) =>
				idle
					? this.inner.connect(request)
					: this.refuse(threadId, "connect"),
			),
		);
	}

	private runRedacted(request: AgentRunnerRunRequest): RunnerEvents {
		const forwardedProps = request.input.forwardedProps as unknown;
		if (
			!isRecord(forwardedProps) ||
			!PROPOSAL_FORWARDED_PROP_KEYS.some((key) => key in forwardedProps)
		) {
			return this.inner.run(request);
		}

		const redacted = { ...forwardedProps };
		for (const key of PROPOSAL_FORWARDED_PROP_KEYS) {
			delete redacted[key];
		}

		// The agent is cloned per request, so this override never reaches
		// another run.
		const { agent } = request;
		const runAgent: RunAgent = agent.runAgent.bind(agent);
		agent.runAgent = (parameters, subscriber) =>
			runAgent({ ...parameters, forwardedProps }, subscriber);

		return this.inner.run({
			...request,
			input: { ...request.input, forwardedProps: redacted },
		});
	}

	/**
	 * For a thread no user owns: true when no run is going on it and nobody
	 * claimed it meanwhile. A running one had its owner dropped by the
	 * registry's bound mid-run, so nobody may join it.
	 */
	private async isUnownedAndIdle(threadId: string): Promise<boolean> {
		const running = await this.inner.isRunning({ threadId });
		return !running && this.owners.admits(threadId, this.userId);
	}

	private refuse(threadId: string, call: "run" | "connect"): RunnerEvents {
		this.logRefusal(threadId, call);
		return of({
			type: EventType.RUN_ERROR,
			message: "Thread access denied",
			code: THREAD_ACCESS_DENIED_CODE,
		});
	}

	private logRefusal(threadId: string, call: "run" | "connect" | "stop") {
		logger.warn("[CopilotKit] Thread refused", {
			userId: this.userId,
			threadId,
			call,
		});
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
