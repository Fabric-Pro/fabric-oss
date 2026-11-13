import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (args: {
	input: Record<string, unknown>;
	context: Record<string, unknown>;
}) => Promise<unknown>;
type Middleware = (
	options: { context: Record<string, unknown>; next: () => Promise<unknown> },
	input: unknown,
) => Promise<unknown>;

const mocks = vi.hoisted(() => ({
	createAiChat: vi.fn(),
	createChatDocument: vi.fn(),
	getAiChatByIdForOwner: vi.fn(),
	getOrganizationMembership: vi.fn(),
	handler: null as Handler | null,
	handlerCalls: 0,
	middleware: null as Middleware | null,
	verifyOrganizationMembership: vi.fn(),
}));

vi.mock("@repo/config", () => ({
	config: { storage: { bucketNames: { chatDocuments: "chat-documents" } } },
}));
vi.mock("@repo/database", () => ({
	createAiChat: mocks.createAiChat,
	createChatDocument: mocks.createChatDocument,
	db: {
		member: { findFirst: vi.fn(), findUnique: vi.fn() },
		project: { findUnique: vi.fn() },
		projectMember: { findUnique: vi.fn() },
	},
	getAiChatByIdForOwner: mocks.getAiChatByIdForOwner,
	getOrganizationMembership: mocks.getOrganizationMembership,
	getTenantContext: () => ({ effectiveWriteOrgId: undefined }),
	grantProjectAccess: vi.fn(),
}));
vi.mock("@repo/storage", () => ({
	getStorageProvider: () => ({
		supportsPresignedUrls: false,
		type: "vercel-blob",
	}),
}));
vi.mock("../../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: mocks.verifyOrganizationMembership,
}));
vi.mock("../../../../../orpc/procedures", async () => {
	const permission = await import(
		"../../../../../orpc/middleware/require-permission"
	);
	const { Permissions } = await import("@repo/permissions");
	const chain: Record<string, unknown> = {
		use: (middleware: Middleware) => {
			mocks.middleware = middleware;
			return chain;
		},
		route: () => chain,
		input: () => chain,
		output: () => chain,
		handler: (handler: Handler) => {
			mocks.handler = async (args) => {
				mocks.handlerCalls += 1;
				return handler(args);
			};
			return chain;
		},
	};
	return {
		authorizeInputOrganization: permission.authorizeInputOrganization,
		Permissions,
		requireInputOrgPermission: permission.requireInputOrgPermission,
		requirePermission: permission.requirePermission,
		resolveOrganizationId: (
			input: string | null | undefined,
			session: { activeOrganizationId?: string | null },
		) =>
			(input === undefined ? session.activeOrganizationId : input) ??
			undefined,
		tenantProtectedProcedure: chain,
	};
});

await import("../create-upload-url");

const USER_ID = "example-user";
const ORG_A = "example-org-a";
const ORG_B = "example-org-b";
const context = {
	user: { id: USER_ID },
	session: { activeOrganizationId: ORG_A },
	activeOrganizationRole: "owner",
	tenantContext: {
		userId: USER_ID,
		type: "organization",
		organizationId: ORG_A,
	},
};
const input = {
	organizationId: ORG_B,
	filename: "example.pdf",
	mimeType: "application/pdf",
	size: 128,
};

async function invoke(
	overrides: Record<string, unknown> = {},
	callContext: Record<string, unknown> = context,
) {
	if (!mocks.middleware || !mocks.handler) {
		throw new Error("create-upload-url procedure was not captured");
	}
	const request = { ...input, ...overrides };
	const handler = mocks.handler;
	const result = await mocks.middleware(
		{
			context: callContext,
			next: async () => ({
				output: await handler({ input: request, context: callContext }),
			}),
		},
		request,
	);
	return (result as { output: unknown }).output;
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.handlerCalls = 0;
	mocks.getOrganizationMembership.mockResolvedValue({
		role: "owner",
		organization: { deletedAt: null },
	});
	mocks.verifyOrganizationMembership.mockResolvedValue({ role: "owner" });
	mocks.getAiChatByIdForOwner.mockResolvedValue(null);
	mocks.createAiChat.mockResolvedValue({
		id: "example-chat",
		organizationId: ORG_B,
		userId: USER_ID,
	});
	mocks.createChatDocument.mockResolvedValue({ id: "example-document" });
	vi.spyOn(console, "log").mockImplementation(() => undefined);
});

