/**
 * Shared test harness for the document-assistant procedures.
 *
 * Mirrors the captured-handler pattern in
 * `packages/api/modules/projects/procedures/__tests__/audit-emission.test.ts`:
 *   1. Stub `tenantProtectedProcedure` + permission middlewares so the
 *      chainable builder captures the raw handler functions.
 *   2. Stub `@repo/database` with vi.fn()s for every helper the
 *      procedures import.
 *   3. Stub `verifyOrganizationMembership` so the inline org gate
 *      passes by default.
 *
 * Test files import this module FIRST, then import each procedure file
 * with `__setPendingHandlerKey` toggled to the right slot beforehand.
 */

import { vi } from "vitest";

export type CapturedHandler = (args: {
	input: Record<string, unknown>;
	context: Record<string, unknown>;
}) => Promise<unknown>;

export const dbMock = {
	organization: {
		findUnique: vi.fn(),
	},
	documentAssistantConversation: {
		findUnique: vi.fn(),
		findFirst: vi.fn(),
		findMany: vi.fn(),
		create: vi.fn(),
		update: vi.fn(),
		updateMany: vi.fn(),
	},
	agentConversation: {
		findUnique: vi.fn(),
		findFirst: vi.fn(),
		findMany: vi.fn(),
		create: vi.fn(),
		update: vi.fn(),
		delete: vi.fn(),
	},
	user: {
		findMany: vi.fn(),
	},
	$transaction: vi.fn(),
};

export const repoDatabaseMock = {
	db: dbMock,
	listDocumentAssistantConversations: vi.fn(),
	getActiveDocumentAssistantConversation: vi.fn(),
	getDocumentAssistantConversationByIdAndDocument: vi.fn(),
	createDocumentAssistantConversation: vi.fn(),
	setDocumentAssistantConversationVisibility: vi.fn(),
	archiveDocumentAssistantConversation: vi.fn(),
	deleteDocumentAssistantConversationByConversationId: vi.fn(),
	countDocumentAssistantConversationsInLast24h: vi.fn(),
	DocumentAssistantVisibilityLockedError: class extends Error {
		readonly conversationId: string;
		constructor(conversationId: string) {
			super(`Visibility locked for ${conversationId}`);
			this.conversationId = conversationId;
			this.name = "DocumentAssistantVisibilityLockedError";
		}
	},
};

export const recordAuditMock = vi.fn();

export const handlers: Record<string, CapturedHandler> = {};
let pendingKey = "";

vi.mock("@repo/database", () => repoDatabaseMock);

// Keep the procedure file's resolved path for both audit + membership +
// orpc/procedures so vi's module cache hits on the SAME identifier the
// source `import` statement resolved to. The test file sits one level
// deeper than the procedure file, so each path picks up an extra `../`
// versus what the source uses.
vi.mock("../../../../../../lib/audit", () => ({
	recordAuditFromRequest: (...args: unknown[]) => recordAuditMock(...args),
	wireAuditObservability: vi.fn(),
}));

vi.mock("../../../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: vi
		.fn()
		.mockResolvedValue({ organization: { id: "org-1" }, role: "owner" }),
	requireOrgMembership: vi
		.fn()
		.mockResolvedValue({ organization: { id: "org-1" }, role: "owner" }),
}));

vi.mock("../../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: CapturedHandler) => {
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

export function setPendingHandlerKey(key: string): void {
	pendingKey = key;
}

/**
 * Base oRPC procedure context shape. Overridable per test via spread.
 */
export const baseUser = {
	id: "user-1",
	email: "alice@example.com",
	name: "Alice",
};
export const baseSession = {
	id: "sess-1",
	activeOrganizationId: "org-1",
	impersonatedBy: null,
};

export function makeContext(
	overrides: Partial<{
		user: typeof baseUser;
		session: typeof baseSession;
	}> = {},
): Record<string, unknown> {
	return {
		user: overrides.user ?? baseUser,
		session: overrides.session ?? baseSession,
		headers: new Headers(),
	};
}
