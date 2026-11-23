/**
 * PARLUME_JOIN_FAILED and PARLUME_WAITING_IN_LOBBY are written by
 * `parlume-notices.ts` through `createNotification`, which validates them
 * here: a shape the writer emits that this rejects would drop the notice.
 */
import { NotificationType } from "@repo/database";
import { describe, expect, it } from "vitest";
import { validatePayload } from "../payloads";

describe("Parlume notice payload schemas", () => {
	it("accepts a join failure the way the writer emits it", () => {
		const payload = {
			sessionId: "session-1",
			projectId: "project-1",
			trigger: "AUTO",
			endReason: "NOT_ADMITTED",
		};

		expect(
			validatePayload(NotificationType.PARLUME_JOIN_FAILED, payload),
		).toEqual(payload);
	});

	it("rejects a join failure for an end reason that is not one", () => {
		expect(() =>
			validatePayload(NotificationType.PARLUME_JOIN_FAILED, {
				sessionId: "session-1",
				projectId: "project-1",
				trigger: "MANUAL",
				endReason: "STOPPED",
			}),
		).toThrow();
	});

	it("accepts a lobby notice the way the writer emits it", () => {
		const payload = {
			sessionId: "session-1",
			projectId: "project-1",
			trigger: "MANUAL",
			admitBy: "14:10 UTC",
		};

		expect(
			validatePayload(NotificationType.PARLUME_WAITING_IN_LOBBY, payload),
		).toEqual(payload);
	});
});
