/**
 * Verifies the Zod schema for the STORY_SHARED notification type accepts the
 * exact payload shape `fanOut.storyShared` emits and rejects malformed inputs.
 * Keep in lock-step with `fanOut.storyShared` in
 * packages/api/lib/notification-service.ts.
 */

import { NotificationType } from "@repo/database";
import { describe, expect, it } from "vitest";
import { validatePayload } from "../payloads";

const VALID = {
	storyId: "story-1",
	projectId: "proj-1",
	sharedByUserId: "user-1",
	message: "Take a look when you get a chance",
} as const;

describe("STORY_SHARED payload schema", () => {
	it("accepts the emitted shape with a message", () => {
		expect(
			validatePayload(NotificationType.STORY_SHARED, VALID),
		).toMatchObject(VALID);
	});

	it("accepts the shape without a message (optional)", () => {
		const { message: _omit, ...noMessage } = VALID;
		expect(
			validatePayload(NotificationType.STORY_SHARED, noMessage),
		).toMatchObject(noMessage);
	});

	it("rejects payloads missing required fields", () => {
		const { storyId: _omit, ...partial } = VALID;
		expect(() =>
			validatePayload(
				NotificationType.STORY_SHARED,
				partial as typeof VALID,
			),
		).toThrow();
	});

	it("enforces the 280-char message cap", () => {
		expect(() =>
			validatePayload(NotificationType.STORY_SHARED, {
				...VALID,
				message: "x".repeat(281),
			}),
		).toThrow();
	});
});
