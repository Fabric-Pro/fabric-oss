import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Newsletter Blurb failure marker (Fizzy #1988, Phase 2D slice 2D-2).
 *
 * A separate activity from the generator on purpose: the generator commits its
 * own success, but by definition it cannot be trusted to record its own failure
 * — the reason it failed may be the very thing that stops it writing.
 *
 * Two properties, and the second is the one a copy gets wrong: the write is
 * scoped by `projectId` as well as by id, and a REFUSED write is a normal
 * outcome rather than an error. Throwing on a refusal would make the workflow's
 * last-resort catch fire and report a crash where there was only a race the
 * database already settled.
 */

const failTopicDraft = vi.fn();
const logDraftRefusal = vi.fn();
vi.mock("@repo/database", () => ({
	failTopicDraft: (...a: unknown[]) => failTopicDraft(...a),
	logDraftRefusal: (...a: unknown[]) => logDraftRefusal(...a),
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { markNewsletterBlurbFailedActivity } from "../mark-newsletter-blurb-failed";

const run = () =>
	markNewsletterBlurbFailedActivity({
		draftId: "draft-1",
		projectId: "proj-1",
		message: "model timeout",
	});

beforeEach(() => {
	vi.clearAllMocks();
	failTopicDraft.mockResolvedValue({ persisted: true });
});

describe("markNewsletterBlurbFailedActivity", () => {
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
		// A deadline sweep reclaimed the attempt while the model ran, so the
		// CAS refuses. That is a normal outcome, not an error.
		failTopicDraft.mockResolvedValue({
			persisted: false,
			reason: "superseded",
		});

		await expect(run()).resolves.toBeUndefined();
	});

	it("reports WHICH fence refused, not just that one did", async () => {
		// A superseded attempt is routine; an archived project is somebody's
		// action. Reporting the same word for both sends an operator looking
		// for a newer attempt that does not exist.
		failTopicDraft.mockResolvedValue({
			persisted: false,
			reason: "project_ineligible",
		});

		await run();

		expect(logDraftRefusal).toHaveBeenCalledWith(
			expect.stringContaining("publishing-newsletter-blurb"),
			"project_ineligible",
			{ draftId: "draft-1", projectId: "proj-1" },
		);
	});
});
