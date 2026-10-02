import { ContextOverflowError, stampRetryable } from "@langchain/core/errors";
import { describe, expect, it } from "vitest";
import {
	calculateRetryDelay,
	isContextOverflowError,
	isJsonParseError,
	isRetryableError,
	RETRY_BASE_DELAY_MS,
	RETRY_MAX_DELAY_MS,
	sleep,
} from "../src/retry";

describe("isJsonParseError", () => {
	it("recognizes a tool-call JSON parse failure", () => {
		expect(
			isJsonParseError(
				new Error("Failed to parse tool call arguments as JSON"),
			),
		).toBe(true);
	});

	it("recognizes an 'Invalid JSON' message", () => {
		expect(isJsonParseError(new Error("Invalid JSON in response"))).toBe(
			true,
		);
	});

	it("recognizes a 'JSON parse error' message", () => {
		expect(
			isJsonParseError(new Error("JSON parse error at position 4")),
		).toBe(true);
	});

	it("returns false for an unrelated error", () => {
		expect(isJsonParseError(new Error("Something else went wrong"))).toBe(
			false,
		);
	});
});

describe("isRetryableError", () => {
	it("is retryable for a JSON parse error", () => {
		expect(isRetryableError(new Error("Invalid JSON"))).toBe(true);
	});

	it("is retryable for a timeout", () => {
		expect(isRetryableError(new Error("Request timeout"))).toBe(true);
	});

	it("is retryable for a rate limit message", () => {
		expect(isRetryableError(new Error("rate limit exceeded"))).toBe(true);
	});

	it("is retryable for a network error", () => {
		expect(isRetryableError(new Error("network error occurred"))).toBe(
			true,
		);
	});

	it("is retryable for ECONNREFUSED", () => {
		expect(isRetryableError(new Error("connect ECONNREFUSED"))).toBe(true);
	});

	it("is NOT retryable for a non-matching error", () => {
		expect(isRetryableError(new Error("Validation failed"))).toBe(false);
	});
});

/**
 * `openai` is not a dependency of @repo/agent-core, so the SDK's APIError
 * family cannot be imported here. These helpers build plain errors with the
 * shape the SDK produces (constructor name, `.status`, `.cause`, message
 * wording) — `openai` v7 does not set `name` to the class name, so the
 * constructor name is what the classifier sees.
 */
function apiError(
	className: string,
	status: number | undefined,
	message: string,
	extra: Record<string, unknown> = {},
): Error {
	const Ctor = { [className]: class extends Error {} }[className] as new (
		message: string,
	) => Error;
	const error = new Ctor(message);
	Object.assign(error, { status }, extra);
	return error;
}

