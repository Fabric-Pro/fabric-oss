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
import { verifyOrganizationMembership } from "../../../organizations/lib/membership";
import { requestConnectionInputSchema } from "../request-connection";

const decode = (mailto: string) => {
	const url = new URL(mailto);
	return {
		to: decodeURIComponent(url.pathname),
		subject: url.searchParams.get("subject"),
		body: url.searchParams.get("body"),
	};
};

describe("requestConnectionProcedure", () => {
	const mockUser = {
		id: "user-1",
		name: "Alex Developer",
		email: "alex@example.com",
	};

	beforeEach(() => {
		vi.clearAllMocks();
		config.support.email = "support@example.com";
		vi.mocked(verifyOrganizationMembership).mockResolvedValue({
			organization: { id: "org-1", name: "Example Organization" } as any,
			role: "member",
		});
	});

	it("returns a mailto to support@example.com with subject and body containing details", async () => {
		const result = (await handlers.requestConnection({
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
		})) as { mailto: string };

		const decoded = decode(result.mailto);
		expect(decoded.to).toBe("support@example.com");
		expect(decoded.subject).toBe("Connection request: Custom Postgres MCP");
		expect(decoded.body).toContain(
			"Requested by: Alex Developer <alex@example.com>",
		);
		expect(decoded.body).toContain("Organization: Example Organization");
		expect(decoded.body).toContain("Type: MCP");
		expect(decoded.body).toContain("Name: Custom Postgres MCP");
		expect(decoded.body).toContain(
			"Need internal database querying capability",
		);
	});

	it("formats '(none)' when notes are omitted", async () => {
		const result = (await handlers.requestConnection({
			input: {
				type: "integration",
				name: "Linear",
				organizationId: "org-1",
			},
			context: {
				user: mockUser,
				session: { activeOrganizationId: "org-1" },
			},
		})) as { mailto: string };

		const decoded = decode(result.mailto);
		expect(decoded.subject).toBe("Connection request: Linear");
		expect(decoded.body).toContain("Notes:\r\n(none)");
	});

	it("sanitizes any line breaks or control characters in user.name and organization name", async () => {
		vi.mocked(verifyOrganizationMembership).mockResolvedValueOnce({
			organization: {
				id: "org-1",
				name: "Example\u2028Organization\nCorp",
			} as any,
			role: "member",
		});

		const result = (await handlers.requestConnection({
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
		})) as { mailto: string };

		const decoded = decode(result.mailto);
		expect(decoded.body).toContain(
			"Requested by: Alex Developer Staff Lead <alex@example.com>",
		);
		expect(decoded.body).toContain(
			"Organization: Example Organization Corp",
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

	it("rejects when the user is not a member of the organization", async () => {
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
	});

	it("returns { mailto: null } when support email is missing", async () => {
		config.support.email = "";

		const result = await handlers.requestConnection({
			input: {
				type: "mcp",
				name: "Redis MCP",
				organizationId: "org-1",
			},
			context: {
				user: mockUser,
				session: { activeOrganizationId: "org-1" },
			},
		});

		expect(result).toEqual({ mailto: null });
	});

	it("shortens notes that would make the draft too long", async () => {
		const result = (await handlers.requestConnection({
			input: {
				type: "mcp",
				name: "Postgres MCP",
				notes: "é".repeat(1000),
				organizationId: "org-1",
			},
			context: {
				user: mockUser,
				session: { activeOrganizationId: "org-1" },
			},
		})) as { mailto: string };

		expect(result.mailto.length).toBeLessThanOrEqual(1800);
		const { body } = decode(result.mailto);
		expect(body).toContain(
			"Requested by: Alex Developer <alex@example.com>",
		);
		expect(body).toContain("Organization: Example Organization");
		expect(body).toContain("…");
	});

	it("does not split an emoji when shortening notes", async () => {
		const result = (await handlers.requestConnection({
			input: {
				type: "mcp",
				name: "Postgres MCP",
				notes: "😀".repeat(500),
				organizationId: "org-1",
			},
			context: {
				user: mockUser,
				session: { activeOrganizationId: "org-1" },
			},
		})) as { mailto: string };

		expect(result.mailto.length).toBeLessThanOrEqual(1800);
		expect(decode(result.mailto).body).toContain("Requested by:");
	});
});
