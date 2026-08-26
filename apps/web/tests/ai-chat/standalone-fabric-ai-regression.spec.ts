/**
 * E2E: standalone Fabric AI regression (I.9).
 *
 * Spec: 2026-05-19-ai-assistant-document-chat-history §1.3, §3.1 FR-6,
 * §9.5, AC-12; Risk R10.
 *
 * The document-assistant history work is additive. The standalone
 * Fabric AI page (`ChatHistorySidebar.tsx` surface) MUST be unaffected:
 * its existing `AgentConversation` row creation flow is unchanged, AND
 * no new `DocumentAssistantConversation` row is created when a user
 * chats on that page (the new join table is for the in-document
 * sidebar only — spec §1.3).
 *
 * The boundaries we exercise:
 *
 *   1. Open `/app/agents/fabric-ai` (the standalone surface) as an
 *      authenticated user.
 *   2. Create a fresh conversation via the same oRPC procedure the
 *      page's "New thread" button calls
 *      (`agents.conversations.create`).
 *   3. Confirm via a direct Prisma query that:
 *        a. An `AgentConversation` row exists with the captured id.
 *        b. ZERO `DocumentAssistantConversation` rows reference that
 *           conversationId — proves the standalone surface did NOT
 *           write a join row (Risk R10 — additivity).
 *
 * We use the API for conversation create (not the UI's "New thread"
 * button) because the regression under test is the persistence shape,
 * NOT the button binding — that's covered by FabricAIClient's unit
 * harness. Using the API gives us a deterministic id to query for.
 *
 * Skip-gate: needs `TEST_DATABASE_URL` for the direct-DB assertion.
 * The `E2E_USER_*` env vars from the global auth setup cover sign-in.
 */

import { expect, test } from "@playwright/test";
import { getDirectPrismaClient } from "../document-assistant-history/_fixtures";

test.setTimeout(120_000);

const haveDirectDb = !!process.env.TEST_DATABASE_URL;

test.describe("standalone Fabric AI — regression (AC-12)", () => {
	test.skip(
		!haveDirectDb,
		"Set TEST_DATABASE_URL to run the cascade-boundary assertion — see document-assistant-history/_fixtures.ts.",
	);

	const createdConversationIds: string[] = [];

	test.afterAll(async () => {
		// Best-effort cleanup. We delete via the same procedure the
		// page's kebab menu wires up so the audit trail matches a
		// real user delete.
		if (createdConversationIds.length === 0) {
			return;
		}
		const prisma = await getDirectPrismaClient();
		try {
			await prisma.agentConversation.deleteMany({
				where: { id: { in: createdConversationIds } },
			});
		} catch {
			// Ignore — these rows might already be gone if a test
			// run interrupted itself. The dev DB is shared, so a
			// leftover row is harmless.
		} finally {
			await prisma.$disconnect().catch(() => undefined);
		}
	});

	test("new thread persists to AgentConversation only — no DocumentAssistantConversation row created", async ({
		page,
		request,
	}) => {
		if (!haveDirectDb) {
			test.skip();
			return;
		}

		// ----------------------------------------------------------
		// 1. Confirm the standalone page mounts. The route is
		//    `/app/agents/fabric-ai` per `app/(saas)/app/agents/
		//    fabric-ai/FabricAIClient.tsx`. We don't need to
		//    click into the UI — the page render is just a
		//    sanity that the session is alive AND that the
		//    additive work didn't break the existing route.
		// ----------------------------------------------------------
		await page.goto("/app/agents/fabric-ai");
		await page.waitForLoadState("domcontentloaded");
		// The standalone sidebar's "Threads" heading is the
		// stable identifier for the surface (see
		// ChatHistorySidebar.tsx line 76).
		await expect(
			page.getByRole("heading", { name: /threads/i }),
		).toBeVisible({ timeout: 30_000 });

		// ----------------------------------------------------------
		// 2. Create a conversation via the same procedure the
		//    "New thread" button calls
		//    (`agents.conversations.create`). The id we get
		//    back is the AgentConversation primary key.
		// ----------------------------------------------------------
		const createResp = await request.post(
			"/api/rpc/agents/conversations/create",
			{
				headers: { "Content-Type": "application/json" },
				data: {
					json: {
						organizationId: null,
						// Canonical RegisteredAgent.agentId. Legacy
						// "fabric-ai" alias was removed in the cleanup
						// PR; this spec must use the seeded id so the
						// catalog validation in conversations.create
						// (round-2 PR #1236) accepts the request.
						agentId: "fabric-workspace-assistant",
						title: `E2E I.9 regression ${Date.now()}`,
					},
				},
			},
		);
		expect(
			createResp.ok(),
			`create-conversation failed: ${createResp.status()} ${await createResp.text()}`,
		).toBe(true);
		const createBody = (await createResp.json()) as {
			json?: { id?: string };
		};
		const conversationId = createBody.json?.id;
		expect(conversationId).toBeTruthy();
		if (!conversationId) {
			throw new Error("regression: no conversationId returned");
		}
		createdConversationIds.push(conversationId);

		// ----------------------------------------------------------
		// 3. Direct DB assertions. Two-pronged:
		//    a. AgentConversation row exists — proves the legacy
		//       persistence shape still lands.
		//    b. ZERO DocumentAssistantConversation rows — proves
		//       the new join table is NOT written for the
		//       standalone surface (Risk R10: additivity).
		// ----------------------------------------------------------
		const prisma = await getDirectPrismaClient();
		try {
			const agentRow = await prisma.agentConversation.findUnique({
				where: { id: conversationId },
			});
			expect(
				agentRow,
				"AgentConversation row must exist after the create call (regression for the standalone surface).",
			).toBeTruthy();

			const joinRows = await prisma.documentAssistantConversation.count({
				where: { conversationId },
			});
			expect(
				joinRows,
				"DocumentAssistantConversation MUST NOT be written for the standalone Fabric AI surface (spec §1.3, Risk R10).",
			).toBe(0);
		} finally {
			await prisma.$disconnect().catch(() => undefined);
		}
	});
});
