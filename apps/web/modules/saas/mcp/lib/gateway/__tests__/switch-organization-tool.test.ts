/**
 * `fabric_switch_organization` / `fabric_get_identity` tests — organization-only
 * context.
 *
 * Context is organization-only: both key-authenticated protocol entry points
 * resolve an organization before a session exists, so the switch tool is no
 * longer a way back to personal context and the identity tool no longer has a
 * second mode to report.
 *
 * Three things are pinned here, and the third is the one most likely to rot:
 *
 * 1. The handler. A null organization is refused with a message that names the
 *    reason, so a model does not read the refusal as a validation slip and
 *    retry the identical call.
 * 2. The persistence. A switch writes `User.lastActiveOrganizationId` as well
 *    as moving the in-memory session. The entry points re-resolve on every
 *    request and keep a stored session only while it equals that answer, and
 *    for a multi-organization caller that answer IS last-active — so without
 *    the write a switch is undone by the very next request.
 * 3. The strings. They are read by a model, so a description that still offers
 *    personal context keeps the retired behaviour alive after the handler
 *    stops honouring it. The guard below is a mechanical scan over every tool
 *    definition this module exports rather than a hand-listed set, so a tool
 *    added later cannot slip an offer past it.
 *
 * `@repo/database` is fully mocked — the handlers reach it through dynamic
 * `await import(...)`, so the mock intercepts inside the handler body.
 *
 * Run with: pnpm --filter web test modules/saas/mcp/lib/gateway/__tests__/switch-organization-tool
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	isOrganizationMember: vi.fn(),
	memberFindMany: vi.fn(),
	userUpdate: vi.fn(),
	projectFindUnique: vi.fn(),
	hasProjectAccess: vi.fn(),
	canCreateProjectStory: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		member: { findMany: mocks.memberFindMany },
		user: { update: mocks.userUpdate },
		project: { findUnique: mocks.projectFindUnique },
		userStory: {
			findFirst: vi.fn(),
			findUnique: vi.fn(),
			updateMany: vi.fn(),
		},
	},
	isOrganizationMember: mocks.isOrganizationMember,
	hasProjectAccess: mocks.hasProjectAccess,
	canCreateProjectStory: mocks.canCreateProjectStory,
	buildBacklogDedupGuard: vi.fn(),
	listStories: vi.fn(),
	TERMINAL_DRAFTING_STAGES: ["DECLINED", "CLOSED"],
}));

vi.mock("@repo/temporal", () => ({
	createStoryFromProposal: vi.fn(),
	dispatchLifecycleEvent: vi.fn(),
}));

vi.mock("@repo/api/lib/audit", () => ({
	recordAuditFromRequest: vi.fn(),
}));

import {
	executePlatformTool,
	PLATFORM_TOOL_DEFINITIONS,
} from "../platform-tools";
import type { GatewaySession } from "../types";

/** Parse the JSON payload a platform tool packs into its text content block. */
function payload(result: { content: Array<{ text: string }> }) {
	return JSON.parse(result.content[0].text);
}

/**
 * The caller's stored row, as far as these tests are concerned: which
 * organizations they belong to, and the `lastActiveOrganizationId` pointer that
 * `resolveUserOrganization` reads on the next request
 * (`packages/database/prisma/queries/resolve-user-organization.ts`).
 */
let userRow: { lastActiveOrganizationId: string | null; memberships: string[] };

function freshSession(overrides: Partial<GatewaySession> = {}): GatewaySession {
	return {
		sessionId: "sess-1",
		userId: "user-1",
		organizationId: "org-1",
		userName: "Example Agent",
		email: "agent@example.com",
		role: "user",
		// Switching is a personal-key and browser capability. An organization
		// key is pinned to the tenant it was issued for — see the case at the
		// end of this file.
		credential: "personal-key",
		scopes: ["*"],
		createdAt: new Date("2026-01-01T00:00:00Z"),
		expiresAt: new Date("2026-01-02T00:00:00Z"),
		...overrides,
	};
}

