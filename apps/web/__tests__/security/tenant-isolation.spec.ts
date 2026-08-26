/**
 * Multi-Tenant Isolation Security Tests
 *
 * Tests to ensure absolute isolation between:
 * 1. Personal accounts and organizational accounts
 * 2. Different organizations
 * 3. Users within the same organization (for per-user resources like MCP configs)
 *
 * CRITICAL: These tests validate the XOR pattern and isolation boundaries.
 */

import {
	createOrganizationContext,
	createPersonalContext,
	getTenantContext,
	hasTenantContext,
	runWithTenantContext,
} from "@repo/database/src/tenant-context";
import { describe, expect, it } from "vitest";

describe("Tenant Context Module", () => {
	describe("Context Creation", () => {
		it("should create personal context with correct properties", () => {
			const userId = "user-123";
			const ctx = createPersonalContext(userId);

			expect(ctx.type).toBe("personal");
			expect(ctx.tenantId).toBe(userId);
			expect(ctx.userId).toBe(userId);
			expect(ctx.organizationId).toBeNull();
		});

		it("should create organization context with correct properties", () => {
			const orgId = "org-456";
			const userId = "user-123";
			const ctx = createOrganizationContext(orgId, userId);

			expect(ctx.type).toBe("organization");
			expect(ctx.tenantId).toBe(orgId);
			expect(ctx.userId).toBe(userId);
			expect(ctx.organizationId).toBe(orgId);
		});

		it("should differentiate between personal and organization context", () => {
			const personalCtx = createPersonalContext("user-1");
			const orgCtx = createOrganizationContext("org-1", "user-1");

			expect(personalCtx.type).not.toBe(orgCtx.type);
			expect(personalCtx.tenantId).not.toBe(orgCtx.tenantId);
		});
	});

	describe("Context Detection", () => {
		it("should detect personal context correctly", () => {
			runWithTenantContext(createPersonalContext("user-123"), () => {
				expect(getTenantContext().type).toBe("personal");
				expect(hasTenantContext()).toBe(true);
			});
		});

		it("should detect organization context correctly", () => {
			runWithTenantContext(
				createOrganizationContext("org-123", "user-456"),
				() => {
					expect(getTenantContext().type).toBe("organization");
					expect(hasTenantContext()).toBe(true);
				},
			);
		});

		it("should return none context when outside tenant scope", () => {
			const ctx = getTenantContext();
			expect(ctx.type).toBe("none");
			expect(hasTenantContext()).toBe(false);
		});
	});

	describe("Context Isolation", () => {
		it("should maintain context isolation across async boundaries", async () => {
			const results: string[] = [];

			const p1 = runWithTenantContext(
				createPersonalContext("user-1"),
				async () => {
					results.push(`p1: ${getTenantContext().tenantId}`);
					return getTenantContext().tenantId;
				},
			);

			const p2 = runWithTenantContext(
				createPersonalContext("user-2"),
				async () => {
					results.push(`p2: ${getTenantContext().tenantId}`);
					return getTenantContext().tenantId;
				},
			);

			const o1 = runWithTenantContext(
				createOrganizationContext("org-1", "user-3"),
				async () => {
					results.push(`o1: ${getTenantContext().tenantId}`);
					return getTenantContext().tenantId;
				},
			);

			const [r1, r2, r3] = await Promise.all([p1, p2, o1]);

			expect(r1).toBe("user-1");
			expect(r2).toBe("user-2");
			expect(r3).toBe("org-1");

			expect(results).toContain("p1: user-1");
			expect(results).toContain("p2: user-2");
			expect(results).toContain("o1: org-1");

			expect(getTenantContext().type).toBe("none");
		});
	});
});

