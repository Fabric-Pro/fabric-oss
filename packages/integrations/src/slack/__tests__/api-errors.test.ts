/**
 * Slack reports configuration problems with HTTP 200 and `ok:false`, so they
 * are indistinguishable from transient faults unless classified. Getting this
 * wrong is expensive in a specific way: a poller retries a state only a human
 * can clear, every cycle, forever. `not_in_channel` alone produced roughly
 * 2,000 worker errors a week in production.
 */
import { describe, expect, it } from "vitest";
import {
	isPermanentSlackError,
	PERMANENT_SLACK_ERRORS,
	SlackConfigurationError,
} from "../api.errors";

describe("isPermanentSlackError", () => {
	it("classifies the states only a person can clear", () => {
		// The bot was never invited — the case seen in production.
		expect(isPermanentSlackError("not_in_channel")).toBe(true);
		expect(isPermanentSlackError("channel_not_found")).toBe(true);
		expect(isPermanentSlackError("is_archived")).toBe(true);
		expect(isPermanentSlackError("missing_scope")).toBe(true);
		expect(isPermanentSlackError("token_revoked")).toBe(true);
	});

	it("leaves genuinely transient failures retryable", () => {
		// Retrying these is correct; classifying them as permanent would stop
		// ingestion on a blip and need a human to restart it.
		expect(isPermanentSlackError("ratelimited")).toBe(false);
		expect(isPermanentSlackError("service_unavailable")).toBe(false);
		expect(isPermanentSlackError("internal_error")).toBe(false);
		expect(isPermanentSlackError("fatal_error")).toBe(false);
	});

	it("treats an absent error code as retryable", () => {
		expect(isPermanentSlackError(undefined)).toBe(false);
		expect(isPermanentSlackError("")).toBe(false);
	});
});

describe("SlackConfigurationError", () => {
	it("carries the raw Slack code so a caller can act on it", () => {
		const error = new SlackConfigurationError(
			"not_in_channel",
			"Slack API files.list error: not_in_channel",
		);
		expect(error.slackError).toBe("not_in_channel");
		expect(error.name).toBe("SlackConfigurationError");
		expect(error).toBeInstanceOf(Error);
	});

	it("is catchable as an ordinary Error by existing handlers", () => {
		// Every current catch block treats Slack failures as plain Errors, so
		// narrowing the thrown type must not change what they see.
		const error: unknown = new SlackConfigurationError(
			"is_archived",
			"gone",
		);
		expect(error instanceof Error).toBe(true);
	});

	it("every permanent code is a non-empty string", () => {
		for (const code of PERMANENT_SLACK_ERRORS) {
			expect(typeof code).toBe("string");
			expect(code.length).toBeGreaterThan(0);
		}
	});
});
