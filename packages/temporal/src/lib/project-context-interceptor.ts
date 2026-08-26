/**
 * Ambient project-context propagation into Temporal activities.
 *
 * Registered once, this activity-inbound interceptor reads `projectId` off the
 * activity's first argument and re-enters `runWithProjectContext(...)` for the
 * activity body — so the Read-only mode write-gate (and any future project-
 * scoped concern) can read the owning project from AsyncLocalStorage with no
 * per-activity work. This is what makes background jobs and automations
 * (channel monitors, scheduled sync, auto-analyze, deployed-agent runs) covered
 * automatically: they all execute their external writes inside activities, and
 * the interceptor sets the context uniformly.
 *
 * Modeled exactly on {@link CorrelationActivityInboundInterceptor}. Activities
 * run in normal Node context, so `node:async_hooks` is safe here (workflows do
 * NOT run writes and must never import this file).
 *
 * The explicit `projectId` argument already threaded to the write-sites remains
 * the primary signal; this interceptor is the defense-in-depth that covers the
 * activities that don't (or newly won't) thread it.
 */

import { runWithProjectContext } from "@repo/utils/project-context";
import type {
	ActivityExecuteInput,
	ActivityInboundCallsInterceptor,
	Next as ActivityNext,
} from "@temporalio/worker";

/** Read `projectId` from the activity's first object argument, if present. */
function extractProjectId(input: ActivityExecuteInput): string | undefined {
	const first = input.args?.[0];
	if (first && typeof first === "object" && "projectId" in first) {
		const value = (first as { projectId?: unknown }).projectId;
		if (typeof value === "string" && value.length > 0) {
			return value;
		}
	}
	return undefined;
}

export class ProjectContextActivityInboundInterceptor
	implements ActivityInboundCallsInterceptor
{
	async execute(
		input: ActivityExecuteInput,
		next: ActivityNext<ActivityInboundCallsInterceptor, "execute">,
	): Promise<unknown> {
		const projectId = extractProjectId(input);
		if (!projectId) {
			return next(input);
		}
		return runWithProjectContext(projectId, () => next(input));
	}
}
