import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The LinkedIn Post failure marker (Fizzy #1988, follow-up 2).
 *
 * Two properties: the write is scoped by `projectId` as well as by id, and a
 * REFUSED write is a normal outcome rather than an error — the refusal reports a
 * condition the database checked, not a fault in the marker. Throwing on one would
 * make Temporal retry the write; if every attempt were refused, the exhausted
 * proxy would reject into the workflow's last-resort catch, which logs an error
 * that the draft could not be marked failed.
 */

const failTopicDraft = vi.fn();
const logDraftRefusal = vi.fn();
vi.mock("@repo/database", () => ({
	failTopicDraft: (...a: unknown[]) => failTopicDraft(...a),
	logDraftRefusal: (...a: unknown[]) => logDraftRefusal(...a),
}));

import { markLinkedInPostFailedActivity } from "../mark-linkedin-post-failed";

const run = () =>
	markLinkedInPostFailedActivity({
		draftId: "draft-1",
		projectId: "proj-1",
		message: "model timeout",
	});

beforeEach(() => {
	vi.clearAllMocks();
	failTopicDraft.mockResolvedValue({ persisted: true });
});

describe("markLinkedInPostFailedActivity", () => {
	it("scopes the compare-and-set by projectId as well as by id", async () => {
		await run();
		expect(failTopicDraft).toHaveBeenCalledWith({
			id: "draft-1",
			projectId: "proj-1",
			error: "model timeout",
		});
	});

	it("logs nothing when the marker actually landed", async () => {
		await run();
		expect(logDraftRefusal).not.toHaveBeenCalled();
	});

	it("does not throw when the attempt was already terminal", async () => {
		failTopicDraft.mockResolvedValue({
			persisted: false,
			reason: "superseded",
		});
		await expect(run()).resolves.toBeUndefined();
	});

	it("reports WHICH fence refused, not just that one did", async () => {
		failTopicDraft.mockResolvedValue({
			persisted: false,
			reason: "project_ineligible",
		});
		await run();
		expect(logDraftRefusal).toHaveBeenCalledWith(
			expect.stringContaining("publishing-linkedin-post"),
			"project_ineligible",
			{ draftId: "draft-1", projectId: "proj-1" },
		);
	});
});
