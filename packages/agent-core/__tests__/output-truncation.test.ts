import {
	hoistRawStopReason,
	isOutputTruncated,
	resolveStopReason,
} from "@repo/agent-core/output-truncation";
import { describe, expect, it } from "vitest";

describe("isOutputTruncated", () => {
	it("recognizes Anthropic's stop_reason: max_tokens", () => {
		expect(
			isOutputTruncated({
				response_metadata: { stop_reason: "max_tokens" },
			}),
		).toBe(true);
	});

	it("recognizes Chat Completions' finish_reason: length", () => {
		expect(
			isOutputTruncated({
				response_metadata: { finish_reason: "length" },
			}),
		).toBe(true);
	});

	it("recognizes the Responses API's status: incomplete + incomplete_details.reason: max_output_tokens", () => {
		expect(
			isOutputTruncated({
				response_metadata: {
					status: "incomplete",
					incomplete_details: { reason: "max_output_tokens" },
				},
			}),
		).toBe(true);
	});

	it("does NOT treat a non-token incomplete reason as truncation", () => {
		expect(
			isOutputTruncated({
				response_metadata: {
					status: "incomplete",
					incomplete_details: { reason: "content_filter" },
				},
			}),
		).toBe(false);
	});

	it("does NOT treat status: incomplete with no incomplete_details as truncation", () => {
		expect(
			isOutputTruncated({
				response_metadata: { status: "incomplete" },
			}),
		).toBe(false);
	});

	it("returns false when there is no response_metadata", () => {
		expect(isOutputTruncated({})).toBe(false);
		expect(isOutputTruncated(null)).toBe(false);
		expect(isOutputTruncated(undefined)).toBe(false);
	});

	it("returns false for a normal stop", () => {
		expect(
			isOutputTruncated({
				response_metadata: { stop_reason: "end_turn" },
			}),
		).toBe(false);
		expect(
			isOutputTruncated({
				response_metadata: { finish_reason: "stop" },
			}),
		).toBe(false);
	});

	it("returns false for a tool-call stop (not a truncation signal)", () => {
		expect(
			isOutputTruncated({
				response_metadata: { stop_reason: "tool_use" },
			}),
		).toBe(false);
	});
});

describe("resolveStopReason", () => {
	it("prefers stop_reason, then finish_reason, then incomplete_details.reason", () => {
		expect(
			resolveStopReason({
				response_metadata: { stop_reason: "max_tokens" },
			}),
		).toBe("max_tokens");
		expect(
			resolveStopReason({
				response_metadata: { finish_reason: "length" },
			}),
		).toBe("length");
		expect(
			resolveStopReason({
				response_metadata: {
					status: "incomplete",
					incomplete_details: { reason: "max_output_tokens" },
				},
			}),
		).toBe("max_output_tokens");
	});

	it("returns undefined when nothing is present", () => {
		expect(resolveStopReason({})).toBeUndefined();
		expect(resolveStopReason(undefined)).toBeUndefined();
	});
});

