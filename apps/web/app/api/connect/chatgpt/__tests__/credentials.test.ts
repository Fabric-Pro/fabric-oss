/**
 * `POST /api/connect/chatgpt/credentials` (Fizzy #2939): the one-time upload
 * ticket is the only authentication. An expired or spent ticket is a 401;
 * the ticket alone decides whose row is written; and the organizations turned
 * on are only those bound in the ticket that still have the flag on.
 *
 * The real ticket module runs against an in-memory `verification` table.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = { id: string; identifier: string; value: string; expiresAt: Date };

const state = vi.hoisted(() => ({
	rows: [] as Row[],
	upsert: vi.fn(),
	setOrgUse: vi.fn(),
	organizations: vi.fn(),
	verifyIdToken: vi.fn(),
	audit: vi.fn(),
}));

vi.mock("@repo/database/prisma/client", () => ({
	db: {
		verification: {
			create: async ({ data }: { data: Omit<Row, "id"> }) => {
				const row = { id: `v${state.rows.length + 1}`, ...data };
				state.rows.push(row);
				return row;
			},
			findFirst: async ({ where }: { where: { identifier: string } }) =>
				state.rows.find((row) => row.identifier === where.identifier) ??
				null,
			deleteMany: async ({ where }: { where: { id: string } }) => {
				const before = state.rows.length;
				state.rows = state.rows.filter((row) => row.id !== where.id);
				return { count: before - state.rows.length };
			},
		},
	},
}));

vi.mock("@repo/database", async () => ({
	...(await vi.importActual<
		typeof import("@repo/database/prisma/queries/chatgpt-plan-upload-ticket")
	>("@repo/database/prisma/queries/chatgpt-plan-upload-ticket")),
	upsertChatGptPlanCredential: state.upsert,
	getChatGptPlanCredential: vi.fn(),
	deleteChatGptPlanCredential: vi.fn(),
	listChatGptPlanOrganizations: state.organizations,
	setChatGptPlanOrgUse: state.setOrgUse,
	recordAudit: state.audit,
	// Fizzy #2770: no subject in these cases is an organization's shared account.
	isChatGptPlanOrgAccountSubject: async () => false,
}));

vi.mock("@repo/database/prisma/queries/lib/refresh-lock", () => ({
	chatGptPlanLockKey: (userId: string) => `chatgpt-plan:${userId}`,
	withRefreshLock: vi.fn(),
}));

vi.mock("@repo/utils", () => ({
	encryptApiKey: (value: string) => `encrypted(${value.length})`,
	decryptApiKey: (value: string) => value,
}));

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@repo/ai/lib/chatgpt-plan/oauth", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@repo/ai/lib/chatgpt-plan/oauth")
	>()),
	verifyChatGptIdToken: state.verifyIdToken,
}));

const { createChatGptPlanUploadTicket } = await import(
	"@repo/database/prisma/queries/chatgpt-plan-upload-ticket"
);
const { POST } = await import("../credentials/route");

const ACCESS = "access-token-secret-value";

function upload(extra: Record<string, unknown> = {}) {
	return {
		accessToken: ACCESS,
		refreshToken: "refresh-token-secret-value",
		idToken: "header.payload.signature",
		expiresIn: 3600,
		scopes: ["openid", "offline_access", "chatgpt.tokens.use.direct"],
		clientId: "oaiapp_example",
		hostId: "urn:uuid:00000000-0000-0000-0000-000000000000",
		...extra,
	};
}

function post(ticket: string, body: unknown = upload()) {
	return POST(
		new Request("http://localhost/api/connect/chatgpt/credentials", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${ticket}`,
			},
			body: JSON.stringify(body),
		}),
	);
}

const ORG = (id: string, enabled = false) => ({
	id,
	slug: `${id}-slug`,
	name: id,
	enabled,
	answered: enabled,
	includeBackgroundJobs: false,
});

beforeEach(() => {
	vi.clearAllMocks();
	state.rows = [];
	state.organizations.mockResolvedValue([ORG("org-a"), ORG("org-b")]);
	state.verifyIdToken.mockResolvedValue({
		iss: "https://auth.openai.com",
		aud: "oaiapp_example",
		sub: "chatgpt-subject",
		iat: 1,
		exp: 2,
		email: "dev@example.com",
	});
});

describe("POST /api/connect/chatgpt/credentials", () => {
	it("refuses an expired ticket", async () => {
		const { ticket } = await createChatGptPlanUploadTicket({
			userId: "user-a",
			organizationIds: ["org-a"],
		});
		for (const row of state.rows) {
			row.expiresAt = new Date(Date.now() - 1);
		}
		const response = await post(ticket);
		expect(response.status).toBe(401);
		expect(state.upsert).not.toHaveBeenCalled();
	});

	it("refuses a ticket that was already used", async () => {
		const { ticket } = await createChatGptPlanUploadTicket({
			userId: "user-a",
			organizationIds: ["org-a"],
		});
		expect((await post(ticket)).status).toBe(200);
		const reused = await post(ticket);
		expect(reused.status).toBe(401);
		expect(state.upsert).toHaveBeenCalledTimes(1);
	});

	it("refuses a request with no ticket", async () => {
		const response = await POST(
			new Request("http://localhost/api/connect/chatgpt/credentials", {
				method: "POST",
				body: JSON.stringify(upload()),
			}),
		);
		expect(response.status).toBe(401);
	});

	it("writes only the row of the user the ticket was minted for", async () => {
		const { ticket } = await createChatGptPlanUploadTicket({
			userId: "user-a",
			organizationIds: ["org-a"],
		});
		const response = await post(ticket, upload({ userId: "user-b" }));
		expect(response.status).toBe(200);
		expect(state.upsert).toHaveBeenCalledTimes(1);
		expect(state.upsert.mock.calls[0]?.[0]).toMatchObject({
			userId: "user-a",
		});
		expect(state.organizations).toHaveBeenCalledWith({ userId: "user-a" });
	});

	it("turns use on only in ticket organizations that still have the flag on", async () => {
		// org-c was ticked but has since lost the flag (it is not offered).
		const { ticket } = await createChatGptPlanUploadTicket({
			userId: "user-a",
			organizationIds: ["org-a", "org-c"],
		});
		const response = await post(ticket);
		expect(response.status).toBe(200);
		expect(state.setOrgUse).toHaveBeenCalledTimes(1);
		expect(state.setOrgUse).toHaveBeenCalledWith({
			userId: "user-a",
			organizationId: "org-a",
			enabled: true,
		});
		expect(state.audit.mock.calls.map(([row]) => row.action)).toEqual([
			"account.chatgpt_plan.connected",
			"account.chatgpt_plan.organization_use_changed",
		]);
		const [connected, used] = state.audit.mock.calls.map(([row]) => row);
		expect(connected.metadata).toEqual({ emailDomain: "example.com" });
		expect(used).toMatchObject({
			organizationId: "org-a",
			metadata: { enabled: true, includeBackgroundJobs: false },
		});
		expect(JSON.stringify(state.audit.mock.calls)).not.toContain(ACCESS);
		const body = await response.json();
		expect(body.organizations).toEqual([
			{ slug: "org-a-slug", name: "org-a", enabled: true },
			{ slug: "org-b-slug", name: "org-b", enabled: false },
		]);
	});

	it("keeps the ticket when the upload is malformed, and never echoes the body", async () => {
		const { ticket } = await createChatGptPlanUploadTicket({
			userId: "user-a",
			organizationIds: ["org-a"],
		});
		const bad = await post(ticket, upload({ expiresIn: "soon" }));
		expect(bad.status).toBe(400);
		expect(await bad.text()).not.toContain(ACCESS);
		expect((await post(ticket)).status).toBe(200);
	});

	it("refuses a ticket whose organizations have all lost the flag, storing nothing", async () => {
		const { ticket } = await createChatGptPlanUploadTicket({
			userId: "user-a",
			organizationIds: ["org-c"],
		});
		const response = await post(ticket);
		expect(response.status).toBe(403);
		expect(await response.text()).toContain("isn't enabled");
		expect(state.upsert).not.toHaveBeenCalled();
		expect(state.setOrgUse).not.toHaveBeenCalled();
	});

	it("never stores a ticket in a readable form", async () => {
		const { ticket } = await createChatGptPlanUploadTicket({
			userId: "user-a",
			organizationIds: ["org-a"],
		});
		expect(JSON.stringify(state.rows)).not.toContain(ticket);
	});
});
