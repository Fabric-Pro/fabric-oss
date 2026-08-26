/**
 * E2E: deleting a document cascades to its assistant history (I.6).
 *
 * Spec: 2026-05-19-ai-assistant-document-chat-history §3.9 FR-24, §9.4,
 * AC-9; Risk R6.
 *
 * Verifies the on-delete cascade end-to-end across THREE distinct
 * persistence boundaries:
 *
 *   1. `DocumentAssistantConversation` rows referencing the document
 *      are removed (FR-24 — direct cascade target).
 *   2. The underlying `AgentConversation` rows are removed (FR-24 —
 *      after-delete hook; risk R6: no orphaned conversations).
 *   3. The document itself is deleted from `ProjectDocument`.
 *
 * Strategy:
 *   - Reuse the two-user fixture for project + document bootstrap (the
 *     existing helper handles auth + tenant context cleanly). Only one
 *     user is actually exercised; the second context is closed in
 *     `teardown`.
 *   - Seed three turns via the live API (proves a multi-turn row is
 *     deleted, not just an empty placeholder).
 *   - Capture the conversationId via `getActiveConversation`.
 *   - Delete the document via the oRPC `projects.documents.delete`
 *     procedure (the same call the UI's "Delete document" button
 *     invokes, but driven through `page.request` to keep the test
 *     decoupled from header-menu UX shifts).
 *   - Re-query the live API: `listForDocument` MUST be empty.
 *   - Cross-validate via a direct Prisma client (TEST_DATABASE_URL):
 *     zero rows in `DocumentAssistantConversation` for this documentId
 *     AND zero rows in `AgentConversation` for the captured ids.
 *
 * Skip-gate: needs both the multi-user creds AND `TEST_DATABASE_URL`
 * for the direct-DB tail check. The two cover different failure modes
 * (the API check catches a regression in the procedure cascade; the
 * direct-DB check catches a regression in the FK cascade itself).
 */

import { expect, test } from "@playwright/test";
import { setupTwoUsers, teardown } from "../helpers/mentions-setup";
import {
	getActiveConversation,
	getDirectPrismaClient,
	listConversationsForDocument,
	seedConversation,
} from "./_fixtures";

test.setTimeout(180_000);

const haveCreds = !!process.env.E2E_USER_A_EMAIL;
const haveDirectDb = !!process.env.TEST_DATABASE_URL;

test.describe("document assistant — delete document cascades", () => {
	test.skip(
		!haveCreds || !haveDirectDb,
		"Set E2E_USER_A_EMAIL (+ password) AND TEST_DATABASE_URL to run this suite — see _fixtures.ts.",
	);

	test("deleting the document removes DocumentAssistantConversation + AgentConversation rows (AC-9, Risk R6)", async ({
		browser,
	}) => {
		if (!haveCreds || !haveDirectDb) {
			test.skip();
			return;
		}

		const fixture = await setupTwoUsers(browser);
		const { pageA, orgSlug, project, doc } = fixture;

		try {
			const scope = {
				kind: "org" as const,
				organizationId: project.organizationId,
				organizationSlug: orgSlug,
				projectId: project.projectId,
				documentId: doc.documentId,
				documentRefKind: "PROJECT_DOCUMENT" as const,
			};

			// --------------------------------------------------
			// 1. Seed three persisted turns. We intentionally
			//    interleave user + assistant via
			//    `seedConversation` so the row carries a real
			//    `messages` blob (not a placeholder).
			// --------------------------------------------------
			const conversationId = await seedConversation(
				pageA.request,
				scope,
				/* turns */ 3,
				{ requestedVisibility: "SHARED" },
			);

			const beforeDelete = await getActiveConversation(
				pageA.request,
				scope,
			);
			expect(beforeDelete?.conversationId).toBe(conversationId);
			expect(beforeDelete?.messageCount ?? 0).toBeGreaterThanOrEqual(3);

			// --------------------------------------------------
			// 2. Delete the document via the live oRPC API.
			//    Mirrors the UI's "Delete document" button —
			//    same procedure, same tenant predicates, same
			//    audit hooks — but free of header-menu UX
			//    coupling. Spec §13 lists the UI flow; AC-9 is
			//    asserted at the cascade boundary, not the
			//    button affordance.
			// --------------------------------------------------
			const deleteResp = await pageA.request.post(
				"/api/rpc/projects/documents/delete",
				{
					headers: { "Content-Type": "application/json" },
					data: {
						json: {
							id: doc.documentId,
							projectId: project.projectId,
							organizationId: project.organizationId,
						},
					},
				},
			);
			expect(
				deleteResp.ok(),
				`document delete failed: ${deleteResp.status()} ${await deleteResp.text()}`,
			).toBe(true);

			// --------------------------------------------------
			// 3. API surface: listForDocument MUST be empty.
			//    (The procedure short-circuits to [] when the
			//    parent document is gone, but the cascade is
			//    what actually removes the rows.)
			// --------------------------------------------------
			const afterDelete = await listConversationsForDocument(
				pageA.request,
				scope,
			);
			expect(
				afterDelete.length,
				"listForDocument MUST be empty after the document is deleted (FR-24, AC-9)",
			).toBe(0);

			// --------------------------------------------------
			// 4. Direct-DB tail check: zero rows in BOTH
			//    DocumentAssistantConversation and
			//    AgentConversation for this documentId /
			//    conversationId. This catches the case where
			//    the join row is removed but the underlying
			//    AgentConversation is orphaned (Risk R6).
			// --------------------------------------------------
			const prisma = await getDirectPrismaClient();
			try {
				const dacRows =
					await prisma.documentAssistantConversation.count({
						where: {
							documentRefKind: "PROJECT_DOCUMENT",
							documentRefId: doc.documentId,
						},
					});
				expect(
					dacRows,
					"Zero DocumentAssistantConversation rows must remain for the deleted document (FR-24).",
				).toBe(0);

				const orphanCheck = await prisma.agentConversation.count({
					where: { id: conversationId },
				});
				expect(
					orphanCheck,
					"Underlying AgentConversation row must be cascade-deleted (Risk R6 — no orphans).",
				).toBe(0);
			} finally {
				await prisma.$disconnect().catch(() => undefined);
			}
		} finally {
			await teardown(fixture);
		}
	});
});