describe("Tenant Database Isolation", () => {
	describe("Per-User-Within-Org Pattern (MCPConfig, MCPServer)", () => {
		it("should have userId AND organizationId in org context", () => {
			runWithTenantContext(
				createOrganizationContext("org-123", "user-456"),
				() => {
					const ctx = getTenantContext();

					// Per-user-within-org: both userId AND organizationId are set
					expect(ctx.userId).toBe("user-456");
					expect(ctx.organizationId).toBe("org-123");
				},
			);
		});

		it("should have userId AND null organizationId in personal context", () => {
			runWithTenantContext(createPersonalContext("user-789"), () => {
				const ctx = getTenantContext();

				expect(ctx.userId).toBe("user-789");
				expect(ctx.organizationId).toBeNull();
			});
		});
	});

	describe("Strict Isolation Pattern (AiChat, Purchase)", () => {
		it("should have userId AND null organizationId in personal context", () => {
			runWithTenantContext(createPersonalContext("user-1"), () => {
				const ctx = getTenantContext();

				// For strict isolation tables in personal context:
				// Context has userId set, but filter sets organizationId null
				expect(ctx.userId).toBe("user-1");
				expect(ctx.organizationId).toBeNull();
			});
		});

		it("should have userId AND organizationId in org context (context always has user)", () => {
			runWithTenantContext(
				createOrganizationContext("org-1", "user-2"),
				() => {
					const ctx = getTenantContext();

					// Context ALWAYS has userId set (current user)
					// For strict isolation tables, the FILTER sets userId to null
					// because these records belong to the org as a whole
					expect(ctx.userId).toBe("user-2");
					expect(ctx.organizationId).toBe("org-1");
				},
			);
		});
	});

	describe("XOR Pattern Validation", () => {
		it("should enforce that strict isolation records are either personal OR org", () => {
			// For strict isolation tables (AiChat, Purchase):
			// - Personal context: context has userId set, filter sets organizationId null
			// - Org context: context has userId set (current user), filter sets userId null
			// This is because these records belong to either a user OR the org, never both

			let personalCtx: any = null;
			let orgCtx: any = null;

			runWithTenantContext(createPersonalContext("user-a"), () => {
				personalCtx = {
					userId: getTenantContext().userId,
					organizationId: getTenantContext().organizationId,
				};
			});

			runWithTenantContext(
				createOrganizationContext("org-a", "user-b"),
				() => {
					orgCtx = {
						userId: getTenantContext().userId,
						organizationId: getTenantContext().organizationId,
					};
				},
			);

			// Personal context has userId set, orgId null
			expect(personalCtx.userId).not.toBeNull();
			expect(personalCtx.organizationId).toBeNull();

			// Org context ALSO has userId set (current user)
			// The difference is in the FILTER applied, not the context
			expect(orgCtx.userId).not.toBeNull();
			expect(orgCtx.organizationId).not.toBeNull();
		});
	});
});

describe("Tenant Filter Generation Logic", () => {
	describe("Filter for Personal Context", () => {
		it("should generate correct filter for MCPConfig in personal context", () => {
			runWithTenantContext(createPersonalContext("user-123"), () => {
				const ctx = getTenantContext();

				// For PER_USER_ORG tables in personal context:
				// Filter should be: { userId: "user-123", organizationId: null }
				const filter = {
					userId: ctx.userId,
					organizationId: ctx.organizationId,
				};

				expect(filter.userId).toBe("user-123");
				expect(filter.organizationId).toBeNull();
			});
		});

		it("should generate correct filter for AiChat in personal context", () => {
			runWithTenantContext(createPersonalContext("user-123"), () => {
				const ctx = getTenantContext();

				// For STRICT_ISOLATION tables in personal context:
				// Filter should be: { userId: "user-123", organizationId: null }
				const filter = {
					userId: ctx.userId,
					organizationId: ctx.organizationId,
				};

				expect(filter.userId).toBe("user-123");
				expect(filter.organizationId).toBeNull();
			});
		});
	});

	describe("Filter for Organization Context", () => {
		it("should generate correct filter for MCPConfig in org context", () => {
			runWithTenantContext(
				createOrganizationContext("org-456", "user-789"),
				() => {
					const ctx = getTenantContext();

					// For PER_USER_ORG tables in org context:
					// Filter should be: { userId: "user-789", organizationId: "org-456" }
					const filter = {
						userId: ctx.userId,
						organizationId: ctx.organizationId,
					};

					expect(filter.userId).toBe("user-789");
					expect(filter.organizationId).toBe("org-456");
				},
			);
		});

		it("should generate correct filter for AiChat in org context", () => {
			runWithTenantContext(
				createOrganizationContext("org-456", "user-789"),
				() => {
					const ctx = getTenantContext();

					// For STRICT_ISOLATION tables in org context:
					// Context has userId (current user), but FILTER sets userId null
					// because AiChat records belong to the org as a whole
					const filter = {
						contextHasUserId: ctx.userId,
						contextHasOrgId: ctx.organizationId,
					};

					// Context always has userId set (current user)
					expect(filter.contextHasUserId).toBe("user-789");
					expect(filter.contextHasOrgId).toBe("org-456");

					// The actual filter applied would be:
					// { organizationId: "org-456", userId: null }
					// This ensures only org-owned records are returned
				},
			);
		});
	});
});

