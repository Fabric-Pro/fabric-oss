/**
 * Verifies the Zod schema for PM_ATTACHMENT_SYNC_FAILED accepts the exact
 * payload shape the helper emits (Fizzy #1745, AC-4).
 *
 * Keep in lock-step with
 * packages/database/prisma/queries/pm-attachment-notifications.ts — that
 * helper writes the row directly (a Temporal activity cannot import this
 * validator without a workspace cycle), so this test is what keeps the two
 * shapes from drifting apart unnoticed.
 */

import { NotificationType } from "@repo/database";
import { describe, expect, it } from "vitest";
import { validatePayload } from "../payloads";

// The exact shape emitted by createPmAttachmentSyncFailedNotification.
const VALID = {
	projectId: "proj-1",
	storyId: "story-1",
	storyTitle: "Add login",
	pmToolLabel: "GitLab",
	failureSummary:
		"1 of 2 attachments failed to upload: spec.pdf (GitLab upload failed for spec.pdf: the configured GitLab token lacks the 'api' scope required to upload files (HTTP 403))",
} as const;

describe("PM_ATTACHMENT_SYNC_FAILED payload schema", () => {
	it("accepts the helper's emitted shape", () => {
		expect(
			validatePayload(NotificationType.PM_ATTACHMENT_SYNC_FAILED, VALID),
		).toMatchObject(VALID);
	});

	it("rejects a payload with no failure summary — the snippet would say nothing", () => {
		const withoutSummary: Record<string, unknown> = { ...VALID };
		delete withoutSummary.failureSummary;
		expect(() =>
			validatePayload(
				NotificationType.PM_ATTACHMENT_SYNC_FAILED,
				withoutSummary,
			),
		).toThrow();
	});

	it("rejects a payload with no storyId — the inbox row could not link anywhere", () => {
		const withoutStory: Record<string, unknown> = { ...VALID };
		delete withoutStory.storyId;
		expect(() =>
			validatePayload(
				NotificationType.PM_ATTACHMENT_SYNC_FAILED,
				withoutStory,
			),
		).toThrow();
	});
});
