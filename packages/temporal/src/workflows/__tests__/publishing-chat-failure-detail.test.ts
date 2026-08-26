// The SAME specifier the helper imports from, so `instanceof` compares the
// classes production compares. `@temporalio/common` exports the same names and
// would be the natural reach; keeping both sides on one specifier removes the
// question rather than answering it per package manager.
import {
	ActivityFailure,
	ApplicationFailure,
	TimeoutFailure,
} from "@temporalio/workflow";
import { describe, expect, it } from "vitest";
import { publishingChatFailureDetail } from "../publishing-chat-failure-detail";

/**
 * The shape Temporal hands a workflow when an activity times out: an
 * `ActivityFailure` whose `cause` carries the timeout type and the last
 * heartbeat payload.
 *
 * Built against the real constructor rather than a plausible one —
 * `(message, activityType, activityId, retryState, identity, cause?)`, six
 * parameters with `cause` LAST. An earlier version of this file passed seven
 * arguments with `cause` in seventh place; the extra argument was ignored, the
 * failure came out with no cause at all, and the helper correctly returned `{}`
 * for what looked like a genuine timeout. A fixture that misbuilds its subject
 * fails in the direction that looks like a bug in the code under test.
 */
function activityTimeout(
	lastHeartbeatDetails: unknown,
	timeoutType: "START_TO_CLOSE" | "HEARTBEAT" = "START_TO_CLOSE",
): ActivityFailure {
	return new ActivityFailure(
		"activity task failed",
		"broadcastPublishingTopicsToChat",
		undefined,
		"TIMEOUT",
		undefined,
		new TimeoutFailure(
			"activity timed out",
			lastHeartbeatDetails,
			timeoutType,
		),
	);
}

describe("publishingChatFailureDetail", () => {
	// The case the helper exists for. A timed-out activity is killed before it
	// can emit its own aggregate line, so these fields are the only record of how
	// far the broadcast got.
	it("carries the timeout type and the last heartbeat progress", () => {
		const detail = publishingChatFailureDetail(
			activityTimeout({ done: 7, total: 12 }),
		);
		expect(detail).toEqual({
			timeoutType: "START_TO_CLOSE",
			progress: { done: 7, total: 12 },
		});
	});

	// HEARTBEAT is the timeout the activity's own fix is about: before it beat on
	// every settled target, a healthy fan-out whose slowest provider call
	// outlasted the minute died exactly here. The progress payload is what tells
	// that apart from a genuine stall, so this type must carry it like any other.
	it("carries progress on a heartbeat timeout too", () => {
		expect(
			publishingChatFailureDetail(
				activityTimeout({ done: 2, total: 40 }, "HEARTBEAT"),
			),
		).toEqual({
			timeoutType: "HEARTBEAT",
			progress: { done: 2, total: 40 },
		});
	});

	// A heartbeat may not have landed yet — a run killed before the first target
	// settled. The timeout type must still be reported, because "killed with no
	// progress recorded" and "not a timeout at all" are different findings.
	it("reports the timeout even when no heartbeat landed", () => {
		const detail = publishingChatFailureDetail(activityTimeout(undefined));
		expect(detail).toHaveProperty("timeoutType", "START_TO_CLOSE");
		expect(detail).toHaveProperty("progress", undefined);
	});

	// Everything else already has the activity's own line with real counts on it.
	// Adding an empty progress beside that would put a second, less informative
	// number in an operator's way.
	it("adds nothing for an activity failure that is not a timeout", () => {
		const failure = new ActivityFailure(
			"activity task failed",
			"broadcastPublishingTopicsToChat",
			undefined,
			"NON_RETRYABLE_FAILURE",
			undefined,
			ApplicationFailure.nonRetryable("chat is down"),
		);
		expect(publishingChatFailureDetail(failure)).toEqual({});
	});

	// A bare throw never wrapped by Temporal, and the shapes a future refactor is
	// most likely to hand it by accident.
	it("adds nothing for a plain error or a non-error", () => {
		expect(publishingChatFailureDetail(new Error("boom"))).toEqual({});
		expect(publishingChatFailureDetail("boom")).toEqual({});
		expect(publishingChatFailureDetail(undefined)).toEqual({});
	});
});