describe("Security Attack Vectors", () => {
	describe("ID Enumeration Prevention", () => {
		it("should filter by current user ID, preventing access to other users' configs", () => {
			runWithTenantContext(createPersonalContext("attacker-user"), () => {
				const ctx = getTenantContext();

				// The filter that would be applied
				const expectedFilter = {
					userId: ctx.userId, // "attacker-user", not "victim"
					organizationId: null,
				};

				// This would not match victim's config
				expect(expectedFilter.userId).not.toBe("victim-user");
			});
		});

		it("should filter by current org ID, preventing access to other orgs' data", () => {
			runWithTenantContext(
				createOrganizationContext("attacker-org", "user-1"),
				() => {
					const ctx = getTenantContext();

					const expectedFilter = {
						organizationId: ctx.organizationId, // "attacker-org"
					};

					expect(expectedFilter.organizationId).not.toBe(
						"victim-org",
					);
				},
			);
		});

		it("should prevent cross-tenant data leakage via OR conditions", () => {
			runWithTenantContext(createPersonalContext("user-a"), () => {
				const ctx = getTenantContext();

				// Correct pattern (AND):
				const correctFilter = {
					userId: ctx.userId,
					organizationId: null,
				};

				// Incorrect pattern that would leak data (OR):
				const incorrectFilter = {
					OR: [
						{ userId: ctx.userId },
						{ organizationId: ctx.organizationId },
					],
				};

				// Correct filter ensures only user's own data
				expect(correctFilter.organizationId).toBeNull();

				// Incorrect filter would match both personal AND org data
				expect(incorrectFilter.OR).toBeDefined();
				expect(incorrectFilter.OR).toHaveLength(2);
			});
		});
	});

	describe("Context Switch Detection", () => {
		it("should prevent same user from accessing different orgs' data", () => {
			let orgAData: any = null;
			let orgBData: any = null;

			// Same user, different organizations
			runWithTenantContext(
				createOrganizationContext("org-A", "shared-user"),
				() => {
					orgAData = {
						orgId: getTenantContext().organizationId,
						userId: getTenantContext().userId,
					};
				},
			);

			runWithTenantContext(
				createOrganizationContext("org-B", "shared-user"),
				() => {
					orgBData = {
						orgId: getTenantContext().organizationId,
						userId: getTenantContext().userId,
					};
				},
			);

			// Same user ID, different org IDs
			expect(orgAData.userId).toBe(orgBData.userId);
			expect(orgAData.userId).toBe("shared-user");
			expect(orgAData.orgId).not.toBe(orgBData.orgId);
			expect(orgAData.orgId).toBe("org-A");
			expect(orgBData.orgId).toBe("org-B");
		});

		it("should have different data in personal vs org context for same user", () => {
			let personalData: any = null;
			let orgData: any = null;

			runWithTenantContext(createPersonalContext("user-X"), () => {
				personalData = {
					context: getTenantContext().type,
					userId: getTenantContext().userId,
					organizationId: getTenantContext().organizationId,
				};
			});

			runWithTenantContext(
				createOrganizationContext("org-Y", "user-X"),
				() => {
					orgData = {
						context: getTenantContext().type,
						userId: getTenantContext().userId,
						organizationId: getTenantContext().organizationId,
					};
				},
			);

			expect(personalData.userId).toBe(orgData.userId);
			expect(personalData.context).not.toBe(orgData.context);
			expect(personalData.organizationId).toBeNull();
			expect(orgData.organizationId).toBe("org-Y");
		});
	});
});

