/**
 * The defect this change fixes, stated as behaviour.
 *
 * A personal project owned by someone else, and a caller who is an accepted
 * ProjectMember of it — an external guest, most visibly. Every newsletter and
 * daily-brief procedure used to re-derive the project as
 * `{ id, organizationId: null, userId: context.user.id }`, which in personal
 * context means OWNER, so this caller was authorized by
 * `requireProjectPermission` and then rejected by the handler with NOT_FOUND.
 *
 * The project double below is a fake table, not a `mockResolvedValue`. That is
 * the whole point: a naive stub returns the row for ANY `where` and would go
 * green against the broken handler too. This one answers the query it is
 * actually given, so re-adding the owner clause turns it red — which is how the
 * negative control on this file was verified.
 *
 * WHAT THIS FILE DOES NOT PROVE, so nobody reads it as more than it is: the
 * middleware is stubbed here, exactly as every sibling suite stubs it, so these
 * assertions are about the HANDLER in isolation. They say the handler admits
 * whoever reaches it; they say nothing about who reaches it. Authorization
 * itself — an accepted non-owner member of a PERSONAL project is granted, a
 * caller with no membership is denied — is pinned against the real middleware
 * in `packages/api/__tests__/require-project-permission.test.ts`, and the
 * resolver's deny paths in
 * `packages/api/lib/__tests__/effective-project-permissions.test.ts`. Those two
 * plus this one are the whole argument; none of them carries it alone.
 *
 * Breadth is covered structurally by
 * `packages/api/__tests__/project-scoped-lookup-ownership-ratchet.test.ts`,
 * which can only match text — it establishes that no procedure re-scopes its
 * lookup, never that the middleware ran.
 *
 * Run with: pnpm --filter @repo/api test personal-project-member-access
 */

import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockProjectFindFirst,
	mockProjectFindUnique,
	mockGetNewsletterSettings,
} = vi.hoisted(() => ({
	mockProjectFindFirst: vi.fn(),
	mockProjectFindUnique: vi.fn(),
	mockGetNewsletterSettings: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		project: {
			// Both are wired so the fake answers whichever the handler reaches for.
			// A handler that went back to the owner-scoped `findFirst` would get a
			// truthful null rather than a stub's row.
			findFirst: mockProjectFindFirst,
			findUnique: mockProjectFindUnique,
		},
	},
	getNewsletterSettings: mockGetNewsletterSettings,
}));

vi.mock("../../../../orpc/procedures", () => {
	// biome-ignore lint/suspicious/noExplicitAny: minimal chainable test double
	const chainable: any = {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => ({ _handler: fn }),
	};
	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		// Stubbed exactly as the sibling suites stub it. In production this is the
		// gate that admits the member; here it stands aside so the assertions are
		// about the HANDLER, which is where the defect lived.
		requireProjectPermission: () => (c: unknown) => c,
		resolveOrganizationId: vi.fn(
			(organizationId: string | null) => organizationId ?? null,
		),
	};
});

import { getSettingsProcedure } from "../settings-get";

type Handler = (args: { input: unknown; context: unknown }) => Promise<unknown>;
const getSettings = (getSettingsProcedure as unknown as { _handler: Handler })
	._handler;

/** Personal project (organizationId null), owned by someone other than the caller. */
const PROJECT = {
	id: "proj-personal",
	organizationId: null as string | null,
	userId: "owner-1",
};

/**
 * Stands for an accepted ProjectMember of PROJECT who is not its owner. There
 * is no membership fixture because nothing here reads one: with the middleware
 * stubbed, this context only supplies the user id the handler must NOT filter
 * by. The membership itself is fixtured in require-project-permission.test.ts.
 */
const guestContext = {
	user: { id: "guest-2", email: "guest@example.com", name: "Guest" },
	session: { activeOrganizationId: null },
};

/**
 * Answers the query it is given, the way Postgres would.
 *
 * `findUnique` matches on the unique key alone. `findFirst` honours every
 * clause it is handed — so an owner-scoped where against a project owned by
 * someone else returns null, exactly as the database does.
 */
function matches(where: Record<string, unknown> | undefined): boolean {
	if (!where || where.id !== PROJECT.id) {
		return false;
	}
	if (
		"organizationId" in where &&
		where.organizationId !== PROJECT.organizationId
	) {
		return false;
	}
	if ("userId" in where && where.userId !== PROJECT.userId) {
		return false;
	}
	return true;
}

beforeEach(() => {
	vi.clearAllMocks();
	const answer = async (args: { where?: Record<string, unknown> }) =>
		matches(args?.where) ? PROJECT : null;
	mockProjectFindUnique.mockImplementation(answer);
	mockProjectFindFirst.mockImplementation(answer);
	mockGetNewsletterSettings.mockResolvedValue({
		projectId: PROJECT.id,
		enabled: true,
	});
});

describe("newsletter.settings.get — non-owner member of a personal project", () => {
	it("returns the settings instead of NOT_FOUND", async () => {
		const result = await getSettings({
			input: { projectId: PROJECT.id, organizationId: null },
			context: guestContext,
		});

		expect(result).toEqual({
			settings: { projectId: PROJECT.id, enabled: true },
		});
		expect(mockGetNewsletterSettings).toHaveBeenCalledWith(PROJECT.id);
	});

	it("loads the project without constraining it to the caller", async () => {
		await getSettings({
			input: { projectId: PROJECT.id, organizationId: null },
			context: guestContext,
		});

		// The assertion that survives a refactor: whatever call shape is used, the
		// project must not be filtered by who is asking.
		const call =
			mockProjectFindUnique.mock.calls[0] ??
			mockProjectFindFirst.mock.calls[0];
		const where = (call?.[0] as { where?: Record<string, unknown> })?.where;
		expect(where).toBeDefined();
		expect(JSON.stringify(where)).not.toContain(guestContext.user.id);
	});

	it("still refuses an organizationId that contradicts the project", async () => {
		const error = await getSettings({
			input: { projectId: PROJECT.id, organizationId: "org-not-ours" },
			context: guestContext,
		}).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(ORPCError);
		expect((error as ORPCError<string, unknown>).code).toBe("BAD_REQUEST");
		// The guard runs before any payload is assembled.
		expect(mockGetNewsletterSettings).not.toHaveBeenCalled();
	});

	it("still returns NOT_FOUND when the project genuinely does not exist", async () => {
		const error = await getSettings({
			input: { projectId: "no-such-project", organizationId: null },
			context: guestContext,
		}).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(ORPCError);
		expect((error as ORPCError<string, unknown>).code).toBe("NOT_FOUND");
	});
});
