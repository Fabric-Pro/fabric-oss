import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

class Decimal {}

const mockUpdateProject = vi.fn();
const mockRecordAudit = vi.fn();

vi.mock("@repo/database", () => ({
	db: {
		project: {
			findUnique: vi.fn().mockResolvedValue({
				repositoryUrl: null,
				pmTerminalStatuses: [],
			}),
		},
	},
	updateProject: (...a: unknown[]) => mockUpdateProject(...a),
	cleanupCodeSearchOnRepoUnlink: vi.fn(async () => ({
		deletedContextQdrantIds: [],
		organizationId: null,
	})),
	moveWizardTempContextsToProject: vi.fn(async () => ({
		movedCount: 0,
		contextIds: [],
		contextIdMapping: {},
		sessionId: "s",
	})),
	syncLegacyProjectRepoOnDisconnect: vi.fn(async () => {}),
	setAiUsageRecorder: vi.fn(),
	GATEWAY_PROVIDERS: new Set(["OPENAI", "ANTHROPIC"]),
	DB_GATEWAY_PROVIDERS: ["OPENAI", "ANTHROPIC"],
	AI_PROVIDER_METADATA: {},
	Prisma: { JsonNull: Symbol("JsonNull"), Decimal },
}));

vi.mock("@repo/database/prisma/zod", () => ({
	ProjectStatusSchema: z.enum(["ACTIVE", "ARCHIVED", "DRAFT"]),
	ClarifyingQuestionFrequencySchema: z.enum([
		"MINIMAL",
		"BALANCED",
		"THOROUGH",
	]),
	QaStrategyLevelSchema: z.enum(["LIGHT", "STANDARD", "STRICT"]),
	MaturationStatusSchema: z.enum(["TO_DO", "DISCOVERY", "DONE"]),
}));

vi.mock("../../../../lib/audit", () => ({
	recordAuditFromRequest: (...a: unknown[]) => mockRecordAudit(...a),
}));

const mockResolvePermissions = vi.fn();
vi.mock("../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: (...args: unknown[]) =>
		mockResolvePermissions(...args),
}));

vi.mock("@repo/permissions", () => ({
	hasPermission: (perms: string[], p: string) => perms.includes(p),
	Permissions: {
		PROJECT_UPDATE: "PROJECT_UPDATE",
		PROJECT_SETTINGS_EDIT: "PROJECT_SETTINGS_EDIT",
	},
}));

vi.mock("../../../../orpc/procedures", () => {
	const middlewares: Array<(...args: any[]) => any> = [];
	const builder: Record<string, unknown> = {};
	builder.use = (mw: any) => {
		middlewares.push(mw);
		return builder;
	};
	builder.route = () => builder;
	builder.input = (schema: unknown) => {
		(builder as any)._schema = schema;
		return builder;
	};
	builder.handler = (fn: (...args: unknown[]) => unknown) => {
		return async ({ input, context }: { input: any; context: any }) => {
			for (const mw of middlewares) {
				await mw({ input, context });
			}
			let parsedInput = input;
			if (
				(builder as any)._schema &&
				typeof (builder as any)._schema.parse === "function"
			) {
				parsedInput = (builder as any)._schema.parse(input);
			}
			return fn({ input: parsedInput, context });
		};
	};
	return {
		tenantProtectedProcedure: builder,
		requireProjectPermission: (requiredPerm: string) => {
			return async ({ context, input }: { context: any; input: any }) => {
				const effective = await mockResolvePermissions(
					input.id,
					context.user.id,
				);
				if (
					!effective ||
					!effective.permissions ||
					!effective.permissions.includes(requiredPerm)
				) {
					const { ORPCError } = await import("@orpc/client");
					throw new ORPCError("FORBIDDEN", {
						message: "Permission denied",
					});
				}
			};
		},
		resolveOrganizationId: () => "org-1",
		Permissions: {
			PROJECT_UPDATE: "PROJECT_UPDATE",
			PROJECT_SETTINGS_EDIT: "PROJECT_SETTINGS_EDIT",
		},
	};
});

vi.mock("../lib/code-indexing-trigger", () => ({
	cancelCodeIndexingForRepo: vi.fn(),
	startCodeIndexingForProject: vi.fn().mockResolvedValue({
		started: 0,
		skipped: [],
	}),
}));

