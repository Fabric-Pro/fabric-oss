import { describe, expect, it } from "vitest";
import {
	describeImageFailure,
	describeImageRefusal,
	describeReviewFailure,
	describeReviewSuccess,
} from "./newsletter-review-feedback";

/** Shaped like a thrown oRPC client error: an Error carrying a string `code`. */
class OrpcErrorLike extends Error {
	code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

describe("describeReviewSuccess", () => {
	it("a fresh approval reads as a send in progress", () => {
		expect(
			describeReviewSuccess("approve", {
				outcome: "approved",
				notice: null,
			}),
		).toEqual({
			level: "success",
			message: "Newsletter approved — sending",
			refresh: true,
		});
	});

	it("a fresh rejection reads as a rejection", () => {
		expect(
			describeReviewSuccess("reject", {
				outcome: "rejected",
				notice: null,
			}),
		).toEqual({
			level: "success",
			message: "Newsletter rejected",
			refresh: true,
		});
	});

	it("an already-resolved outcome is INFO carrying the server's explanation, never 'sending'", () => {
		// Nothing was dispatched just now, so the green "sending" copy would be a
		// lie — this is the row having already reached the requested state.
		const feedback = describeReviewSuccess("approve", {
			outcome: "already_resolved",
			notice: "This newsletter has already been sent.",
		});
		expect(feedback).toEqual({
			level: "info",
			message: "This newsletter has already been sent.",
			refresh: true,
		});
	});

	it("falls back to per-action copy when the server sent no notice", () => {
		expect(
			describeReviewSuccess("approve", { outcome: "already_resolved" })
				.message,
		).toMatch(/already approved/i);
		expect(
			describeReviewSuccess("reject", { outcome: "already_resolved" })
				.message,
		).toMatch(/already rejected/i);
	});

	it("tolerates a response with no outcome field at all", () => {
		// Defensive: a client running against an older deployment sees the
		// pre-#2172 shape. Treat it as the fresh path rather than throwing.
		expect(describeReviewSuccess("approve", {})).toEqual({
			level: "success",
			message: "Newsletter approved — sending",
			refresh: true,
		});
	});
});

describe("describeReviewFailure", () => {
	it("a CONFLICT is an informational notice that refreshes the list, not a red failure (AC1/AC2)", () => {
		const feedback = describeReviewFailure(
			"approve",
			new OrpcErrorLike(
				"CONFLICT",
				"This newsletter was already rejected, so it can no longer be approved.",
			),
		);
		expect(feedback).toEqual({
			level: "info",
			message:
				"This newsletter was already rejected, so it can no longer be approved.",
			refresh: true,
		});
		// The banner this card exists to remove.
		expect(feedback.message).not.toMatch(/^Failed to approve/);
	});

	it("a CONFLICT with no message still explains something and refreshes", () => {
		const feedback = describeReviewFailure(
			"reject",
			new OrpcErrorLike("CONFLICT", ""),
		);
		expect(feedback.level).toBe("info");
		expect(feedback.message.length).toBeGreaterThan(0);
		expect(feedback.refresh).toBe(true);
	});

	it("a genuine failure stays a red error and does NOT refresh the list", () => {
		// Refetching on a server error would swap the reviewer's draft out from
		// under them for no reason — the row is still theirs to decide.
		const feedback = describeReviewFailure(
			"approve",
			new OrpcErrorLike("INTERNAL_SERVER_ERROR", "Failed to start send"),
		);
		expect(feedback).toEqual({
			level: "error",
			message: "Failed to approve: Failed to start send",
			refresh: false,
		});
	});

	it("prefixes the reject path with its own verb", () => {
		expect(
			describeReviewFailure(
				"reject",
				new OrpcErrorLike("FORBIDDEN", "Nope"),
			).message,
		).toBe("Failed to reject: Nope");
	});

	it("a non-oRPC throw (network, TypeError) is still reported as a failure", () => {
		const feedback = describeReviewFailure(
			"approve",
			new Error("Failed to fetch"),
		);
		expect(feedback.level).toBe("error");
		expect(feedback.refresh).toBe(false);
		expect(feedback.message).toBe("Failed to approve: Failed to fetch");
	});

	it("a thrown non-Error value does not produce an empty toast", () => {
		const feedback = describeReviewFailure("approve", "boom");
		expect(feedback.level).toBe("error");
		expect(feedback.message).toMatch(/Failed to approve/);
	});
});

/** An oRPC client error that also carries the server's `data`. */
class OrpcErrorWithData extends OrpcErrorLike {
	data: unknown;
	constructor(code: string, message: string, data: unknown) {
		super(code, message);
		this.data = data;
	}
}

describe("describeImageFailure", () => {
	it("a CONFLICT is the neutral no-longer-awaiting-review notice and refreshes", () => {
		const message =
			"This newsletter is no longer awaiting review, so its images can no longer be changed.";
		expect(
			describeImageFailure(new OrpcErrorLike("CONFLICT", message)),
		).toEqual({ level: "info", message, refresh: true });
	});

	it("a capture still running is a CONFLICT that keeps the panel open", () => {
		expect(
			describeImageFailure(
				new OrpcErrorWithData("CONFLICT", "server copy", {
					code: "capture_in_progress",
				}),
			),
		).toEqual({
			level: "error",
			message: "This screenshot is already being captured.",
			refresh: false,
		});
	});

	it("a CONFLICT without a message falls back to the generic notice", () => {
		expect(
			describeImageFailure(new OrpcErrorLike("CONFLICT", "")).message,
		).toBe("This newsletter is no longer awaiting review.");
	});

	it.each([
		{
			code: "too_large",
			message:
				"That image is too large even after shrinking. Try a smaller one.",
		},
		{ code: "unsupported", message: "Use a PNG or JPEG image." },
		{
			code: "highlight_full",
			message: "This highlight already has two images.",
		},
		{
			code: "no_capture_environment",
			message:
				"Choose an environment to capture from in the release notes settings first.",
		},
		{
			code: "capture_limit",
			message:
				"This newsletter has reached its limit of screenshot captures. Upload an image instead.",
		},
	])("BAD_REQUEST $code explains the refusal", ({ code, message }) => {
		expect(
			describeImageFailure(
				new OrpcErrorWithData("BAD_REQUEST", "server copy", { code }),
			),
		).toEqual({ level: "error", message, refresh: false });
	});

	it.each([
		{
			name: "an unknown data code",
			error: new OrpcErrorWithData("BAD_REQUEST", "x", { code: "nope" }),
		},
		{
			name: "a server error",
			error: new OrpcErrorLike("INTERNAL_SERVER_ERROR", "x"),
		},
		{ name: "a network failure", error: new Error("Failed to fetch") },
		{ name: "a thrown string", error: "boom" },
	])("$name gets the generic retry copy", ({ error }) => {
		expect(describeImageFailure(error)).toEqual({
			level: "error",
			message: "Could not save the image. Try again.",
			refresh: false,
		});
	});
});

describe("describeImageRefusal", () => {
	it("uses the same copy as the server's refusal codes", () => {
		expect(describeImageRefusal("unsupported")).toBe(
			"Use a PNG or JPEG image.",
		);
	});
});