describe("isRetryableError against SDK-shaped errors", () => {
	it.each([
		[
			"503 InternalServerError",
			apiError("InternalServerError", 503, "503 status code (no body)"),
		],
		["502", apiError("InternalServerError", 502, "502 Bad Gateway")],
		[
			"504",
			apiError("InternalServerError", 504, "504 status code (no body)"),
		],
		[
			"529 Anthropic overloaded_error",
			apiError(
				"InternalServerError",
				529,
				'529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
			),
		],
		[
			"429 'Rate limit reached' (capital R)",
			apiError(
				"RateLimitError",
				429,
				"429 Rate limit reached for requests",
			),
		],
		["408", apiError("APIError", 408, "408 Request Timeout body")],
		["425", apiError("APIError", 425, "425 Too Early")],
		[
			"status only on response.status",
			Object.assign(new Error("upstream failed"), {
				response: { status: 503 },
			}),
		],
		[
			"numeric-string statusCode",
			Object.assign(new Error("upstream failed"), { statusCode: "502" }),
		],
		[
			"TimeoutError 'Request timed out.'",
			Object.assign(new Error("Request timed out."), {
				name: "TimeoutError",
			}),
		],
		[
			"APIConnectionError with cause ECONNRESET",
			apiError("APIConnectionError", undefined, "Connection error.", {
				cause: Object.assign(new Error("read ECONNRESET"), {
					code: "ECONNRESET",
				}),
			}),
		],
		[
			"APIConnectionTimeoutError",
			apiError(
				"APIConnectionTimeoutError",
				undefined,
				"Request timed out.",
			),
		],
		[
			"plain Error with code ETIMEDOUT",
			Object.assign(new Error("connect failed"), { code: "ETIMEDOUT" }),
		],
		[
			"fetch failed with undici cause code",
			Object.assign(new TypeError("boom"), {
				cause: { code: "UND_ERR_SOCKET" },
			}),
		],
		[
			"'Service Unavailable' with no status",
			new Error("Service Unavailable"),
		],
		["'fetch failed' message", new Error("fetch failed")],
		["'socket hang up' message", new Error("socket hang up")],
		["'Overloaded' message", new Error("Overloaded")],
		[
			"stamped retryable",
			stampRetryable(new Error("opaque failure"), true),
		],
	])("retries %s", (_label, error) => {
		expect(isRetryableError(error)).toBe(true);
	});

	it.each([
		[
			"400 BadRequest",
			apiError("BadRequestError", 400, "400 invalid tool schema"),
		],
		["401", apiError("AuthenticationError", 401, "401 Incorrect API key")],
		["403", apiError("PermissionDeniedError", 403, "403 Forbidden")],
		["404", apiError("NotFoundError", 404, "404 model not found")],
		["413", apiError("APIError", 413, "413 Payload Too Large")],
		[
			"4xx whose message mentions a timeout",
			apiError(
				"BadRequestError",
				400,
				"400 timeout parameter is invalid",
			),
		],
		[
			"stamped non-retryable even though the message says timeout",
			stampRetryable(new Error("request timeout"), false),
		],
		[
			"503 stamped non-retryable (stamp wins over status)",
			stampRetryable(
				apiError("InternalServerError", 503, "irrelevant"),
				false,
			),
		],
		[
			"AbortError",
			Object.assign(new Error("Request was aborted. timeout"), {
				name: "AbortError",
			}),
		],
		[
			"ContextOverflowError",
			ContextOverflowError.fromError(new Error("x")),
		],
		[
			"Anthropic 'prompt is too long' over the OpenAI-compatible path",
			apiError(
				"BadRequestError",
				400,
				"400 prompt is too long: 215000 tokens > 200000 maximum",
			),
		],
		[
			"'prompt is too long' as a plain Error with a retryable-looking message",
			new Error(
				"prompt is too long: 215000 tokens > 200000 maximum, network",
			),
		],
		["null", null],
		["undefined", undefined],
		["a string", "something odd happened"],
		["an empty object", {}],
	])("does not retry %s", (_label, error) => {
		expect(isRetryableError(error)).toBe(false);
	});

	it("treats a thrown string that names a transient condition as retryable", () => {
		expect(isRetryableError("Service Unavailable")).toBe(true);
	});

	it("retries a JSON parse error even when it carries a 400 status", () => {
		expect(
			isRetryableError(
				Object.assign(new Error("Invalid JSON"), { status: 400 }),
			),
		).toBe(true);
	});

	it("does not retry an overflow error whose message also says 'Invalid JSON'", () => {
		expect(
			isRetryableError(
				Object.assign(
					new Error(
						"Invalid JSON: prompt is too long: 215000 tokens",
					),
					{ status: 400 },
				),
			),
		).toBe(false);
		expect(
			isRetryableError(
				ContextOverflowError.fromError(new Error("Invalid JSON")),
			),
		).toBe(false);
	});

	it("does not retry an AbortError whose message says 'Invalid JSON'", () => {
		expect(
			isRetryableError(
				Object.assign(new Error("Invalid JSON"), {
					name: "AbortError",
				}),
			),
		).toBe(false);
	});

	it("does not retry an error stamped non-retryable that says 'Invalid JSON' with a 400", () => {
		expect(
			isRetryableError(
				stampRetryable(
					Object.assign(new Error("Invalid JSON in request body"), {
						status: 400,
					}),
					false,
				),
			),
		).toBe(false);
	});

	it("does not retry a JSON parse error that sits on a permanent TLS cause", () => {
		expect(
			isRetryableError(
				new Error("Invalid JSON", {
					cause: { code: "CERT_HAS_EXPIRED" },
				}),
			),
		).toBe(false);
	});
});

