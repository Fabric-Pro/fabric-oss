/**
 * The background job a stretch of work belongs to (Fizzy #2770), for the AI
 * calls inside it that do not name one themselves: an agent turn, a chat
 * child workflow or a follow-on judge several layers below the job's entry
 * point. `getAIModelWithMetadata` and the decision resolver read it when the
 * caller's context has no `jobType`, so the whole job is billed, logged and
 * routed to the shared ChatGPT plans as that job. A `jobType` the caller
 * passes always wins.
 *
 * Entered by a job's entry point (`runWithAiJobType`) and, inside Temporal,
 * by `AiInteractiveActivityInboundInterceptor` from the job-type header the
 * client interceptor stamps from a workflow input's `jobType`.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { AI_JOB_TYPES, type AiJobKey } from "./job-keys";

const jobTypeStorage = new AsyncLocalStorage<AiJobKey>();

export function runWithAiJobType<T>(jobType: AiJobKey, fn: () => T): T {
	return jobTypeStorage.run(jobType, fn);
}

/**
 * Runs `fn` as `jobType` unless it already runs inside a job, for an entry
 * point that is always background work whatever started it: a run that
 * predates the job-type header, or one a Temporal schedule started.
 */
export function runWithDefaultAiJobType<T>(jobType: AiJobKey, fn: () => T): T {
	return jobTypeStorage.run(jobTypeStorage.getStore() ?? jobType, fn);
}

/** The job the current work belongs to, if a job entry point set one. */
export function currentAiJobType(): AiJobKey | undefined {
	return jobTypeStorage.getStore();
}

const apiFallbackStorage = new AsyncLocalStorage<true>();

/**
 * Runs `fn` as one bulk run a person let use the organization's own provider
 * once every shared ChatGPT plan is spent ("Run now on API billing"). Entered
 * from the run's own header, never from a policy: the organization's "Wait
 * for reset" stays in force for every other run.
 */
export function runWithAiApiFallbackApproved<T>(fn: () => T): T {
	return apiFallbackStorage.run(true, fn);
}

/** Whether the current work belongs to a run approved to bill the organization's provider. */
export function aiApiFallbackApproved(): boolean {
	return apiFallbackStorage.getStore() === true;
}

/** `value` when it is a job key this build knows, otherwise undefined. */
export function asAiJobKey(value: unknown): AiJobKey | undefined {
	return typeof value === "string" &&
		(AI_JOB_TYPES as readonly string[]).includes(value)
		? (value as AiJobKey)
		: undefined;
}
