import { describe, expect, it } from "vitest";
import * as activities from "../../src/activities";

describe("worker activity registration", () => {
	it("exposes curateNewsletterFromReleasesActivity on the top-level barrel (worker.ts imports this)", () => {
		expect(typeof activities.curateNewsletterFromReleasesActivity).toBe(
			"function",
		);
	});
	it("still exposes the other scheduled newsletter activities", () => {
		for (const name of [
			"collectGitHubReleasesActivity",
			"curateStakeholderReleaseNotesActivity",
			"finalizeNewsletterSendActivity",
			"loadActiveSubscribersActivity",
			"sendNewsletterEmailsActivity",
			// Fizzy #2203. An unregistered activity type is this branch's own
			// top-named rollout risk — it is the entire justification for the
			// approval-chat retry policy outlasting a rolling deploy — and the
			// workflow test cannot catch it, because that harness supplies its
			// own activities map rather than the worker barrel.
			"sendNewsletterApprovalChatMessagesActivity",
		]) {
			expect(typeof (activities as Record<string, unknown>)[name]).toBe(
				"function",
			);
		}
	});
});
