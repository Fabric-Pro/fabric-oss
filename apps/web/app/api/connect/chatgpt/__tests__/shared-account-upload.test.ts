/**
 * `POST /api/connect/chatgpt/credentials` with a shared-account ticket
 * (Fizzy #2770): the ticket alone names the organization; the connector's
 * role and both flags are checked again at upload; a ChatGPT account serves
 * one organization and never doubles as the connector's own plan; nothing
 * but the email comes back.
 *
 * The real ticket module runs against an in-memory `verification` table.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = { id: string; identifier: string; value: string; expiresAt: Date };

const state = vi.hoisted(() => ({
	rows: [] as Row[],
	findAdminOrganization: vi.fn(),
	personalSubjects: new Set<string>(),
	personalEmails: new Set<string>(),
	sharedEmails: new Set<string>(),
	listAccounts: vi.fn(),
	upsertAccount: vi.fn(),
	upsertOwn: vi.fn(),
	sharedSubjects: new Set<string>(),
	personalOwner: "user-other" as string,
	sharedConnector: "user-other" as string,
	setOrgUse: vi.fn(),
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

vi.mock("@repo/database", async () => {
	class ChatGptPlanSubjectBoundElsewhereError extends Error {
		constructor() {
			super(
				"This ChatGPT account is already connected to another organization",
			);
		}
	}
	return {
		...(await vi.importActual<
			typeof import("@repo/database/prisma/queries/chatgpt-plan-upload-ticket")
		>("@repo/database/prisma/queries/chatgpt-plan-upload-ticket")),
		ChatGptPlanSubjectBoundElsewhereError,
		findChatGptPlanPoolAdminOrganization: state.findAdminOrganization,
		findChatGptPlanPersonalAccountOwner: async (identity: {
			subject: string;
			email: string | null;
		}) =>
			state.personalSubjects.has(identity.subject) ||
			state.personalEmails.has(identity.email?.toLowerCase() ?? "")
				? state.personalOwner
				: null,
		listChatGptPlanOrgAccounts: state.listAccounts,
		upsertChatGptPlanOrgAccount: state.upsertAccount,
		upsertChatGptPlanCredential: state.upsertOwn,
		setChatGptPlanOrgUse: state.setOrgUse,
		listChatGptPlanOrganizations: vi.fn(async () => [
			{
				id: "org-a",
				slug: "example-org",
				name: "Example Org",
				enabled: false,
				answered: false,
				includeBackgroundJobs: false,
			},
		]),
		findChatGptPlanSharedAccountConnector: async (identity: {
			subject: string;
			email: string | null;
		}) =>
			state.sharedSubjects.has(identity.subject) ||
			state.sharedEmails.has(identity.email?.toLowerCase() ?? "")
				? state.sharedConnector
				: null,
		recordAudit: state.audit,
	};
});

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
const { ChatGptPlanSubjectBoundElsewhereError } = await import(
	"@repo/database"
);
const { POST } = await import("../credentials/route");

const ACCESS = "access-token-secret-value";
const REFRESH = "refresh-token-secret-value";

function upload() {
	return {
		accessToken: ACCESS,
		refreshToken: REFRESH,
		idToken: "header.payload.signature",
		expiresIn: 3600,
		scopes: ["openid", "offline_access", "chatgpt.tokens.use.direct"],
		clientId: "oaiapp_example",
		hostId: "urn:uuid:00000000-0000-0000-0000-000000000001",
	};
}

function post(ticket: string) {
	return POST(
		new Request("http://localhost/api/connect/chatgpt/credentials", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${ticket}`,
			},
			body: JSON.stringify(upload()),
		}),
	);
}

const orgTicket = async () =>
	(
		await createChatGptPlanUploadTicket({
			kind: "org",
			userId: "user-admin",
			organizationId: "org-a",
		})
	).ticket;

beforeEach(() => {
	vi.clearAllMocks();
	state.rows = [];
	state.sharedSubjects = new Set();
	state.personalEmails = new Set();
	state.sharedEmails = new Set();
	state.findAdminOrganization.mockResolvedValue({
		id: "org-a",
		slug: "example-org",
		name: "Example Org",
		role: "admin",
	});
	state.personalSubjects = new Set(["admins-own-subject"]);
	state.personalOwner = "user-other";
	state.sharedConnector = "user-other";
	state.listAccounts.mockResolvedValue([]);
	state.upsertAccount.mockResolvedValue({ id: "acc-1", created: true });
	state.verifyIdToken.mockResolvedValue({
		iss: "https://auth.openai.com",
		aud: "oaiapp_example",
		sub: "shared-subject",
		iat: 1,
		exp: 2,
		email: "shared-plan@example.com",
	});
});

describe("POST /api/connect/chatgpt/credentials, shared account", () => {
	it("stores the account for the ticket's organization, connected by the approving admin", async () => {
		const response = await post(await orgTicket());
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toEqual({
			connected: true,
			email: "shared-plan@example.com",
			shared: {
				organization: { slug: "example-org", name: "Example Org" },
				created: true,
			},
		});
		expect(JSON.stringify(body)).not.toContain(ACCESS);
		expect(JSON.stringify(body)).not.toContain(REFRESH);

		expect(state.findAdminOrganization).toHaveBeenCalledWith({
			userId: "user-admin",
			organizationId: "org-a",
		});
		expect(state.upsertAccount).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "org-a",
				connectedByUserId: "user-admin",
				label: "ChatGPT plan 1",
				subject: "shared-subject",
				encryptedAccessToken: `encrypted(${ACCESS.length})`,
			}),
		);
		// A shared account never touches anyone's own plan.
		expect(state.upsertOwn).not.toHaveBeenCalled();
		expect(state.setOrgUse).not.toHaveBeenCalled();
		expect(state.audit).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "org.chatgpt_plan.account_connected",
				organizationId: "org-a",
				metadata: { emailDomain: "example.com", reconnected: false },
			}),
		);
		expect(JSON.stringify(state.audit.mock.calls)).not.toContain(
			"shared-plan@",
		);
	});

	it("refuses once the admin role or a flag is gone, and spends the ticket", async () => {
		state.findAdminOrganization.mockResolvedValue(null);
		const ticket = await orgTicket();
		expect((await post(ticket)).status).toBe(403);
		expect(state.upsertAccount).not.toHaveBeenCalled();
		expect((await post(ticket)).status).toBe(401);
	});

	it("refuses an account another organization already has", async () => {
		state.upsertAccount.mockRejectedValue(
			new ChatGptPlanSubjectBoundElsewhereError(),
		);
		const response = await post(await orgTicket());
		expect(response.status).toBe(409);
		expect(state.audit).not.toHaveBeenCalled();
	});

	// Fizzy #2770 I1: their own plan moves without a new sign-in.
	it("refuses the connector's own plan as a shared account, pointing to Share", async () => {
		state.personalSubjects.add("shared-subject");
		state.personalOwner = "user-admin";
		const response = await post(await orgTicket());
		expect(response.status).toBe(409);
		expect((await response.json()).error).toMatch(
			/already your own plan.*Share with this organization/,
		);
		expect(state.upsertAccount).not.toHaveBeenCalled();
	});

	it("refuses an account another member holds as their own plan, without naming them", async () => {
		// Any user's credential, not only the connecting admin's.
		state.personalSubjects = new Set(["shared-subject"]);
		const response = await post(await orgTicket());
		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body.error).toMatch(/someone's own plan/);
		expect(JSON.stringify(body)).not.toMatch(/user-|@example\.com/);
		expect(state.upsertAccount).not.toHaveBeenCalled();
	});

	it("rejects an organization ticket that names no organization", async () => {
		const { ticket } = await createChatGptPlanUploadTicket({
			kind: "org",
			userId: "user-admin",
		} as never);
		expect((await post(ticket)).status).toBe(401);
		expect(state.findAdminOrganization).not.toHaveBeenCalled();
	});

	it("refuses a personal connect of an account an organization already shares", async () => {
		state.sharedSubjects.add("shared-subject");
		const { ticket } = await createChatGptPlanUploadTicket({
			userId: "user-member",
			organizationIds: ["org-a"],
		});
		const response = await post(ticket);
		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body.error).toMatch(/already shared by an organization/);
		expect(body.error).not.toMatch(/Take back/);
		expect(state.upsertOwn).not.toHaveBeenCalled();
	});

	it("points the member who shared the account to Take back instead", async () => {
		state.sharedSubjects.add("shared-subject");
		state.sharedConnector = "user-member";
		const { ticket } = await createChatGptPlanUploadTicket({
			userId: "user-member",
			organizationIds: ["org-a"],
		});
		const response = await post(ticket);
		expect(response.status).toBe(409);
		expect((await response.json()).error).toMatch(
			/You already share this ChatGPT account.*Take back/,
		);
		expect(state.upsertOwn).not.toHaveBeenCalled();
	});

	// Fizzy #2770: OpenAI's `sub` differs per client registration, so the same
	// ChatGPT account arrives with a new one; its email gives it away.
	it("refuses a shared account whose email someone holds as their own plan, under another sub", async () => {
		state.personalEmails.add("shared-plan@example.com");
		const response = await post(await orgTicket());
		expect(response.status).toBe(409);
		expect(state.upsertAccount).not.toHaveBeenCalled();
	});

	it("refuses a personal connect whose email an organization already shares, under another sub", async () => {
		state.sharedEmails.add("shared-plan@example.com");
		const { ticket } = await createChatGptPlanUploadTicket({
			userId: "user-member",
			organizationIds: ["org-a"],
		});
		const response = await post(ticket);
		expect(response.status).toBe(409);
		expect(JSON.stringify(await response.json())).not.toContain("org-a");
		expect(state.upsertOwn).not.toHaveBeenCalled();
	});
});