describe("ai.documents.createUploadUrl target organization authorization", () => {
	it("refuses a session-org owner with no membership in the named organization before reading or creating a chat", async () => {
		mocks.getOrganizationMembership.mockResolvedValue(null);

		await expect(invoke()).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.getOrganizationMembership).toHaveBeenCalledWith(
			ORG_B,
			USER_ID,
		);
		expect(mocks.getAiChatByIdForOwner).not.toHaveBeenCalled();
		expect(mocks.createAiChat).not.toHaveBeenCalled();
		expect(mocks.createChatDocument).not.toHaveBeenCalled();
		expect(mocks.handlerCalls).toBe(0);
	});

	it("refuses a missing organization before reading or creating a chat", async () => {
		await expect(invoke({ organizationId: null })).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: "This operation requires an organization context",
		});
		expect(mocks.getAiChatByIdForOwner).not.toHaveBeenCalled();
		expect(mocks.createAiChat).not.toHaveBeenCalled();
	});

	it("keeps the existing membership refusal immediately before auto-creating a chat", async () => {
		mocks.verifyOrganizationMembership.mockResolvedValue(null);

		await expect(invoke()).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: "Not a member of this organization",
		});
		expect(mocks.verifyOrganizationMembership).toHaveBeenCalledWith(
			ORG_B,
			USER_ID,
		);
		expect(mocks.createAiChat).not.toHaveBeenCalled();
		expect(mocks.createChatDocument).not.toHaveBeenCalled();
	});

	it("refuses an existing-chat viewer who has membership but lacks AI_CHAT", async () => {
		const orgBContext = {
			...context,
			session: { activeOrganizationId: ORG_B },
			activeOrganizationRole: "member",
			tenantContext: {
				userId: USER_ID,
				type: "organization",
				organizationId: ORG_B,
			},
		};
		mocks.getAiChatByIdForOwner.mockResolvedValue({
			id: "example-chat-a",
			organizationId: ORG_A,
			userId: USER_ID,
		});
		mocks.verifyOrganizationMembership.mockResolvedValue({
			role: "viewer",
		});
		mocks.getOrganizationMembership.mockImplementation(
			async (organizationId: string) => ({
				role: organizationId === ORG_A ? "viewer" : "member",
				organization: { deletedAt: null },
			}),
		);

		await expect(
			invoke({ chatId: "example-chat-a" }, orgBContext),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.createAiChat).not.toHaveBeenCalled();
		expect(mocks.createChatDocument).not.toHaveBeenCalled();
	});

	it("checks AI_CHAT in an existing chat's organization before creating its document", async () => {
		mocks.getAiChatByIdForOwner.mockResolvedValue({
			id: "example-chat-a",
			organizationId: ORG_A,
			userId: USER_ID,
		});
		mocks.getOrganizationMembership.mockImplementation(
			async (organizationId: string) =>
				organizationId === ORG_B
					? { role: "owner", organization: { deletedAt: null } }
					: null,
		);

		await expect(
			invoke({ chatId: "example-chat-a" }),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(mocks.getOrganizationMembership).toHaveBeenNthCalledWith(
			1,
			ORG_B,
			USER_ID,
		);
		expect(mocks.getOrganizationMembership).toHaveBeenNthCalledWith(
			2,
			ORG_A,
			USER_ID,
		);
		expect(mocks.createAiChat).not.toHaveBeenCalled();
		expect(mocks.createChatDocument).not.toHaveBeenCalled();
	});

	it("creates the chat and document for an authorized target-org caller", async () => {
		await expect(invoke()).resolves.toMatchObject({
			chatId: "example-chat",
			useServerUpload: true,
		});
		expect(mocks.createAiChat).toHaveBeenCalledWith({
			userId: USER_ID,
			organizationId: ORG_B,
			title: "Document Upload",
		});
		expect(mocks.createChatDocument).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: ORG_B }),
		);
	});
});
