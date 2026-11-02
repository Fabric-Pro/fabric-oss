/**
 * When an activity gives up, the workflow receives an `ActivityFailure` whose
 * message is the generic "Activity task failed", and the OpenTelemetry
 * interceptor records only that. Telemetry therefore could not say which
 * activity failed or why (Fizzy #3461). This interceptor logs both.
 *
 * It sits on the promise of every activity in every workflow, so these cases
 * also pin what it must never do: change what the workflow receives.
 */

import {
	ActivityFailure,
	ApplicationFailure,
	CancelledFailure,
	RetryState,
	TimeoutFailure,
	TimeoutType,
} from "@temporalio/common";
import type { ActivityInput } from "@temporalio/workflow";
import { beforeEach, describe, expect, it, vi } from "vitest";

const logError = vi.fn();

vi.mock("@temporalio/workflow", async (importOriginal) => ({
	...(await importOriginal<typeof import("@temporalio/workflow")>()),
	log: { error: (...args: unknown[]) => logError(...args) },
}));

import { interceptors } from "../activity-failure-workflow-interceptor";

const INPUT = { activityType: "generateDocument" } as ActivityInput;

function failure(cause: Error) {
	return new ActivityFailure(
		"Activity task failed",
		"generateDocument",
		"7",
		RetryState.MAXIMUM_ATTEMPTS_REACHED,
		"worker@host",
		cause,
	);
}

async function run(outcome: Promise<unknown>) {
	const [outbound] = interceptors().outbound ?? [];
	const result = outbound?.scheduleActivity?.(INPUT, () => outcome);
	await result?.catch(() => undefined);
	await Promise.resolve();
	// Boxed: an async function would otherwise unwrap the promise under test.
	return { result };
}

beforeEach(() => {
	logError.mockReset();
});

describe("activity failure interceptor", () => {
	it("names the activity and the application error behind the wrapper", async () => {
		const cause = ApplicationFailure.create({
			message: "schema did not parse",
			type: "SchemaParseError",
		});

		await run(Promise.reject(failure(cause)));

		expect(logError).toHaveBeenCalledTimes(1);
		const [message, attributes] = logError.mock.calls[0] ?? [];
		expect(message).toBe(
			"Activity generateDocument failed: SchemaParseError",
		);
		expect(attributes).toMatchObject({
			activityType: "generateDocument",
			retryState: RetryState.MAXIMUM_ATTEMPTS_REACHED,
			causeType: "SchemaParseError",
			detail: "schema did not parse",
		});
	});

	it("names the timeout that ended the activity", async () => {
		const cause = new TimeoutFailure(
			"Activity task timed out",
			undefined,
			TimeoutType.START_TO_CLOSE,
		);

		await run(Promise.reject(failure(cause)));

		expect(logError.mock.calls[0]?.[0]).toBe(
			"Activity generateDocument failed: TimeoutFailure START_TO_CLOSE",
		);
	});

	it("bounds the detail it logs", async () => {
		const cause = new Error("x".repeat(5000));

		await run(Promise.reject(failure(cause)));

		const attributes = logError.mock.calls[0]?.[1] as { detail: string };
		expect(attributes.detail.length).toBeLessThanOrEqual(500);
	});

	it("stays quiet about an activity that was cancelled", async () => {
		await run(Promise.reject(failure(new CancelledFailure("cancelled"))));

		expect(logError).not.toHaveBeenCalled();
	});

	it("stays quiet about an error that is not an activity failure", async () => {
		await run(Promise.reject(new Error("not from an activity")));

		expect(logError).not.toHaveBeenCalled();
	});

	it("stays quiet when the activity succeeds", async () => {
		await run(Promise.resolve("done"));

		expect(logError).not.toHaveBeenCalled();
	});

	it("hands the workflow the very promise it was given", async () => {
		const outcome = Promise.resolve("done");

		const { result } = await run(outcome);

		expect(result).toBe(outcome);
	});

	it("leaves the failure for the workflow to handle", async () => {
		const error = failure(new Error("boom"));
		const outcome = Promise.reject(error);

		const { result } = await run(outcome);

		await expect(result).rejects.toBe(error);
	});

	it("never lets logging fail the workflow", async () => {
		logError.mockImplementation(() => {
			throw new Error("sink unavailable");
		});
		const unhandled = vi.fn();
		process.on("unhandledRejection", unhandled);

		await run(Promise.reject(failure(new Error("boom"))));
		await new Promise((resolve) => setTimeout(resolve, 0));

		process.off("unhandledRejection", unhandled);
		expect(unhandled).not.toHaveBeenCalled();
	});
});