describe("updateProjectProcedure — hidden stage configurations", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockResolvePermissions.mockResolvedValue({
			source: "member",
			permissions: ["PROJECT_UPDATE"],
		});
		mockUpdateProject.mockResolvedValue({
			id: "proj-1",
			name: "Test Project",
			hiddenMaturationStatuses: ["DISCOVERY"],
		});
	});

	it("updates hiddenMaturationStatuses payload and records audit metadata", async () => {
		const { updateProjectProcedure } = await import("../update-project");

		const input = {
			id: "proj-1",
			hiddenMaturationStatuses: ["DISCOVERY"],
		};
		const context = {
			user: { id: "user-1", email: "user@example.com" },
			session: { id: "sess-1" },
		};

		const result = await (updateProjectProcedure as any)({
			input,
			context,
		});

		expect(mockUpdateProject).toHaveBeenCalledWith(
			"proj-1",
			"user-1",
			expect.objectContaining({
				hiddenMaturationStatuses: ["DISCOVERY"],
			}),
			"org-1",
		);
		expect(mockRecordAudit).toHaveBeenCalledWith(
			context,
			expect.objectContaining({
				action: "project.updated",
				projectId: "proj-1",
				metadata: expect.objectContaining({
					hiddenMaturationStatuses: ["DISCOVERY"],
				}),
			}),
		);
		expect(result.project.hiddenMaturationStatuses).toEqual(["DISCOVERY"]);
	});

	it("rejects when attempting to hide all 3 stages (floor enforcement)", async () => {
		const { updateProjectProcedure } = await import("../update-project");

		const input = {
			id: "proj-1",
			hiddenMaturationStatuses: ["TO_DO", "DISCOVERY", "DONE"],
		};
		const context = {
			user: { id: "user-1", email: "user@example.com" },
			session: { id: "sess-1" },
		};

		await expect(
			(updateProjectProcedure as any)({ input, context }),
		).rejects.toThrow("At least one stage must remain visible.");
	});

	it("deduplicates hiddenMaturationStatuses array input before writing", async () => {
		const { updateProjectProcedure } = await import("../update-project");

		const input = {
			id: "proj-1",
			hiddenMaturationStatuses: ["DISCOVERY", "DISCOVERY", "TO_DO"],
		};
		const context = {
			user: { id: "user-1", email: "user@example.com" },
			session: { id: "sess-1" },
		};

		await (updateProjectProcedure as any)({ input, context });

		expect(mockUpdateProject).toHaveBeenCalledWith(
			"proj-1",
			"user-1",
			expect.objectContaining({
				hiddenMaturationStatuses: ["DISCOVERY", "TO_DO"],
			}),
			"org-1",
		);
	});

	it("records hiddenMaturationStatuses in audit metadata even when project is being archived", async () => {
		const { updateProjectProcedure } = await import("../update-project");

		const input = {
			id: "proj-1",
			status: "ARCHIVED",
			hiddenMaturationStatuses: ["DISCOVERY"],
		};
		const context = {
			user: { id: "user-1", email: "user@example.com" },
			session: { id: "sess-1" },
		};

		await (updateProjectProcedure as any)({ input, context });

		expect(mockRecordAudit).toHaveBeenCalledWith(
			context,
			expect.objectContaining({
				action: "project.archived",
				projectId: "proj-1",
				metadata: expect.objectContaining({
					previousStatus: "ACTIVE",
					hiddenMaturationStatuses: ["DISCOVERY"],
				}),
			}),
		);
	});

	it("rejects unauthorized users lacking PROJECT_UPDATE permission (read-only exclusion)", async () => {
		const { updateProjectProcedure } = await import("../update-project");

		mockResolvePermissions.mockResolvedValue({
			source: "viewer",
			permissions: ["PROJECT_SETTINGS_EDIT"],
		});

		const input = {
			id: "proj-1",
			hiddenMaturationStatuses: ["DISCOVERY"],
		};
		const context = {
			user: { id: "viewer-1", email: "viewer@example.com" },
			session: { id: "sess-2" },
		};

		await expect(
			(updateProjectProcedure as any)({ input, context }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		expect(mockUpdateProject).not.toHaveBeenCalled();
	});
});