describe("isRetryableError and server cooldowns", () => {
	function rateLimited(
		retryAfterMs: number | undefined,
		rateLimitType: string,
	): Error {
		const error = apiError("RateLimitError", 429, "429 Too Many Requests", {
			rateLimitType,
			...(retryAfterMs === undefined ? {} : { retryAfterMs }),
		});
		return stampRetryable(error, true);
	}

	it("does not retry a 429 whose Retry-After exceeds the node backoff", () => {
		expect(isRetryableError(rateLimited(120_000, "capacity"))).toBe(false);
	});

	it("does not retry just above the node backoff ceiling", () => {
		expect(
			isRetryableError(rateLimited(RETRY_MAX_DELAY_MS + 1, "wait")),
		).toBe(false);
	});

	it("retries a 429 whose Retry-After is within the node backoff limit", () => {
		expect(isRetryableError(rateLimited(2000, "wait"))).toBe(true);
		expect(isRetryableError(rateLimited(RETRY_MAX_DELAY_MS, "wait"))).toBe(
			true,
		);
	});

	it("retries a header-less capacity 429 (no retryAfterMs)", () => {
		expect(isRetryableError(rateLimited(undefined, "capacity"))).toBe(true);
	});
});

describe("isRetryableError and connection causes", () => {
	const connectionError = (cause: unknown) =>
		apiError("APIConnectionError", undefined, "Connection error.", {
			cause,
		});

	it.each([
		"DEPTH_ZERO_SELF_SIGNED_CERT",
		"SELF_SIGNED_CERT_IN_CHAIN",
		"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
		"UNABLE_TO_GET_ISSUER_CERT",
		"UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
		"CERT_HAS_EXPIRED",
		"CERT_NOT_YET_VALID",
		"ERR_TLS_CERT_ALTNAME_INVALID",
		"ERR_INVALID_URL",
		"ERR_INVALID_PROTOCOL",
	])("does not retry an APIConnectionError caused by %s", (code) => {
		expect(
			isRetryableError(
				connectionError(Object.assign(new Error("tls"), { code })),
			),
		).toBe(false);
	});

	it("does not retry when the permanent code is two levels down behind 'fetch failed'", () => {
		const inner = Object.assign(new Error("certificate has expired"), {
			code: "CERT_HAS_EXPIRED",
		});
		const fetchFailed = new Error("fetch failed", { cause: inner });
		expect(isRetryableError(connectionError(fetchFailed))).toBe(false);
	});

	it("does not retry a permanent code on the error itself", () => {
		expect(
			isRetryableError(
				Object.assign(new Error("bad url, timeout"), {
					code: "ERR_INVALID_URL",
				}),
			),
		).toBe(false);
	});

	it("retries when a two-level cause chain ends in ECONNRESET", () => {
		const socket = Object.assign(new Error("read ECONNRESET"), {
			code: "ECONNRESET",
		});
		const fetchFailed = new Error("opaque", { cause: socket });
		expect(
			isRetryableError(new Error("also opaque", { cause: fetchFailed })),
		).toBe(true);
		expect(isRetryableError(connectionError(fetchFailed))).toBe(true);
	});

	it("terminates on a cyclic cause chain", () => {
		const a: Error & { cause?: unknown } = new Error("opaque");
		const b: Error & { cause?: unknown } = new Error("opaque", {
			cause: a,
		});
		a.cause = b;
		expect(isRetryableError(a)).toBe(false);
	});

	it("does not look past the cause-depth bound", () => {
		let chain: unknown = { code: "ECONNRESET" };
		for (let i = 0; i < 8; i++) {
			chain = new Error("opaque", { cause: chain });
		}
		expect(isRetryableError(chain)).toBe(false);
	});
});