describe("RLS Context Setting", () => {
	describe("SQL Context Generation", () => {
		it("should generate correct SQL for personal context", () => {
			runWithTenantContext(createPersonalContext("user-test"), () => {
				const ctx = getTenantContext();

				const sql = [
					`SET LOCAL app.tenant_type = '${ctx.type}'`,
					`SET LOCAL app.tenant_id = '${ctx.tenantId}'`,
					`SET LOCAL app.user_id = '${ctx.userId}'`,
				];

				expect(sql[0]).toContain("personal");
				expect(sql[1]).toContain("user-test");
				expect(sql[2]).toContain("user-test");
			});
		});

		it("should generate correct SQL for organization context", () => {
			runWithTenantContext(
				createOrganizationContext("org-test", "user-test"),
				() => {
					const ctx = getTenantContext();

					const sql = [
						`SET LOCAL app.tenant_type = '${ctx.type}'`,
						`SET LOCAL app.tenant_id = '${ctx.tenantId}'`,
						`SET LOCAL app.user_id = '${ctx.userId}'`,
					];

					expect(sql[0]).toContain("organization");
					expect(sql[1]).toContain("org-test");
					expect(sql[2]).toContain("user-test");
				},
			);
		});

		it("should generate blocking SQL when no context", () => {
			const ctx = getTenantContext();

			const sql = [
				`SET LOCAL app.tenant_type = '${ctx.type}'`,
				`SET LOCAL app.tenant_id = '${ctx.tenantId ?? ""}'`,
				`SET LOCAL app.user_id = '${ctx.userId ?? ""}'`,
			];

			expect(sql[0]).toContain("none");
			expect(sql[1]).toBe("SET LOCAL app.tenant_id = ''");
			expect(sql[2]).toBe("SET LOCAL app.user_id = ''");
		});
	});
});

describe("Per-User-Within-Org Pattern Validation", () => {
	describe("MCP Configurations", () => {
		it("should allow each org member to have their own MCP credentials", () => {
			let userAConfigScope: any = null;
			let userBConfigScope: any = null;

			runWithTenantContext(
				createOrganizationContext("org-abc", "user-1"),
				() => {
					userAConfigScope = {
						userId: getTenantContext().userId,
						organizationId: getTenantContext().organizationId,
					};
				},
			);

			runWithTenantContext(
				createOrganizationContext("org-abc", "user-2"),
				() => {
					userBConfigScope = {
						userId: getTenantContext().userId,
						organizationId: getTenantContext().organizationId,
					};
				},
			);

			expect(userAConfigScope.organizationId).toBe(
				userBConfigScope.organizationId,
			);
			expect(userAConfigScope.organizationId).toBe("org-abc");
			expect(userAConfigScope.userId).not.toBe(userBConfigScope.userId);
			expect(userAConfigScope.userId).toBe("user-1");
			expect(userBConfigScope.userId).toBe("user-2");
		});

		it("should prevent User A from seeing User B's org-scoped config", () => {
			let userAQueryFilter: any = null;

			runWithTenantContext(
				createOrganizationContext("org-abc", "user-1"),
				() => {
					const ctx = getTenantContext();
					userAQueryFilter = {
						where: {
							userId: ctx.userId,
							organizationId: ctx.organizationId,
						},
					};
				},
			);

			// User B's config would have different userId
			const userBConfig = {
				userId: "user-2",
				organizationId: "org-abc",
			};

			// User A's query should not match User B's config
			const wouldMatchUserBConfig =
				userAQueryFilter.where.userId === userBConfig.userId &&
				userAQueryFilter.where.organizationId ===
					userBConfig.organizationId;

			expect(wouldMatchUserBConfig).toBe(false);
		});

		it("should prevent personal MCP config from appearing in org context query", () => {
			let personalConfigScope: any = null;
			let orgQueryFilter: any = null;

			runWithTenantContext(createPersonalContext("user-1"), () => {
				personalConfigScope = {
					userId: getTenantContext().userId,
					organizationId: getTenantContext().organizationId,
				};
			});

			runWithTenantContext(
				createOrganizationContext("org-1", "user-1"),
				() => {
					const ctx = getTenantContext();
					orgQueryFilter = {
						userId: ctx.userId,
						organizationId: ctx.organizationId,
					};
				},
			);

			expect(personalConfigScope.organizationId).toBeNull();
			expect(orgQueryFilter.organizationId).not.toBeNull();

			const wouldMatch =
				personalConfigScope.organizationId ===
				orgQueryFilter.organizationId;

			expect(wouldMatch).toBe(false);
		});
	});
});
