/**
 * Procedure-layer cascade-on-delete coverage for the
 * DocumentAssistantConversation feature (spec 2026-05-19 §3.9 FR-24,
 * §9.1, AC-9; Risk R6).
 *
 * Group A (`packages/database/__tests__/cascade-document-assistant.test.ts`)
 * proves the **query-layer** cascade: calling `deleteDocument(id)` /
 * `deleteStory(id, projectId)` directly against real Postgres removes every
 * attached `DocumentAssistantConversation` + underlying `AgentConversation`
 * row via the FK cascade.
 *
 * This test proves the **procedure layer** wires up correctly:
 *
 *   1. Invoking `projects.delete` (the existing `deleteDocumentProcedure`)
 *      and `projects.stories.delete` (`deleteStoryProcedure`) triggers the
 *      cascade end-to-end against a live Postgres.
 *   2. The cascade is SILENT — no `document_assistant.conversation.deleted`
 *      audit row is emitted (spec §14 release-notes caveat: the audit trail
 *      removal is documented in release notes, not in the per-conversation
 *      audit log). Per-conversation lifecycle audits only fire when a user
 *      explicitly invokes the document-assistant `delete-for-document`
 *      procedure (covered by Group B's
 *      `archive-delete-rename-for-document.test.ts`).
 *   3. Conversations attached to unrelated documents survive.
 *
 * Real Postgres only — self-skips via `describe.skipIf(!hasReachableDb())`
 * when run without a live DB (matches the canonical
 * `hasReachableDatabaseUrl` helper at
 * `packages/database/__tests__/_helpers/db-availability.ts`; inlined here
 * to keep the api test free of an internal-only import). The predicate
 * rejects both an unset `DATABASE_URL` AND the CI placeholder URL
 * (`postgresql://test:test@localhost:5432/test`) that the unit-tests
 * workflow exports so the Prisma singleton can initialize. The handler is
 * invoked directly (oRPC middleware is stubbed via mocked
 * `tenantProtectedProcedure` chainable, matching the captured-handler
 * pattern used by every other test file in this folder) but
 * `@repo/database` is intentionally NOT mocked so the FK cascade is real.
 *
 * Multi-tenant XOR is exercised by seeding the document under a real
 * Organization row (`organizationId` set, not personal context) so RLS +
 * XOR are actually in play.
 */

import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

// --------------------------------------------------------------------------
// Inline test wiring — separate from `_harness.ts` because we need the
// REAL `@repo/database` (FK cascade depends on real Postgres). The shared
// harness mocks `@repo/database`, which is incompatible here.
// --------------------------------------------------------------------------

const { handlers, recordAuditMock } = vi.hoisted(() => ({
	handlers: {} as Record<
		string,
		(args: { input: unknown; context: unknown }) => Promise<unknown>
	>,
	recordAuditMock: vi.fn(),
}));

let pendingKey = "";
function setPendingHandlerKey(key: string): void {
	pendingKey = key;
}

// Stub external integrations that the delete procedures touch but that
// are unrelated to the cascade behaviour under test. Factory bodies are
// INLINED into every `vi.mock` call below because Vitest hoists each
// `vi.mock` to the top of the file at transform time; a top-level
// `const factory = …` reference inside a hoisted call throws
// "Cannot access … before initialization". The duplication is intentional.
vi.mock("@repo/rag", () => ({
	removeDocumentEmbedding: vi.fn().mockResolvedValue(undefined),
}));

// `lib/realtime` is imported as `../../../lib/realtime` from
// `packages/api/modules/projects/procedures/delete-document.ts` (3 levels
// up). Same on-disk file; both relative forms are registered here because
// Vitest's hoist-time path matching is literal, not normalised.
vi.mock("../../../../../../lib/realtime", () => ({
	emitDocumentChange: vi.fn().mockResolvedValue(undefined),
	emitActivity: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../../lib/realtime", () => ({
	emitDocumentChange: vi.fn().mockResolvedValue(undefined),
	emitActivity: vi.fn().mockResolvedValue(undefined),
}));

// Audit emission needs to be observable so we can assert silence on the
// cascade path. The real implementation writes to the audit_log table
// fire-and-forget; for the assertion in this file we only need to know
// which actions were called with which resource ids, so a vi.fn() is fine.
// `recordAuditMock` is declared via `vi.hoisted` so the reference inside
// each factory is initialised before the hoisted `vi.mock` runs.
vi.mock("../../../../../../lib/audit", () => ({
	recordAuditFromRequest: (...args: unknown[]) => recordAuditMock(...args),
	wireAuditObservability: vi.fn(),
}));
// Path from `packages/api/modules/projects/procedures/stories/delete-story.ts`
// (4 levels deep). Same on-disk file as the path above; Vitest's hoist-time
// path matching is literal so both forms must be registered.
vi.mock("../../../../lib/audit", () => ({
	recordAuditFromRequest: (...args: unknown[]) => recordAuditMock(...args),
	wireAuditObservability: vi.fn(),
}));

