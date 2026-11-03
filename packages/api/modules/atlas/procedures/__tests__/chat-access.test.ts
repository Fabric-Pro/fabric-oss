/**
 * Who may ask the Atlas codebase chat, through each of its doors: the
 * `atlas.chat` procedure (its middleware and handler, run for real) and
 * `authorizeAtlasChat`, which the agent runtime's `atlas-chat` engine calls.
 * One table answers for both, so a check one door makes and the other skips
 * fails here.
 *
 *   - PROJECT_READ is judged first, and a caller with no tie to the project
 *     hears NOT_FOUND before any role is judged;
 *   - a request that names another organization than the project's is
 *     refused BAD_REQUEST;
 *   - AI_CHAT is judged in the organization the request runs in;
 *   - Atlas must be on, then codebase Q&A must be available;
 *   - no refusal starts the chat, and none before the capability check reads
 *     the capability's evidence.
 *
 * Two rows belong to one door only: the procedure admits a project guest in
 * personal context (AI_CHAT has no organization role to judge there), and the
 * engine refuses one, because a runtime request always runs in the
 * organization on screen. The panel therefore keeps guests on the procedure.
 */
import { call, os } from "@orpc/server";
import { Permissions } from "@repo/permissions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	access: vi.fn<
		typeof import("../../../../lib/effective-project-permissions")["resolveEffectiveProjectPermissions"]
	>(),
	role: "member",
	isMember: true,
	membership: vi.fn(),
	evidence: vi.fn(),
	chat: vi.fn(),
	serviceCtx: vi.fn(),
}));

vi.mock("../../../../orpc/procedures", async () => {
	const guards = await import(
		"../../../../orpc/middleware/require-permission"
	);
	return {
		tenantProtectedProcedure: os.$context<{
			user: { id: string };
			session: { activeOrganizationId: string | null };
			activeOrganizationRole: string | null;
			allowedProjectIds: string[];
			tenantContext: {
				type: "organization" | "personal";
				userId: string;
				organizationId: string | null;
			};
		}>(),
		Permissions: (await import("@repo/permissions")).Permissions,
		requirePermission: guards.requirePermission,
		requireProjectPermission: guards.requireProjectPermission,
		assertProjectPermission: guards.assertProjectPermission,
		authorizeInputOrganization: guards.authorizeInputOrganization,
		resolveOrganizationId: (
			organizationId: string | null | undefined,
			session: { activeOrganizationId: string | null },
		) => organizationId ?? session.activeOrganizationId ?? undefined,
	};
});

vi.mock("../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: m.access,
}));

vi.mock("@repo/database", () => ({
	db: {
		project: {
			findUnique: async () => ({ organizationId: "org-example-1" }),
		},
	},
	isFeatureEnabled: async () => true,
	getOrganizationMembership: m.membership,
	getTenantContext: () => ({ effectiveWriteOrgId: null }),
	grantProjectAccess: vi.fn(),
}));

vi.mock("../../../capabilities/evidence", () => ({
	gatherCapabilityEvidence: m.evidence,
}));

vi.mock("@repo/ai", () => ({
	AIProviderNotConfiguredError: class AIProviderNotConfiguredError extends Error {},
}));

vi.mock("@repo/atlas", async () => {
	class AtlasError extends Error {
		constructor(
			readonly code: string,
			message: string,
		) {
			super(message);
			this.name = "AtlasError";
		}
	}
	return {
		...(await import("@repo/atlas/schemas")),
		AtlasError,
		AtlasService: class {
			constructor(ctx: unknown) {
				m.serviceCtx(ctx);
			}
			chat = m.chat;
		},
	};
});

process.env.FABRIC_FEATURE_ATLAS = "true";
delete process.env.FABRIC_FEATURE_CODE_UNDERSTANDING;
delete process.env.RBAC_DRY_RUN;

const { atlasChatProcedure } = await import("../chat");
const { authorizeAtlasChat } = await import("../../chat-access");
const { evidenceWith, healthyEvidence } = await import(
	"../../../capabilities/__tests__/evidence-fixture"
);

const USER = "user-example-1";
const ORG = "org-example-1";
const OTHER_ORG = "org-example-2";
const PROJECT = "project-example-1";

const MEMBER_ACCESS = {
	source: "org",
	organizationId: ORG,
	permissions: [Permissions.PROJECT_READ],
	organizationDeleted: false,
} as const;

function procedureContext() {
	return {
		user: { id: USER },
		session: { activeOrganizationId: ORG },
		activeOrganizationRole: m.role,
		allowedProjectIds: [],
		tenantContext: {
			type: "organization" as const,
			userId: USER,
			organizationId: ORG,
		},
	};
}

const DOORS = [
	{
		door: "procedure",
		startsChat: true,
		ask: () =>
			call(
				atlasChatProcedure,
				{
					projectId: PROJECT,
					organizationId: ORG,
					mode: "TECHNICAL",
					messages: [
						{ role: "user", content: "How does auth work?" },
					],
				},
				{ context: procedureContext() },
			),
	},
	{
		door: "authorizeAtlasChat (runtime engine)",
		startsChat: false,
		ask: () =>
			authorizeAtlasChat({ userId: USER, organizationId: ORG }, PROJECT),
	},
] as const;

