/**
 * Correlation-ID propagation across Temporal boundaries.
 *
 * Three interceptors, registered once each:
 *
 *  1. {@link makeCorrelationClientInterceptor} — wraps `client.workflow.start()`
 *     on the API side. Reads the active request's correlation ID from
 *     AsyncLocalStorage and attaches it to the workflow execution's Temporal
 *     header payload.
 *
 *  2. {@link CorrelationActivityInboundInterceptor} — wraps every activity
 *     execution on the worker. Pulls the correlation ID off the activity's
 *     headers (Temporal propagates the workflow header onto child activity
 *     calls when the workflow outbound interceptor below is also wired) and
 *     re-enters `correlationStorage.run(...)` for the activity body. This is
 *     what makes the global logger reporter + audit-log writes inside an
 *     activity automatically carry the request's correlation ID with no
 *     per-activity work.
 *
 *  3. Workflow-side outbound propagation lives at
 *     `workflows/correlation-workflow-interceptor.ts` (sandbox-safe — must
 *     not import this file because it depends on `node:async_hooks`).
 *
 * Best-practice pattern modeled on `@temporalio/interceptors-opentelemetry`
 * which uses the exact same three-stage propagation for W3C trace context.
 */

import {
	correlationStorage,
	getCorrelationIdFromContext,
} from "@repo/utils/correlation-id";
import type {
	Next as ClientNext,
	WorkflowClientInterceptor,
	WorkflowStartInput,
} from "@temporalio/client";
import { defaultPayloadConverter } from "@temporalio/common";
import type {
	ActivityExecuteInput,
	ActivityInboundCallsInterceptor,
	Next as ActivityNext,
} from "@temporalio/worker";

/**
 * Header key. We use lower-case to match HTTP convention and the
 * existing `correlationIdMiddleware` (Hono) that reads request headers.
 */
export const TEMPORAL_CORRELATION_HEADER = "x-correlation-id";

function decodeCorrelationHeader(
	headers: Record<string, unknown> | undefined,
): string | undefined {
	const payload = headers?.[TEMPORAL_CORRELATION_HEADER];
	if (!payload) {
		return undefined;
	}
	try {
		const decoded = defaultPayloadConverter.fromPayload(payload as never);
		if (typeof decoded === "string" && decoded.length > 0) {
			return decoded;
		}
	} catch {
		// Unparseable header — ignore. We never want a malformed header to
		// crash the activity; just continue without a correlation context.
	}
	return undefined;
}

/**
 * Wraps activity execution in `correlationStorage.run(...)` so the global
 * logger reporter + audit helpers + downstream fetches all see the request
 * correlation ID without any per-activity changes.
 */
export class CorrelationActivityInboundInterceptor
	implements ActivityInboundCallsInterceptor
{
	async execute(
		input: ActivityExecuteInput,
		next: ActivityNext<ActivityInboundCallsInterceptor, "execute">,
	): Promise<unknown> {
		const correlationId = decodeCorrelationHeader(input.headers);
		if (!correlationId) {
			return next(input);
		}
		return correlationStorage.run(correlationId, () => next(input));
	}
}

/**
 * Wraps `client.workflow.start()` on the API side. The interceptor reads
 * the current request's correlation ID from AsyncLocalStorage and stamps
 * it onto the workflow execution's headers so the worker can pick it up.
 *
 * Registered once at client-creation time, covers every current AND every
 * future workflow start with zero per-callsite work.
 */
export function makeCorrelationClientInterceptor(): WorkflowClientInterceptor {
	return {
		async start(
			input: WorkflowStartInput,
			next: ClientNext<WorkflowClientInterceptor, "start">,
		) {
			const correlationId = getCorrelationIdFromContext();
			if (!correlationId) {
				return next(input);
			}
			const payload = defaultPayloadConverter.toPayload(correlationId);
			if (!payload) {
				return next(input);
			}
			return next({
				...input,
				headers: {
					...input.headers,
					[TEMPORAL_CORRELATION_HEADER]: payload,
				},
			});
		},
	};
}