// Stub the oRPC chainable so importing the procedure files yields the
// raw handler we can invoke directly. Each factory is inlined for the
// same hoist-safety reason as the audit mocks above. The `handlers` /
// `pendingKey` references are safe because `handlers` is hoisted via
// `vi.hoisted` and `pendingKey` is mutated AFTER the mocks are registered
// (just before each `await import`).
vi.mock("../../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (
			fn: (args: {
				input: unknown;
				context: unknown;
			}) => Promise<unknown>,
		) => {
			handlers[pendingKey] = fn;
			return { _handler: fn };
		},
	});
	return {
		tenantProtectedProcedure: chainable,
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? undefined,
		requirePermission: vi.fn(() => ({})),
		requireProjectPermission: vi.fn(() => ({})),
		Permissions: new Proxy(
			{},
			{ get: (_: unknown, prop: string) => prop.toLowerCase() },
		),
	};
});
vi.mock("../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (
			fn: (args: {
				input: unknown;
				context: unknown;
			}) => Promise<unknown>,
		) => {
			handlers[pendingKey] = fn;
			return { _handler: fn };
		},
	});
	return {
		tenantProtectedProcedure: chainable,
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? undefined,
		requirePermission: vi.fn(() => ({})),
		requireProjectPermission: vi.fn(() => ({})),
		Permissions: new Proxy(
			{},
			{ get: (_: unknown, prop: string) => prop.toLowerCase() },
		),
	};
});
vi.mock("../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (
			fn: (args: {
				input: unknown;
				context: unknown;
			}) => Promise<unknown>,
		) => {
			handlers[pendingKey] = fn;
			return { _handler: fn };
		},
	});
	return {
		tenantProtectedProcedure: chainable,
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? undefined,
		requirePermission: vi.fn(() => ({})),
		requireProjectPermission: vi.fn(() => ({})),
		Permissions: new Proxy(
			{},
			{ get: (_: unknown, prop: string) => prop.toLowerCase() },
		),
	};
});

// Capture the handlers from each procedure file by toggling `pendingKey`
// just before each import.
setPendingHandlerKey("deleteDocument");
await import("../../../../../projects/procedures/delete-document");

setPendingHandlerKey("deleteStory");
await import("../../../../../projects/procedures/stories/delete-story");

// Now we can pull in the real Prisma client and queries — they live
// behind the `@repo/database` package index which was NOT mocked above.
import { createDocumentAssistantConversation } from "@repo/database";
import { db, Prisma } from "@repo/database/prisma/client";

// --------------------------------------------------------------------------
// Test data — unique per-process suffix prevents cross-suite collisions
// when vitest runs files in parallel against the same dev Postgres.
// --------------------------------------------------------------------------
const RUN_ID = `${Date.now()}-${process.pid}`;
const ORG_ID = `test-cascade-proc-org-${RUN_ID}`;
const USER_ID = `test-cascade-proc-user-${RUN_ID}`;

function makeContext(): Record<string, unknown> {
	return {
		user: {
			id: USER_ID,
			email: `${USER_ID}@test.com`,
			name: "Cascade Procedure User",
		},
		session: {
			id: `sess-${RUN_ID}`,
			activeOrganizationId: ORG_ID,
			impersonatedBy: null,
		},
		headers: new Headers(),
	};
}

// Mirror of `packages/database/__tests__/_helpers/db-availability.ts` —
// inlined so this api test does not depend on an internal `__tests__/`
// path of a sibling package. Keep in sync with the canonical helper.
const CI_PLACEHOLDER_DATABASE_URL =
	"postgresql://test:test@localhost:5432/test";
function hasReachableDb(): boolean {
	const url = process.env.DATABASE_URL;
	if (!url) {
		return false;
	}
	if (url === CI_PLACEHOLDER_DATABASE_URL) {
		return false;
	}
	return true;
}

