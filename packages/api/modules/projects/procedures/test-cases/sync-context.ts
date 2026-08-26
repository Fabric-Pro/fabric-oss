/**
 * Shared call-site for the Test Case → ProjectContext RAG mirror (AC7).
 *
 * Maps a freshly-persisted `TestCaseDetail` (the query layer's full select) into
 * the plain-text body `buildTestCaseContextContent` embeds, then hands it to
 * `syncTestCaseContext`. Used by create / update / clone / ai-draft so the
 * mapping lives in one place. Best-effort by construction — `syncTestCaseContext`
 * never throws — so a failure here never blocks the write it accompanies.
 *
 * This file declares no procedure (no `.handler`); it is a pure wiring helper.
 */

import type { TestCaseDetail } from "@repo/database";
import {
	buildTestCaseContextContent,
	syncTestCaseContext,
} from "../../lib/test-case-context";

/**
 * Mirror a persisted test case into its ProjectContext row and (re)embed it.
 * Awaited (like the ADL `syncAndNotify` mirror) so the ProjectContext row +
 * `contextId` back-link are durable before the response returns; the heavy
 * embedding itself is started fire-and-forget inside `syncTestCaseContext`.
 */
export async function mirrorTestCaseToContext(
	detail: TestCaseDetail,
	ctx: { userId: string; organizationId?: string | null },
): Promise<void> {
	const content = buildTestCaseContextContent({
		identifier: detail.identifier,
		title: detail.title,
		state: detail.state,
		priority: detail.priority,
		preconditions: detail.description,
		steps: detail.steps.map((s) => ({
			action: s.action,
			expected: s.expected,
		})),
		linkedFeatures: detail.workItemLinks.map((link) => ({
			identifier: link.userStory.identifier,
			title: link.userStory.title,
			acceptanceCriterionRefs: link.acceptanceCriterionRefs,
		})),
		tags: detail.tags,
	});

	await syncTestCaseContext({
		testCaseId: detail.id,
		projectId: detail.projectId,
		contextId: detail.contextId,
		content,
		sourceTitle: `${detail.identifier} ${detail.title}`.trim(),
		userId: ctx.userId,
		organizationId: ctx.organizationId,
	});
}
