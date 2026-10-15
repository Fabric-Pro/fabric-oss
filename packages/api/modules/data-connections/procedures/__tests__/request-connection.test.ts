import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	return { handlers };
});

vi.mock("@repo/config", () => ({
	config: {
		support: {
			email: "support@example.com",
		},
	},
}));

vi.mock("@repo/mail", () => ({
	isMailConfigured: vi.fn().mockReturnValue(true),
	sendEmail: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../../../lib/rate-limit", () => ({
	checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock("../../../../orpc/procedures", () => {
	const chainable: any = {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.requestConnection = fn;
			return { _handler: fn };
		},
	};

	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireInputOrgPermission: () => (c: unknown) => c,
		resolveOrganizationId: vi.fn(
			(organizationId: string | null) => organizationId,
		),
	};
});

vi.mock("../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: vi.fn().mockResolvedValue({
		organization: { id: "org-1", name: "Example Organization" },
		role: "member",
	}),
}));

import { config } from "@repo/config";
import { isMailConfigured, sendEmail } from "@repo/mail";
import { checkRateLimit } from "../../../../lib/rate-limit";
import { verifyOrganizationMembership } from "../../../organizations/lib/membership";
import { requestConnectionInputSchema } from "../request-connection";

describe("requestConnectionProcedure", () => {
	const mockUser = {
		id: "user-1",
		name: "Alex Developer",
		email: "alex@example.com",
	};

	beforeEach(() => {
		vi.clearAllMocks();
		config.support.email = "support@example.com";
		vi.mocked(isMailConfigured).mockReturnValue(true);
		vi.mocked(sendEmail).mockResolvedValue(true);
		vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as any);
		vi.mocked(verifyOrganizationMembership).mockResolvedValue({
			organization: { id: "org-1", name: "Example Organization" } as any,
			role: "member",
		});
	});

	it("sends request email with user details and organization name on valid submission", async () => {
		const result = await handlers.requestConnection({
			input: {
				type: "mcp",
				name: "Custom Postgres MCP",
				notes: "Need internal database querying capability",
				organizationId: "org-1",
			},
			context: {
				user: mockUser,
				session: { activeOrganizationId: "org-1" },
			},
		});

		expect(result).toEqual({ success: true });
		expect(sendEmail).toHaveBeenCalledWith({
			to: "support@example.com",
			replyTo: "alex@example.com",
			subject: "Connection request: Custom Postgres MCP",
			text: [
				"Requested by: Alex Developer <alex@example.com>",
				"Organization: Example Organization",
				"Type: MCP",
				"Name: Custom Postgres MCP",
				"",
				"--- Notes (written by the requester) ---",
				"Need internal database querying capability",
			].join("\n"),
		});
	});

	it("formats '(none)' when notes are omitted", async () => {
		await handlers.requestConnection({
			input: {
				type: "integration",
				name: "Linear",
				organizationId: "org-1",
			},
			context: {
				user: mockUser,
				session: { activeOrganizationId: "org-1" },
			},
		});

		expect(sendEmail).toHaveBeenCalledWith(
			expect.objectContaining({
				subject: "Connection request: Linear",
				text: expect.stringContaining(
					["--- Notes (written by the requester) ---", "(none)"].join(
						"\n",
					),
				),
			}),
		);
	});

	it("sanitizes any line breaks or control characters in user.name and organization name", async () => {
		vi.mocked(verifyOrganizationMembership).mockResolvedValueOnce({
			organization: {
				id: "org-1",
				name: "Example\u2028Organization\nCorp",
			} as any,
			role: "member",
		});

		await handlers.requestConnection({
			input: {
				type: "mcp",
				name: "Postgres MCP",
				organizationId: "org-1",
			},
			context: {
				user: {
					...mockUser,
					name: "Alex\nDeveloper\r\nStaff\u2029Lead",
				},
				session: { activeOrganizationId: "org-1" },
			},
		});

		expect(sendEmail).toHaveBeenCalledWith(
			expect.objectContaining({
				text: expect.stringContaining(
					"Requested by: Alex Developer Staff Lead <alex@example.com>\nOrganization: Example Organization Corp",
				),
			}),
		);
	});

	it("rejects a name containing line breaks at the schema validation boundary", () => {
		const withNewline = requestConnectionInputSchema.safeParse({
			type: "mcp",
			name: "Postgres\nInjected",
			organizationId: "org-1",
		});
		expect(withNewline.success).toBe(false);

		const withCarriageReturn = requestConnectionInputSchema.safeParse({
			type: "mcp",
			name: "Postgres\rInjected",
			organizationId: "org-1",
		});
		expect(withCarriageReturn.success).toBe(false);

		const withUnicodeLineSeparator = requestConnectionInputSchema.safeParse(
			{
				type: "mcp",
				name: "Postgres\u2028Injected",
				organizationId: "org-1",
			},
		);
		expect(withUnicodeLineSeparator.success).toBe(false);

		const withTab = requestConnectionInputSchema.safeParse({
			type: "mcp",
			name: "Postgres\tMCP",
			organizationId: "org-1",
		});
		expect(withTab.success).toBe(false);

		const validSingleLine = requestConnectionInputSchema.safeParse({
			type: "mcp",
			name: "Postgres MCP",
			organizationId: "org-1",
		});
		expect(validSingleLine.success).toBe(true);
	});

	it("rejects when the user is not a member of the organization without reaching rate limit or email", async () => {
		vi.mocked(verifyOrganizationMembership).mockResolvedValueOnce(null);

		await expect(
			handlers.requestConnection({
				input: {
					type: "unsure",
					name: "Internal Tool",
					organizationId: "org-1",
				},
				context: {
					user: mockUser,
					session: { activeOrganizationId: "org-1" },
				},
			}),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: "You are not a member of this organization",
		});

		expect(checkRateLimit).not.toHaveBeenCalled();
		expect(sendEmail).not.toHaveBeenCalled();
	});

	it("rejects with PRECONDITION_FAILED when support email is missing", async () => {
		config.support.email = "";

		await expect(
			handlers.requestConnection({
				input: {
					type: "mcp",
					name: "Redis MCP",
					organizationId: "org-1",
				},
				context: {
					user: mockUser,
					session: { activeOrganizationId: "org-1" },
				},
			}),
		).rejects.toMatchObject({
			code: "PRECONDITION_FAILED",
			message: "Connection requests are not available",
		});

		expect(sendEmail).not.toHaveBeenCalled();
	});

	it("rejects with PRECONDITION_FAILED when mail provider is not configured", async () => {
		vi.mocked(isMailConfigured).mockReturnValueOnce(false);

		await expect(
			handlers.requestConnection({
				input: {
					type: "mcp",
					name: "Redis MCP",
					organizationId: "org-1",
				},
				context: {
					user: mockUser,
					session: { activeOrganizationId: "org-1" },
				},
			}),
		).rejects.toMatchObject({
			code: "PRECONDITION_FAILED",
			message: "Connection requests are not available",
		});

		expect(sendEmail).not.toHaveBeenCalled();
	});

	it("rejects when rate limit is exceeded", async () => {
		vi.mocked(checkRateLimit).mockResolvedValueOnce({
			allowed: false,
			statusCode: 429,
		} as any);

		await expect(
			handlers.requestConnection({
				input: {
					type: "mcp",
					name: "Redis MCP",
					organizationId: "org-1",
				},
				context: {
					user: mockUser,
					session: { activeOrganizationId: "org-1" },
				},
			}),
		).rejects.toMatchObject({
			code: "TOO_MANY_REQUESTS",
			message: "Too many requests. Please try again later.",
		});

		expect(sendEmail).not.toHaveBeenCalled();
	});

	it("rejects with SERVICE_UNAVAILABLE when rate limit service returns 503", async () => {
		vi.mocked(checkRateLimit).mockResolvedValueOnce({
			allowed: false,
			statusCode: 503,
		} as any);

		await expect(
			handlers.requestConnection({
				input: {
					type: "mcp",
					name: "Redis MCP",
					organizationId: "org-1",
				},
				context: {
					user: mockUser,
					session: { activeOrganizationId: "org-1" },
				},
			}),
		).rejects.toMatchObject({
			code: "SERVICE_UNAVAILABLE",
			message:
				"Requests are temporarily unavailable. Please try again later.",
		});

		expect(sendEmail).not.toHaveBeenCalled();
	});

	it("throws INTERNAL_SERVER_ERROR when sendEmail returns false", async () => {
		vi.mocked(sendEmail).mockResolvedValueOnce(false);

		await expect(
			handlers.requestConnection({
				input: {
					type: "mcp",
					name: "Redis MCP",
					organizationId: "org-1",
				},
				context: {
					user: mockUser,
					session: { activeOrganizationId: "org-1" },
				},
			}),
		).rejects.toMatchObject({
			code: "INTERNAL_SERVER_ERROR",
			message: "The request could not be sent",
		});
	});
});