describe.skipIf(!hasReachableDb())(
	"cascade-on-document-delete (procedure layer)",
	() => {
		beforeAll(async () => {
			const now = new Date();
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
				VALUES (${USER_ID}, ${"Cascade Procedure User"}, ${`${USER_ID}@test.com`}, true, false, ${now}, ${now})
				ON CONFLICT (id) DO NOTHING
			`);
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "organization" (id, name, slug, "createdAt")
				VALUES (${ORG_ID}, ${"Cascade Procedure Org"}, ${ORG_ID}, ${now})
				ON CONFLICT (id) DO NOTHING
			`);
			// Membership row so `hasProjectAccess` (and any tenant
			// resolution inside the handler) sees the user as a real org
			// member with write access to org-owned projects.
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "member" ("id", "organizationId", "userId", "role", "createdAt")
				VALUES (${`m-${ORG_ID}-${USER_ID}`}, ${ORG_ID}, ${USER_ID}, ${"owner"}, ${now})
				ON CONFLICT DO NOTHING
			`);
		});

		afterAll(async () => {
			// Tear down everything we seeded (children first to respect FKs).
			await db.documentAssistantConversation.deleteMany({
				where: { userId: USER_ID },
			});
			await db.agentConversation.deleteMany({
				where: { userId: USER_ID },
			});
			await db.userStory.deleteMany({ where: { createdById: USER_ID } });
			await db.projectStoryStatus.deleteMany({
				where: { project: { userId: USER_ID } },
			});
			await db.projectDocument.deleteMany({ where: { userId: USER_ID } });
			await db.project.deleteMany({ where: { userId: USER_ID } });
			await db.$executeRaw(Prisma.sql`
				DELETE FROM "member" WHERE "userId" = ${USER_ID} AND "organizationId" = ${ORG_ID}
			`);
			await db.organization.deleteMany({ where: { id: ORG_ID } });
			await db.user.deleteMany({ where: { id: USER_ID } });
		});

		beforeEach(() => {
			recordAuditMock.mockClear();
		});

		afterEach(async () => {
			// Each test seeds its own project/doc/story; clean up between
			// tests so the unique-id collision guard inside each `it` is
			// the only thing standing between us and false positives.
			await db.documentAssistantConversation.deleteMany({
				where: { userId: USER_ID },
			});
			await db.agentConversation.deleteMany({
				where: { userId: USER_ID },
			});
			await db.userStory.deleteMany({ where: { createdById: USER_ID } });
			await db.projectStoryStatus.deleteMany({
				where: { project: { userId: USER_ID } },
			});
			await db.projectDocument.deleteMany({ where: { userId: USER_ID } });
			await db.project.deleteMany({ where: { userId: USER_ID } });
		});

		async function seedProject(): Promise<{ id: string }> {
			return db.project.create({
				data: {
					name: `Cascade Procedure Project ${RUN_ID}`,
					userId: USER_ID,
					organizationId: ORG_ID,
				},
			});
		}

		async function seedSharedConversation(opts: {
			documentRefKind: "PROJECT_DOCUMENT" | "USER_STORY";
			documentRefId: string;
			projectId: string;
		}): Promise<{ conversationId: string; joinId: string }> {
			// The helper creates both rows atomically. We then layer a 5-turn
			// message history onto the conversation so the spec's "SHARED
			// conversation with 5 turns" seed condition is satisfied — the
			// message content is irrelevant to the cascade contract but pins
			// the join row to the spec's seed shape.
			const { conversation, join } =
				await createDocumentAssistantConversation({
					tenantFilter: { organizationId: ORG_ID, userId: USER_ID },
					documentRefKind: opts.documentRefKind,
					documentRefId: opts.documentRefId,
					projectId: opts.projectId,
					agentId: "document_generator",
					visibility: "SHARED",
				});
			await db.agentConversation.update({
				where: { id: conversation.id },
				data: {
					messages: [
						{ id: "m1", role: "user", content: "hello" },
						{ id: "m2", role: "assistant", content: "hi" },
						{
							id: "m3",
							role: "user",
							content: "rewrite section 1",
						},
						{ id: "m4", role: "assistant", content: "done" },
						{ id: "m5", role: "user", content: "thanks" },
					],
				},
			});
			return { conversationId: conversation.id, joinId: join.id };
		}

		it("cascades and silently removes assistant history when projects.delete fires on a ProjectDocument", async () => {
			const project = await seedProject();
			const doc = await db.projectDocument.create({
				data: {
					projectId: project.id,
					type: "PRD",
					title: "Cascade Procedure Doc",
					content: "body",
					userId: USER_ID,
					organizationId: ORG_ID,
				},
			});

			// Two conversations attached to the doomed document, one
			// unrelated conversation on a sibling document that MUST
			// survive the cascade.
			const attachedA = await seedSharedConversation({
				documentRefKind: "PROJECT_DOCUMENT",
				documentRefId: doc.id,
				projectId: project.id,
			});
			const attachedB = await seedSharedConversation({
				documentRefKind: "PROJECT_DOCUMENT",
				documentRefId: doc.id,
				projectId: project.id,
			});

			const siblingDoc = await db.projectDocument.create({
				data: {
					projectId: project.id,
					type: "PRD",
					title: "Sibling Doc (must survive)",
					content: "body",
					userId: USER_ID,
					organizationId: ORG_ID,
				},
			});
			const unrelated = await seedSharedConversation({
				documentRefKind: "PROJECT_DOCUMENT",
				documentRefId: siblingDoc.id,
				projectId: project.id,
			});

			await handlers.deleteDocument({
				context: makeContext(),
				input: {
					projectId: project.id,
					id: doc.id,
					organizationId: ORG_ID,
				},
			});

			// (1) Zero DocumentAssistantConversation rows for the deleted doc
			const remainingJoins = await db.documentAssistantConversation.count(
				{
					where: {
						documentRefKind: "PROJECT_DOCUMENT",
						documentRefId: doc.id,
					},
				},
			);
			expect(remainingJoins).toBe(0);

			// (2) Zero AgentConversation rows for the cascaded conversation ids
			const remainingConvs = await db.agentConversation.count({
				where: {
					id: {
						in: [
							attachedA.conversationId,
							attachedB.conversationId,
						],
					},
				},
			});
			expect(remainingConvs).toBe(0);

			// (3) NO document_assistant.conversation.deleted audit row was
			//     emitted by the cascade path. (The deleteDocument procedure
			//     emits its own `document.deleted` style activity through
			//     emitActivity — which is mocked to no-op — but it does NOT
			//     emit document_assistant.conversation.deleted per
			//     conversation. Audit silence is the contract per spec §14.)
			const docAsstDeletedCalls = recordAuditMock.mock.calls.filter(
				(args) => {
					const payload = args[1] as { action?: string } | undefined;
					return (
						payload?.action ===
						"document_assistant.conversation.deleted"
					);
				},
			);
			expect(docAsstDeletedCalls).toHaveLength(0);

			// (4) Unrelated conversation on the sibling doc survives.
			const sibling = await db.agentConversation.findUnique({
				where: { id: unrelated.conversationId },
			});
			expect(sibling).not.toBeNull();
			const siblingJoin =
				await db.documentAssistantConversation.findUnique({
					where: { id: unrelated.joinId },
				});
			expect(siblingJoin).not.toBeNull();
		});

		it("cascades and silently removes assistant history when projects.stories.delete fires on a UserStory", async () => {
			const project = await seedProject();
			const status = await db.projectStoryStatus.create({
				data: {
					projectId: project.id,
					name: "Backlog",
					color: "#94a3b8",
					order: 0,
					isDefault: true,
				},
			});
			const story = await db.userStory.create({
				data: {
					projectId: project.id,
					statusId: status.id,
					identifier: "US-002",
					title: "Cascade Procedure Story",
					createdById: USER_ID,
				},
			});
			const siblingStory = await db.userStory.create({
				data: {
					projectId: project.id,
					statusId: status.id,
					identifier: "US-003",
					title: "Sibling Story (must survive)",
					createdById: USER_ID,
				},
			});

			const attached = await seedSharedConversation({
				documentRefKind: "USER_STORY",
				documentRefId: story.id,
				projectId: project.id,
			});
			const unrelated = await seedSharedConversation({
				documentRefKind: "USER_STORY",
				documentRefId: siblingStory.id,
				projectId: project.id,
			});

			await handlers.deleteStory({
				context: makeContext(),
				input: {
					projectId: project.id,
					storyId: story.id,
					organizationId: ORG_ID,
				},
			});

			const remainingJoins = await db.documentAssistantConversation.count(
				{
					where: {
						documentRefKind: "USER_STORY",
						documentRefId: story.id,
					},
				},
			);
			expect(remainingJoins).toBe(0);

			const attachedStillThere = await db.agentConversation.findUnique({
				where: { id: attached.conversationId },
			});
			expect(attachedStillThere).toBeNull();

			const docAsstDeletedCalls = recordAuditMock.mock.calls.filter(
				(args) => {
					const payload = args[1] as { action?: string } | undefined;
					return (
						payload?.action ===
						"document_assistant.conversation.deleted"
					);
				},
			);
			expect(docAsstDeletedCalls).toHaveLength(0);

			const siblingConv = await db.agentConversation.findUnique({
				where: { id: unrelated.conversationId },
			});
			expect(siblingConv).not.toBeNull();
			const siblingJoin =
				await db.documentAssistantConversation.findUnique({
					where: { id: unrelated.joinId },
				});
			expect(siblingJoin).not.toBeNull();
		});
	},
);
