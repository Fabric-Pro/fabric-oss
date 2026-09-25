import { describe, expect, it } from "vitest";
import {
	adapterError,
	causeOfStatus,
	retryAfterSecondsOf,
	statusError,
} from "../../src/instruction-pull-requests/classify";

describe("classify", () => {
	it.each([
		[401, {}, "auth"],
		[403, {}, "permission"],
		[403, { "x-ratelimit-remaining": "0" }, "rate_limit"],
		[403, { "retry-after": "10" }, "rate_limit"],
		[429, {}, "rate_limit"],
		[404, {}, "not_found"],
		[409, {}, "conflict"],
		[422, {}, "conflict"],
		[408, {}, "transient"],
		[500, {}, "transient"],
		[503, {}, "transient"],
		[400, {}, "unknown"],
	] as const)("HTTP %i %o is %s", (status, headers, cause) => {
		expect(causeOfStatus(status, new Headers(headers))).toBe(cause);
	});

	it("reads Retry-After as seconds or a date, then a reset epoch", () => {
		const now = Date.parse("2026-09-24T00:00:00Z");
		expect(
			retryAfterSecondsOf(new Headers({ "retry-after": "30" }), now),
		).toBe(30);
		expect(
			retryAfterSecondsOf(
				new Headers({ "retry-after": "Thu, 24 Sep 2026 00:01:00 GMT" }),
				now,
			),
		).toBe(60);
		expect(
			retryAfterSecondsOf(
				new Headers({ "x-ratelimit-reset": String(now / 1000 + 90) }),
				now,
			),
		).toBe(90);
		expect(retryAfterSecondsOf(new Headers(), now)).toBeUndefined();
	});

	it("maps an open's transient failure to CREATE_OUTCOME_UNKNOWN and a definitive one to PR_CREATION_REFUSED", () => {
		expect(adapterError("open", "transient")).toMatchObject({
			code: "CREATE_OUTCOME_UNKNOWN",
			retryable: true,
		});
		expect(adapterError("open", "unknown").code).toBe(
			"CREATE_OUTCOME_UNKNOWN",
		);
		expect(adapterError("open", "permission")).toMatchObject({
			code: "PR_CREATION_REFUSED",
			retryable: false,
		});
		expect(adapterError("lookup", "transient").code).toBe(
			"PROVIDER_TEMPORARY",
		);
		expect(adapterError("lookup", "unknown").code).toBe(
			"LOOKUP_INCONCLUSIVE",
		);
		expect(adapterError("close", "permission").code).toBe("CLOSE_REFUSED");
	});

	it("carries a rate limit's delay and nothing of the response", () => {
		const error = statusError(
			"lookup",
			429,
			new Headers({ "retry-after": "12", "x-secret": "value" }),
		);
		expect(error).toMatchObject({
			code: "PROVIDER_RATE_LIMITED",
			retryAfterSeconds: 12,
			cause: "rate_limit",
		});
		expect(JSON.stringify(error)).not.toContain("value");
		expect(error.message).toBe(
			"Pull request provider call failed (PROVIDER_RATE_LIMITED)",
		);
	});
});
