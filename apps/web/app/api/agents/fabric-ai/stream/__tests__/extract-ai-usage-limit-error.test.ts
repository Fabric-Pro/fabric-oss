import { AiUsageLimitExceededError } from "@repo/payments";
import { describe, expect, it } from "vitest";
import { extractAiUsageLimitExceededError } from "../extract-ai-usage-limit-error";

const PAYLOAD = {
	limitId: "lim_abc123",
	dimension: "TOKENS" as const,
	window: "MONTHLY" as const,
	used: BigInt(2),
	max: BigInt(1),
	manageLimitsUrl: "/app/acme/settings/usage?limitId=lim_abc123",
};

const MESSAGE = `AI usage limit exceeded: ${PAYLOAD.limitId} (${PAYLOAD.dimension}, ${PAYLOAD.window}) — used ${PAYLOAD.used.toString()} of ${PAYLOAD.max.toString()}`;

function makeOriginal(): AiUsageLimitExceededError {
	return new AiUsageLimitExceededError({
		message: MESSAGE,
		limitId: PAYLOAD.limitId,
		dimension: PAYLOAD.dimension,
		window: PAYLOAD.window,
		used: PAYLOAD.used,
		max: PAYLOAD.max,
		manageLimitsUrl: PAYLOAD.manageLimitsUrl,
	});
}

describe("extractAiUsageLimitExceededError", () => {
	it("matches the class instance directly", () => {
		const out = extractAiUsageLimitExceededError(makeOriginal());
		expect(out).not.toBeNull();
		expect(out?.limitId).toBe(PAYLOAD.limitId);
		expect(out?.dimension).toBe("TOKENS");
		expect(out?.window).toBe("MONTHLY");
		expect(out?.used).toBe(BigInt(2));
		expect(out?.max).toBe(BigInt(1));
		expect(out?.manageLimitsUrl).toBe(PAYLOAD.manageLimitsUrl);
	});

	it("walks a single `cause` link", () => {
		const wrapped = new Error("workflow boom");
		(wrapped as { cause?: unknown }).cause = makeOriginal();
		const out = extractAiUsageLimitExceededError(wrapped);
		expect(out?.limitId).toBe(PAYLOAD.limitId);
		expect(out?.manageLimitsUrl).toBe(PAYLOAD.manageLimitsUrl);
	});

	it("walks a nested `cause` chain (ApplicationFailure → ActivityFailure → original)", () => {
		const inner = makeOriginal();
		const activityFailure = new Error("activity failed");
		(activityFailure as { cause?: unknown }).cause = inner;
		const applicationFailure = new Error("application failed");
		(applicationFailure as { cause?: unknown }).cause = activityFailure;
		const workflowFailed = new Error("workflow execution failed");
		(workflowFailed as { cause?: unknown }).cause = applicationFailure;

		const out = extractAiUsageLimitExceededError(workflowFailed);
		expect(out?.limitId).toBe(PAYLOAD.limitId);
	});

	it("matches a plain-object duck-type that lost its prototype chain", () => {
		const stripped = {
			name: "AiUsageLimitExceededError",
			message: MESSAGE,
			limitId: PAYLOAD.limitId,
			dimension: "TOKENS",
			window: "MONTHLY",
			used: "2",
			max: "1",
			manageLimitsUrl: PAYLOAD.manageLimitsUrl,
		};
		const out = extractAiUsageLimitExceededError(stripped);
		expect(out?.limitId).toBe(PAYLOAD.limitId);
		expect(out?.used).toBe(BigInt(2));
		expect(out?.max).toBe(BigInt(1));
	});

	it("falls back to message regex when no structured fields survived (Temporal worker boundary)", () => {
		// The worst-case Temporal envelope: `name`/custom fields lost,
		// only the message string survived. This is what we see in the
		// real-world tool-call-blocked path on staging.
		const reWrapped = {
			name: "ApplicationFailure",
			message: MESSAGE,
			cause: null,
		};
		const out = extractAiUsageLimitExceededError(reWrapped);
		expect(out).not.toBeNull();
		expect(out?.limitId).toBe(PAYLOAD.limitId);
		expect(out?.dimension).toBe("TOKENS");
		expect(out?.window).toBe("MONTHLY");
		expect(out?.used).toBe(BigInt(2));
		expect(out?.max).toBe(BigInt(1));
		// `manageLimitsUrl` is not in the message — graceful empty
		// fallback so the toast helper omits the action button.
		expect(out?.manageLimitsUrl).toBe("");
	});

	it("falls back to message regex through a nested envelope", () => {
		// More realistic: Temporal wraps the original error in
		// ApplicationFailure (which loses the class instance), then in
		// ActivityFailure, then in WorkflowFailedError. The message
		// string lives on the inner envelope; the walk has to reach it.
		const innerWithMessage = {
			name: "ApplicationFailure",
			message: MESSAGE,
		};
		const activityFailure = {
			name: "ActivityFailure",
			message: "Activity task failed",
			cause: innerWithMessage,
		};
		const workflowFailed = {
			name: "WorkflowFailedError",
			message: "Workflow execution failed",
			cause: activityFailure,
		};
		const out = extractAiUsageLimitExceededError(workflowFailed);
		expect(out?.limitId).toBe(PAYLOAD.limitId);
	});

	it("walks `errors[]` for AggregateError-style chains", () => {
		const inner = makeOriginal();
		const aggregate = { errors: [new Error("unrelated"), inner] };
		const out = extractAiUsageLimitExceededError(aggregate);
		expect(out?.limitId).toBe(PAYLOAD.limitId);
	});

	it("returns null for unrelated errors", () => {
		expect(extractAiUsageLimitExceededError(new Error("boom"))).toBeNull();
		expect(extractAiUsageLimitExceededError(null)).toBeNull();
		expect(extractAiUsageLimitExceededError(undefined)).toBeNull();
		expect(extractAiUsageLimitExceededError("string")).toBeNull();
	});

	it("returns null when the message looks similar but does not match the exact format", () => {
		const lookalike = {
			name: "Error",
			message: "AI usage limit exceeded — please try later",
		};
		expect(extractAiUsageLimitExceededError(lookalike)).toBeNull();
	});

	it("does not loop forever on a cyclic cause chain", () => {
		const a: { name: string; cause: unknown } = { name: "A", cause: null };
		const b: { name: string; cause: unknown } = { name: "B", cause: a };
		a.cause = b;
		// Should terminate without throwing or hanging.
		expect(extractAiUsageLimitExceededError(a)).toBeNull();
	});
});