describe("isJsonParseError with non-Error input", () => {
	it("returns false for null, undefined and strings", () => {
		expect(isJsonParseError(null)).toBe(false);
		expect(isJsonParseError(undefined)).toBe(false);
		expect(isJsonParseError("Invalid JSON")).toBe(false);
	});
});

describe("isContextOverflowError", () => {
	it("is true for a LangChain ContextOverflowError", () => {
		expect(
			isContextOverflowError(
				ContextOverflowError.fromError(new Error("x")),
			),
		).toBe(true);
	});

	it("is true for the OpenAI context_length_exceeded code", () => {
		expect(
			isContextOverflowError(
				Object.assign(new Error("400 bad request"), {
					code: "context_length_exceeded",
				}),
			),
		).toBe(true);
	});

	it("is true for a nested error.code", () => {
		expect(
			isContextOverflowError(
				Object.assign(new Error("400 bad request"), {
					error: { code: "context_length_exceeded" },
				}),
			),
		).toBe(true);
	});

	it("is true for Anthropic 'prompt is too long' wording on a plain Error", () => {
		expect(
			isContextOverflowError(
				new Error("prompt is too long: 215000 tokens > 200000 maximum"),
			),
		).toBe(true);
	});

	it("is true for 'maximum context length' wording", () => {
		expect(
			isContextOverflowError(
				new Error(
					"This model's maximum context length is 128000 tokens",
				),
			),
		).toBe(true);
	});

	it("is true for a 400 mentioning 'too long' or 'context'", () => {
		expect(
			isContextOverflowError(
				Object.assign(new Error("input too long"), { status: 400 }),
			),
		).toBe(true);
	});

	it("is true for an Error whose cause is a ContextOverflowError", () => {
		expect(
			isContextOverflowError(
				new Error("model call failed", {
					cause: ContextOverflowError.fromError(new Error("x")),
				}),
			),
		).toBe(true);
	});

	it("is true for an Error whose cause carries the overflow wording", () => {
		expect(
			isContextOverflowError(
				new Error("model call failed", {
					cause: new Error("prompt is too long: 9 tokens"),
				}),
			),
		).toBe(true);
	});

	it("is false for a 400 about an invalid tool schema", () => {
		expect(
			isContextOverflowError(
				Object.assign(new Error("invalid tool schema"), {
					status: 400,
				}),
			),
		).toBe(false);
	});

	it("is false for a 503", () => {
		expect(
			isContextOverflowError(
				Object.assign(new Error("503 Service Unavailable"), {
					status: 503,
				}),
			),
		).toBe(false);
	});

	it("is false for non-object input", () => {
		expect(isContextOverflowError(null)).toBe(false);
		expect(isContextOverflowError(undefined)).toBe(false);
		expect(isContextOverflowError("prompt is too long")).toBe(false);
	});
});

describe("calculateRetryDelay", () => {
	it("returns RETRY_BASE_DELAY_MS at retryCount 0", () => {
		expect(calculateRetryDelay(0)).toBe(RETRY_BASE_DELAY_MS);
		expect(calculateRetryDelay(0)).toBe(500);
	});

	it("doubles each retry count below the cap", () => {
		expect(calculateRetryDelay(1)).toBe(1000);
		expect(calculateRetryDelay(2)).toBe(2000);
		expect(calculateRetryDelay(3)).toBe(4000);
	});

	it("caps at RETRY_MAX_DELAY_MS beyond the cap", () => {
		expect(calculateRetryDelay(4)).toBe(RETRY_MAX_DELAY_MS);
		expect(calculateRetryDelay(5)).toBe(4000);
		expect(calculateRetryDelay(10)).toBe(4000);
	});
});

describe("sleep", () => {
	it("returns a promise", () => {
		const result = sleep(1);
		expect(result).toBeInstanceOf(Promise);
	});

	it("resolves after the delay", async () => {
		const start = Date.now();
		await sleep(20);
		expect(Date.now() - start).toBeGreaterThanOrEqual(15);
	});
});
