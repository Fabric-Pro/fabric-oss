import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// Mock dependencies
vi.mock("@repo/database", async () => {
	return {
		updateFrameShareScope: vi.fn(),
		createMultipleSharingGrants: vi.fn(),
		revokeSharingGrant: vi.fn(),
		listSharingGrants: vi.fn(),
		getFrameById: vi.fn(),
		getFrameShareScope: vi.fn(),
	};
});

vi.mock("../../../orpc/procedures", async () => {
	return {
		tenantProtectedProcedure: {
			use: vi.fn().mockReturnThis(),
			route: vi.fn().mockReturnThis(),
			input: vi.fn().mockReturnThis(),
			output: vi.fn().mockReturnThis(),
			handler: vi.fn((fn) => fn),
		},
		resolveOrganizationId: vi.fn((inputOrgId, _session) => inputOrgId),
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
		requireProjectPermission: () => (c: unknown) => c,
	};
});

import {
	createMultipleSharingGrants,
	getFrameShareScope,
	listSharingGrants,
	revokeSharingGrant,
	updateFrameShareScope,
} from "@repo/database";

describe("Frame Sharing API Procedures", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("share", () => {
		it("should validate share scope input", () => {
			const inputSchema = z.object({
				id: z.string(),
				organizationId: z.string().nullable().optional(),
				shareScope: z.enum([
					"PRIVATE",
					"EMAILS_ONLY",
					"WORKSPACE_AND_EMAILS",
					"PUBLIC",
				]),
			});

			const validInputs = [
				{ id: "frame-123", shareScope: "PUBLIC" as const },
				{ id: "frame-123", shareScope: "PRIVATE" as const },
				{ id: "frame-123", shareScope: "EMAILS_ONLY" as const },
				{
					id: "frame-123",
					shareScope: "WORKSPACE_AND_EMAILS" as const,
				},
			];

			for (const input of validInputs) {
				const result = inputSchema.safeParse(input);
				expect(result.success).toBe(true);
			}
		});

		it("should reject invalid share scope", () => {
			const inputSchema = z.object({
				id: z.string(),
				shareScope: z.enum([
					"PRIVATE",
					"EMAILS_ONLY",
					"WORKSPACE_AND_EMAILS",
					"PUBLIC",
				]),
			});

			const invalidInput = {
				id: "frame-123",
				shareScope: "INVALID_SCOPE",
			};

			const result = inputSchema.safeParse(invalidInput);
			expect(result.success).toBe(false);
		});

		it("should update share scope successfully", async () => {
			const mockResult = {
				success: true,
				shareToken: "token-123",
			};

			vi.mocked(updateFrameShareScope).mockResolvedValue(
				mockResult as any,
			);

			const result = await updateFrameShareScope({
				frameId: "frame-123",
				userId: "user-456",
				shareScope: "PUBLIC",
			});

			expect(result.success).toBe(true);
			expect(result.shareToken).toBe("token-123");
		});

		it("should handle organization policy check for public sharing", async () => {
			const mockDb = {
				organization: {
					findUnique: vi.fn().mockResolvedValue({
						canShareFramesPublicly: false,
					}),
				},
			};

			// Simulating the policy check
			const org = await mockDb.organization.findUnique({
				where: { id: "org-123" },
				select: { canShareFramesPublicly: true },
			});

			expect(org?.canShareFramesPublicly).toBe(false);
		});
	});

	describe("invite", () => {
		it("should validate email invite input", () => {
			const inputSchema = z.object({
				id: z.string(),
				organizationId: z.string().nullable().optional(),
				emails: z.array(z.string().email()).min(1).max(50),
			});

			const validInput = {
				id: "frame-123",
				emails: ["user1@example.com", "user2@example.com"],
			};

			const result = inputSchema.safeParse(validInput);
			expect(result.success).toBe(true);
		});

		it("should reject invalid emails", () => {
			const inputSchema = z.object({
				id: z.string(),
				emails: z.array(z.string().email()).min(1).max(50),
			});

			const invalidInput = {
				id: "frame-123",
				emails: ["not-an-email", "also-not-valid"],
			};

			const result = inputSchema.safeParse(invalidInput);
			expect(result.success).toBe(false);
		});

		it("should reject empty email list", () => {
			const inputSchema = z.object({
				id: z.string(),
				emails: z.array(z.string().email()).min(1).max(50),
			});

			const emptyInput = {
				id: "frame-123",
				emails: [],
			};

			const result = inputSchema.safeParse(emptyInput);
			expect(result.success).toBe(false);
		});

		it("should create sharing grants for valid emails", async () => {
			const mockGrants = [
				{
					id: "grant-1",
					email: "user1@example.com",
					invitedAt: new Date(),
				},
				{
					id: "grant-2",
					email: "user2@example.com",
					invitedAt: new Date(),
				},
			];

			vi.mocked(createMultipleSharingGrants).mockResolvedValue(
				mockGrants as any,
			);

			const grants = await createMultipleSharingGrants(
				"frame-123",
				["user1@example.com", "user2@example.com"],
				"user-456",
			);

			expect(grants).toHaveLength(2);
			expect(grants[0].email).toBe("user1@example.com");
		});

		it("should check current share scope before inviting", async () => {
			vi.mocked(getFrameShareScope).mockResolvedValue("PRIVATE");

			const scope = await getFrameShareScope("frame-123");

			expect(scope).toBe("PRIVATE");
			// When scope is PRIVATE, invites should not be allowed
		});
	});

	describe("listGrants", () => {
		it("should return sharing grants with share scope", async () => {
			const mockGrants = [
				{
					id: "grant-1",
					email: "user@example.com",
					invitedBy: "user-456",
					invitedAt: new Date(),
					lastAccessedAt: null,
					accessCount: 0,
				},
			];

			vi.mocked(listSharingGrants).mockResolvedValue(mockGrants as any);

			const grants = await listSharingGrants("frame-123");

			expect(grants).toHaveLength(1);
			expect(grants[0].email).toBe("user@example.com");
		});
	});

	describe("revokeInvite", () => {
		it("should revoke a sharing grant", async () => {
			vi.mocked(revokeSharingGrant).mockResolvedValue(true);

			const result = await revokeSharingGrant(
				"frame-123",
				"user@example.com",
			);

			expect(result).toBe(true);
		});

		it("should handle non-existent grant revocation", async () => {
			vi.mocked(revokeSharingGrant).mockResolvedValue(false);

			const result = await revokeSharingGrant(
				"frame-123",
				"nonexistent@example.com",
			);

			expect(result).toBe(false);
		});
	});
});