beforeEach(() => {
	vi.clearAllMocks();
	process.env.FABRIC_FEATURE_ATLAS = "true";
	m.role = "member";
	m.isMember = true;
	m.access.mockResolvedValue(MEMBER_ACCESS);
	m.membership.mockImplementation(async () =>
		m.isMember ? { role: m.role, organization: { deletedAt: null } } : null,
	);
	m.evidence.mockResolvedValue(healthyEvidence());
	m.chat.mockResolvedValue({
		getAnswerModel: () => undefined,
		textStream: (async function* () {
			yield "answer";
		})(),
		persistOutcome: Promise.resolve({
			persisted: true,
			interrupted: false,
		}),
	});
});

describe.each(DOORS)("Atlas chat access — $door", ({ startsChat, ask }) => {
	it("refuses a caller whose project access lacks PROJECT_READ", async () => {
		m.access.mockResolvedValue({ ...MEMBER_ACCESS, permissions: [] });

		await expect(ask()).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: expect.stringContaining("project:read"),
		});
		expect(m.evidence).not.toHaveBeenCalled();
		expect(m.chat).not.toHaveBeenCalled();
	});

	it("answers NOT_FOUND for another organization's project the caller has no tie to", async () => {
		m.access.mockResolvedValue({
			source: "none",
			organizationId: OTHER_ORG,
			permissions: [],
		});

		await expect(ask()).rejects.toMatchObject({
			code: "NOT_FOUND",
			message: "Project not found",
		});
		expect(m.evidence).not.toHaveBeenCalled();
		expect(m.chat).not.toHaveBeenCalled();
	});

	it("refuses an organization that is not the project's", async () => {
		m.access.mockResolvedValue({
			source: "project-member",
			organizationId: OTHER_ORG,
			permissions: [Permissions.PROJECT_READ],
		});

		await expect(ask()).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: "organizationId does not match the project",
		});
		expect(m.evidence).not.toHaveBeenCalled();
		expect(m.chat).not.toHaveBeenCalled();
	});

	it("refuses a caller whose organization role lacks AI_CHAT", async () => {
		m.role = "viewer";

		await expect(ask()).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: expect.stringContaining("ai:chat"),
		});
		expect(m.evidence).not.toHaveBeenCalled();
		expect(m.chat).not.toHaveBeenCalled();
	});

	it("refuses with PRECONDITION_FAILED when codebase Q&A is blocked", async () => {
		m.evidence.mockResolvedValue(
			evidenceWith({ codebase: { connected: false } }),
		);

		await expect(ask()).rejects.toMatchObject({
			code: "PRECONDITION_FAILED",
			message: expect.stringContaining("a connected repository"),
		});
		expect(m.chat).not.toHaveBeenCalled();
	});

	it("hides the project before judging the role", async () => {
		m.access.mockResolvedValue({
			source: "none",
			organizationId: ORG,
			permissions: [],
		});
		m.role = "viewer";

		await expect(ask()).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.chat).not.toHaveBeenCalled();
	});

	it.each(["owner", "admin", "member"])(
		"admits an organization %s with both permissions",
		async (role) => {
			m.role = role;
			await ask();

			// Only the procedure goes on to the chat; the engine starts it itself.
			expect(m.chat).toHaveBeenCalledTimes(startsChat ? 1 : 0);
			expect(m.serviceCtx.mock.calls).toEqual(
				startsChat ? [[{ userId: USER, organizationId: ORG }]] : [],
			);
		},
	);

	it("answers NOT_FOUND 'Atlas is not enabled.' while Atlas is off, after the project and role checks", async () => {
		delete process.env.FABRIC_FEATURE_ATLAS;

		await expect(ask()).rejects.toMatchObject({
			code: "NOT_FOUND",
			message: "Atlas is not enabled.",
		});
		expect(m.access).toHaveBeenCalled();
		expect(m.evidence).not.toHaveBeenCalled();
		expect(m.chat).not.toHaveBeenCalled();
	});
});

describe("Atlas chat access — one door only", () => {
	it("the engine refuses a project guest (no membership in the organization on screen)", async () => {
		m.access.mockResolvedValue({
			source: "project-member",
			organizationId: ORG,
			permissions: [Permissions.PROJECT_READ],
		});
		m.isMember = false;

		await expect(
			authorizeAtlasChat({ userId: USER, organizationId: ORG }, PROJECT),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: "You are not a member of this organization",
		});
		expect(m.evidence).not.toHaveBeenCalled();
	});

	it("the procedure admits a project guest in personal context (AI_CHAT is not judged there)", async () => {
		m.access.mockResolvedValue({
			source: "project-member",
			organizationId: ORG,
			permissions: [Permissions.PROJECT_READ],
		});

		await call(
			atlasChatProcedure,
			{
				projectId: PROJECT,
				organizationId: null,
				mode: "TECHNICAL",
				messages: [{ role: "user", content: "How does auth work?" }],
			},
			{
				context: {
					...procedureContext(),
					session: { activeOrganizationId: null },
					activeOrganizationRole: null,
					tenantContext: {
						type: "personal",
						userId: USER,
						organizationId: null,
					},
				},
			},
		);

		expect(m.chat).toHaveBeenCalledTimes(1);
		expect(m.membership).not.toHaveBeenCalled();
	});
});