/**
 * What the shared resolver answers on the caller's NEXT request, expressed
 * against the same stored row this test's `db.user.update` wrote to. Only the
 * multi-membership branch matters here — that is the branch a switch exists to
 * steer — and it is the branch that reads last-active.
 */
function resolveOnNextRequest(): string | null {
	const pointer = userRow.lastActiveOrganizationId;
	return pointer && userRow.memberships.includes(pointer) ? pointer : null;
}

beforeEach(() => {
	vi.clearAllMocks();

	userRow = {
		lastActiveOrganizationId: "org-1",
		memberships: ["org-1", "org-2"],
	};

	mocks.isOrganizationMember.mockImplementation(
		async (_userId: string, organizationId: string) =>
			userRow.memberships.includes(organizationId),
	);
	mocks.userUpdate.mockImplementation(
		async ({
			data,
		}: {
			where: { id: string };
			data: { lastActiveOrganizationId: string | null };
		}) => {
			userRow.lastActiveOrganizationId = data.lastActiveOrganizationId;
			return { id: "user-1", ...data };
		},
	);
	mocks.memberFindMany.mockResolvedValue([
		{
			role: "member",
			organization: {
				id: "org-1",
				name: "Example Org",
				slug: "example-org",
			},
		},
		{
			role: "owner",
			organization: {
				id: "org-2",
				name: "Example Org Two",
				slug: "example-org-two",
			},
		},
	]);
});

describe("fabric_switch_organization", () => {
	it("switches to an organization the caller belongs to", async () => {
		const session = freshSession();

		const result = await executePlatformTool(
			"fabric_switch_organization",
			{ organizationId: "org-2" },
			session,
		);

		expect(result.isError).toBeFalsy();
		expect(payload(result)).toMatchObject({
			success: true,
			previousOrganizationId: "org-1",
			newOrganizationId: "org-2",
			mode: "organization",
		});
		expect(session.organizationId).toBe("org-2");
	});

	it("refuses an organization the caller does not belong to", async () => {
		const session = freshSession();

		const result = await executePlatformTool(
			"fabric_switch_organization",
			{ organizationId: "org-outsider" },
			session,
		);

		expect(result.isError).toBe(true);
		expect(payload(result).error).toContain("not a member");
		// The session is left exactly where it was, and nothing is persisted.
		expect(session.organizationId).toBe("org-1");
		expect(mocks.userUpdate).not.toHaveBeenCalled();
	});

	it("refuses a null organization, naming organization-only context as the reason", async () => {
		const session = freshSession();

		const result = await executePlatformTool(
			"fabric_switch_organization",
			{ organizationId: null },
			session,
		);

		expect(result.isError).toBe(true);
		const { error } = payload(result);
		// Not a bare "invalid input": the caller is a model, and a refusal that
		// does not say why is a refusal it will retry verbatim.
		expect(error).toMatch(/organization-only/i);
		expect(error).toMatch(/no personal context/i);
		expect(error).toContain("fabric_list_organizations");

		expect(session.organizationId).toBe("org-1");
		expect(mocks.userUpdate).not.toHaveBeenCalled();
		expect(mocks.isOrganizationMember).not.toHaveBeenCalled();
	});

	it("refuses an omitted organization the same way as an explicit null", async () => {
		const session = freshSession();

		const result = await executePlatformTool(
			"fabric_switch_organization",
			{},
			session,
		);

		expect(result.isError).toBe(true);
		expect(payload(result).error).toMatch(/organization-only/i);
		expect(session.organizationId).toBe("org-1");
	});

	it("persists last-active, so the next request resolves to the organization just switched to", async () => {
		const session = freshSession();

		await executePlatformTool(
			"fabric_switch_organization",
			{ organizationId: "org-2" },
			session,
		);

		// The write itself, in the shape `resolveUserOrganization` reads.
		expect(mocks.userUpdate).toHaveBeenCalledWith({
			where: { id: "user-1" },
			data: { lastActiveOrganizationId: "org-2" },
		});

		// And the consequence: the session and the resolver agree about this
		// caller. Without the write the resolver would still answer "org-1",
		// the stored session would no longer match it, and the switch would
		// survive exactly one request.
		expect(resolveOnNextRequest()).toBe("org-2");
		expect(resolveOnNextRequest()).toBe(session.organizationId);
	});

	it("does not move the session when persisting last-active fails", async () => {
		mocks.userUpdate.mockRejectedValue(new Error("write failed"));
		const session = freshSession();

		const result = await executePlatformTool(
			"fabric_switch_organization",
			{ organizationId: "org-2" },
			session,
		);

		expect(result.isError).toBe(true);
		// A session pointing somewhere the resolver will not agree with is the
		// exact divergence the write exists to prevent.
		expect(session.organizationId).toBe("org-1");
	});
});