describe("hoistRawStopReason", () => {
	it("hoists finish_reason from a non-streaming choice shape", () => {
		const response = {
			response_metadata: { model_provider: "databricks", usage: {} },
			additional_kwargs: {
				__raw_response: {
					choices: [
						{ message: { content: "x" }, finish_reason: "length" },
					],
				},
			},
		};
		hoistRawStopReason(response);
		expect(response.response_metadata).toEqual({
			model_provider: "databricks",
			usage: {},
			finish_reason: "length",
		});
	});

	it("hoists finish_reason from a streaming (delta) choice shape", () => {
		const response = {
			response_metadata: {},
			additional_kwargs: {
				__raw_response: {
					choices: [
						{ delta: { content: "x" }, finish_reason: "length" },
					],
				},
			},
		};
		hoistRawStopReason(response);
		expect(
			(response.response_metadata as Record<string, unknown>)
				.finish_reason,
		).toBe("length");
	});

	it("falls back to the choice-level stop_reason when finish_reason is absent", () => {
		const response = {
			response_metadata: {},
			additional_kwargs: {
				__raw_response: {
					choices: [{ message: {}, stop_reason: "max_tokens" }],
				},
			},
		};
		hoistRawStopReason(response);
		expect(
			(response.response_metadata as Record<string, unknown>)
				.finish_reason,
		).toBe("max_tokens");
	});

	it("does not overwrite an existing response_metadata.finish_reason", () => {
		const response = {
			response_metadata: { finish_reason: "stop" },
			additional_kwargs: {
				__raw_response: {
					choices: [{ message: {}, finish_reason: "length" }],
				},
			},
		};
		hoistRawStopReason(response);
		expect(
			(response.response_metadata as Record<string, unknown>)
				.finish_reason,
		).toBe("stop");
	});

	it("does not overwrite an existing response_metadata.stop_reason", () => {
		const response = {
			response_metadata: { stop_reason: "end_turn" },
			additional_kwargs: {
				__raw_response: {
					choices: [{ message: {}, finish_reason: "length" }],
				},
			},
		};
		hoistRawStopReason(response);
		expect(
			(response.response_metadata as Record<string, unknown>)
				.finish_reason,
		).toBeUndefined();
		expect(
			(response.response_metadata as Record<string, unknown>).stop_reason,
		).toBe("end_turn");
	});

	// Codex review (issue #2781 follow-up): an explicit `null` (a provider
	// that includes the key but leaves it empty) previously blocked the
	// hoist via a strict `!== undefined` check — `null` is not an
	// authoritative value any more than an absent key is, so it must not
	// shadow a real reason recovered from the raw envelope.
	it("does NOT let an explicit null response_metadata.stop_reason block the hoist", () => {
		const response = {
			response_metadata: { stop_reason: null },
			additional_kwargs: {
				__raw_response: {
					choices: [{ message: {}, finish_reason: "length" }],
				},
			},
		};
		hoistRawStopReason(response);
		expect(resolveStopReason(response)).toBe("length");
		expect(isOutputTruncated(response)).toBe(true);
	});

	it("does NOT let an explicit null response_metadata.finish_reason block the hoist", () => {
		const response = {
			response_metadata: { finish_reason: null },
			additional_kwargs: {
				__raw_response: {
					choices: [{ message: {}, finish_reason: "length" }],
				},
			},
		};
		hoistRawStopReason(response);
		expect(resolveStopReason(response)).toBe("length");
		expect(isOutputTruncated(response)).toBe(true);
	});

	it("creates response_metadata when it doesn't exist", () => {
		const response = {
			additional_kwargs: {
				__raw_response: {
					choices: [{ message: {}, finish_reason: "length" }],
				},
			},
		} as { response_metadata?: Record<string, unknown> };
		hoistRawStopReason(response);
		expect(response.response_metadata).toEqual({ finish_reason: "length" });
	});

	it("is idempotent — calling twice does not change the result", () => {
		const response = {
			response_metadata: {},
			additional_kwargs: {
				__raw_response: {
					choices: [{ message: {}, finish_reason: "length" }],
				},
			},
		};
		hoistRawStopReason(response);
		hoistRawStopReason(response);
		expect(
			(response.response_metadata as Record<string, unknown>)
				.finish_reason,
		).toBe("length");
	});

	it("tolerates null/undefined/primitive input without throwing", () => {
		expect(() => hoistRawStopReason(null)).not.toThrow();
		expect(() => hoistRawStopReason(undefined)).not.toThrow();
		expect(() => hoistRawStopReason(42)).not.toThrow();
		expect(() => hoistRawStopReason("string")).not.toThrow();
	});

	it("tolerates malformed/missing shapes without throwing or mutating", () => {
		const noKwargs = { content: "x" };
		hoistRawStopReason(noKwargs);
		expect(noKwargs).toEqual({ content: "x" });

		const noRaw = { additional_kwargs: {} };
		hoistRawStopReason(noRaw);
		expect(noRaw).toEqual({ additional_kwargs: {} });

		const noChoices = {
			additional_kwargs: { __raw_response: { id: "chatcmpl-xyz" } },
		};
		expect(() => hoistRawStopReason(noChoices)).not.toThrow();
		expect(
			(noChoices as { response_metadata?: unknown }).response_metadata,
		).toBeUndefined();

		const emptyChoices = {
			additional_kwargs: { __raw_response: { choices: [] } },
		};
		expect(() => hoistRawStopReason(emptyChoices)).not.toThrow();

		const nullChoice = {
			additional_kwargs: { __raw_response: { choices: [null] } },
		};
		expect(() => hoistRawStopReason(nullChoice)).not.toThrow();

		const noReasonOnChoice = {
			additional_kwargs: {
				__raw_response: { choices: [{ message: {} }] },
			},
		};
		hoistRawStopReason(noReasonOnChoice);
		expect(
			(noReasonOnChoice as { response_metadata?: unknown })
				.response_metadata,
		).toBeUndefined();
	});

	it("does not hoist when __raw_response is absent", () => {
		const response = { additional_kwargs: { other: "kept" } };
		hoistRawStopReason(response);
		expect(
			(response as { response_metadata?: unknown }).response_metadata,
		).toBeUndefined();
	});
});

describe("hoistRawStopReason — integration with resolveStopReason / isOutputTruncated", () => {
	it("after hoisting, resolveStopReason returns the raw finish_reason", () => {
		const response = {
			response_metadata: { model_provider: "databricks" },
			additional_kwargs: {
				__raw_response: {
					choices: [{ message: {}, finish_reason: "length" }],
				},
			},
		};
		hoistRawStopReason(response);
		expect(resolveStopReason(response)).toBe("length");
	});

	it("after hoisting, isOutputTruncated returns true for a length finish_reason", () => {
		const response = {
			response_metadata: {},
			additional_kwargs: {
				__raw_response: {
					choices: [{ delta: {}, finish_reason: "length" }],
				},
			},
		};
		hoistRawStopReason(response);
		expect(isOutputTruncated(response)).toBe(true);
	});
});