describe("fabric_get_identity", () => {
	it("reports a single organization mode", async () => {
		const result = await executePlatformTool(
			"fabric_get_identity",
			{},
			freshSession(),
		);

		const identity = payload(result);
		expect(identity.mode).toBe("organization");
		expect(identity.organizationId).toBe("org-1");
		expect(identity.organizationName).toBe("Example Org");
	});

	it("never reports a personal mode", async () => {
		for (const organizationId of ["org-1", "org-2"]) {
			const result = await executePlatformTool(
				"fabric_get_identity",
				{},
				freshSession({ organizationId }),
			);
			expect(payload(result).mode).not.toBe("personal");
		}
	});
});

describe("no live string offers personal context", () => {
	/**
	 * Every model-facing string this module publishes: each tool's description,
	 * plus the description of every property in its input schema, at any depth.
	 * Collected by walking the exported definitions rather than by listing
	 * them, so a tool added later is covered without touching this test.
	 */
	function toolStrings(): Array<{
		tool: string;
		where: string;
		text: string;
	}> {
		const found: Array<{ tool: string; where: string; text: string }> = [];

		function walk(tool: string, where: string, node: unknown) {
			if (Array.isArray(node)) {
				node.forEach((child, i) => {
					walk(tool, `${where}[${i}]`, child);
				});
				return;
			}
			if (!node || typeof node !== "object") {
				return;
			}
			for (const [key, value] of Object.entries(
				node as Record<string, unknown>,
			)) {
				if (key === "description" && typeof value === "string") {
					found.push({
						tool,
						where: `${where}.description`,
						text: value,
					});
				} else {
					walk(tool, `${where}.${key}`, value);
				}
			}
		}

		for (const tool of PLATFORM_TOOL_DEFINITIONS) {
			found.push({
				tool: tool.name,
				where: "description",
				text: tool.description,
			});
			walk(tool.name, "inputSchema", tool.inputSchema);
		}
		return found;
	}

	it("collects a string from every tool, so the scans below cannot pass vacuously", () => {
		const strings = toolStrings();
		const covered = new Set(strings.map((s) => s.tool));
		expect(covered.size).toBe(PLATFORM_TOOL_DEFINITIONS.length);
		expect(strings.length).toBeGreaterThan(
			PLATFORM_TOOL_DEFINITIONS.length,
		);
	});

	/**
	 * Phrases that only ever appear when a string is OFFERING the retired
	 * affordance — a null organization, or a switch into personal context.
	 */
	const OFFERS = [
		/organizationId\s*[=:]\s*null/i,
		/\bor null\b/i,
		/\bnull to switch\b/i,
		/switch(ing)?\s+(back\s+)?to\s+personal/i,
		/\(personal or organization\)/i,
	];

	it("no tool string offers a null organization or a switch into personal context", () => {
		const offenders = toolStrings().filter(({ text }) =>
			OFFERS.some((pattern) => pattern.test(text)),
		);
		expect(offenders.map((o) => `${o.tool} ${o.where}`)).toEqual([]);
	});

	/**
	 * The catch-all, and the reason this test is a scan rather than a list:
	 * "personal" may still be WRITTEN — saying the mode does not exist is how a
	 * model learns not to reach for it — but only inside a clause that denies
	 * it. A future string that mentions personal context approvingly has no
	 * negation next to it and fails here even if it dodges every pattern above.
	 */
	it("mentions personal context only to deny it", () => {
		const NEGATION = /\b(no|not|never|cannot|can't|isn't|doesn't)\b/i;

		const offenders = toolStrings().flatMap(({ tool, where, text }) =>
			text
				// Clause boundaries: sentence ends, em dashes and semicolons.
				.split(/(?<=[.!?])\s+|\s+—\s+|;\s*/)
				.filter((clause) => /personal/i.test(clause))
				.filter((clause) => !NEGATION.test(clause))
				.map((clause) => `${tool} ${where}: ${clause.trim()}`),
		);

		expect(offenders).toEqual([]);
	});

	it("the switch tool requires an organizationId and declares no nullable one", () => {
		const tool = PLATFORM_TOOL_DEFINITIONS.find(
			(t) => t.name === "fabric_switch_organization",
		);
		expect(tool).toBeDefined();

		const schema = tool?.inputSchema as {
			required?: string[];
			properties?: Record<string, Record<string, unknown>>;
		};
		expect(schema.required).toContain("organizationId");
		// `nullable: true` is how the schema used to advertise the way back.
		expect(schema.properties?.organizationId).not.toHaveProperty(
			"nullable",
		);
	});
});

describe("work-item refusals", () => {
	/**
	 * The runtime message a write path returns for a project no session can
	 * reach. It used to instruct the caller to switch to a null organization —
	 * after this change that is an operation which always fails, so the
	 * instruction was a retry loop, not a hint.
	 */
	it("tells a caller an org-less project is unreachable, without offering a way back", async () => {
		mocks.hasProjectAccess.mockResolvedValue(true);
		mocks.projectFindUnique.mockResolvedValue({
			id: "proj-1",
			organizationId: null,
		});

		const result = await executePlatformTool(
			"fabric_create_feature",
			{ projectId: "proj-1", title: "Export the roadmap as CSV" },
			freshSession(),
		);

		expect(result.isError).toBe(true);
		const { error } = payload(result);
		expect(error).toMatch(/cannot be reached/i);
		expect(error).not.toContain("organizationId=null");
		// The message may say switching will not help — what it must never do is
		// name the tool as the next step, which is what produced the retry loop.
		expect(error).not.toContain("fabric_switch_organization");
		expect(mocks.canCreateProjectStory).not.toHaveBeenCalled();
	});

	it("still names the organization to switch to for a project in another one", async () => {
		mocks.hasProjectAccess.mockResolvedValue(true);
		mocks.projectFindUnique.mockResolvedValue({
			id: "proj-1",
			organizationId: "org-2",
		});

		const result = await executePlatformTool(
			"fabric_create_feature",
			{ projectId: "proj-1", title: "Export the roadmap as CSV" },
			freshSession(),
		);

		expect(result.isError).toBe(true);
		expect(payload(result).error).toContain("fabric_switch_organization");
		expect(payload(result).error).toContain("org-2");
	});
});

describe("an organization key is pinned to the organization it was issued for", () => {
	// The protocol routes already refuse to let a request header move an
	// organization key's tenant. This tool was the way around that: it checks
	// the creator's memberships, so a key issued for one organization could be
	// walked into any other its creator belongs to — which made the key record's
	// organizationId read like a boundary while being a starting position
	// (Fizzy #2380).
	it("refuses to switch, without consulting membership or touching last-active", async () => {
		const session = freshSession({ credential: "organization-key" });

		const result = await executePlatformTool(
			"fabric_switch_organization",
			{ organizationId: "org-2" },
			session,
		);

		expect(result.isError).toBe(true);
		expect(payload(result).error).toContain("single organization");
		expect(session.organizationId).toBe("org-1");
		// The refusal is about which credential is asking, not about who the
		// creator happens to belong to — so neither question is asked.
		expect(mocks.isOrganizationMember).not.toHaveBeenCalled();
		expect(mocks.userUpdate).not.toHaveBeenCalled();
	});

	it("still allows a personal key to switch", async () => {
		const session = freshSession({ credential: "personal-key" });

		const result = await executePlatformTool(
			"fabric_switch_organization",
			{ organizationId: "org-2" },
			session,
		);

		expect(result.isError).toBeFalsy();
		expect(session.organizationId).toBe("org-2");
	});
});
