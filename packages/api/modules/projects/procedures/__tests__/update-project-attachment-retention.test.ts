/**
 * Per-project attachment retention window (Fizzy #1749).
 *
 * `attachmentRetentionDays` is bounded by the SHARED constants in
 * `@repo/utils/attachment` (30..3650) — the schema is exercised for real here,
 * so a widened bound in the procedure fails this file rather than shipping.
 *
 * It is also an admin-only field: shortening the window permanently deletes
 * hidden attachments once the 7-day grace floor elapses, and there is no
 * restore surface. Finally, the change timestamp that ARMS that grace floor is
 * stamped only on a real change — a no-op save must not postpone every pending
 * purge indefinitely.
 *
 * The harness mirrors `update-project-hidden-stages.test.ts`: it runs the
 * middleware chain and then parses the input through the procedure's real zod
 * schema, which is what makes the bounds assertions meaningful.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

class Decimal {}

const mockUpdateProject = vi.fn();
const mockRecordAudit = vi.fn();
const mockProjectFindUnique = vi.fn();

vi.mock("@repo/database", () => ({
	db: {
		project: {
			findUnique: (...a: unknown[]) => mockProjectFindUnique(...a),
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
	seedTerminalStatusesIfEmpty: vi.fn(async () => {}),
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

const context = {
	user: { id: "user-1", email: "user@example.com" },
	session: { id: "sess-1" },
};

/** The row `update-project` loads via findUnique. Mutated per test. */
let existingProject: {
	repositoryUrl: string | null;
	pmTerminalStatuses: string[];
	attachmentRetentionDays: number | null;
};

async function callUpdateProject(input: Record<string, unknown>) {
	const { updateProjectProcedure } = await import("../update-project");
	return (updateProjectProcedure as any)({ input, context });
}

/** Restrict the caller to exactly the listed grants. */
function grantOnly(...permissions: string[]) {
	mockResolvePermissions.mockResolvedValue({
		source: "org-role",
		permissions,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	existingProject = {
		repositoryUrl: null,
		pmTerminalStatuses: [],
		attachmentRetentionDays: null,
	};
	mockProjectFindUnique.mockImplementation(async () => existingProject);
	grantOnly("PROJECT_UPDATE", "PROJECT_SETTINGS_EDIT");
	mockUpdateProject.mockResolvedValue({ id: "p1", name: "Project" });
});

describe("updateProjectProcedure — attachment retention bounds", () => {
	it("rejects a retention window below the minimum", async () => {
		await expect(
			callUpdateProject({ id: "p1", attachmentRetentionDays: 29 }),
		).rejects.toThrow();
		expect(mockUpdateProject).not.toHaveBeenCalled();
	});

	it("rejects a retention window above the maximum", async () => {
		await expect(
			callUpdateProject({ id: "p1", attachmentRetentionDays: 3651 }),
		).rejects.toThrow();
		expect(mockUpdateProject).not.toHaveBeenCalled();
	});

	it("accepts the exact boundary values", async () => {
		await callUpdateProject({ id: "p1", attachmentRetentionDays: 30 });
		expect(mockUpdateProject.mock.calls[0][2]).toMatchObject({
			attachmentRetentionDays: 30,
		});

		mockUpdateProject.mockClear();
		existingProject.attachmentRetentionDays = null;
		await callUpdateProject({ id: "p1", attachmentRetentionDays: 3650 });
		expect(mockUpdateProject.mock.calls[0][2]).toMatchObject({
			attachmentRetentionDays: 3650,
		});
	});

	it("rejects a non-integer window", async () => {
		await expect(
			callUpdateProject({ id: "p1", attachmentRetentionDays: 90.5 }),
		).rejects.toThrow();
	});
});

describe("updateProjectProcedure — attachment retention write-through", () => {
	it("stamps the change timestamp when the value changes", async () => {
		await callUpdateProject({ id: "p1", attachmentRetentionDays: 180 });
		expect(mockUpdateProject.mock.calls[0][2]).toEqual(
			expect.objectContaining({
				attachmentRetentionDays: 180,
				attachmentRetentionDaysUpdatedAt: expect.any(Date),
			}),
		);
	});

	it("accepts null to clear an existing override, and stamps the change", async () => {
		existingProject.attachmentRetentionDays = 180;
		await callUpdateProject({ id: "p1", attachmentRetentionDays: null });
		expect(mockUpdateProject.mock.calls[0][2]).toEqual(
			expect.objectContaining({
				attachmentRetentionDays: null,
				attachmentRetentionDaysUpdatedAt: expect.any(Date),
			}),
		);
	});

	it("does not stamp the timestamp when the value is unchanged", async () => {
		// A no-op save must not re-arm the grace floor, or repeatedly saving an
		// unrelated field would postpone every purge indefinitely.
		existingProject.attachmentRetentionDays = 180;
		await callUpdateProject({ id: "p1", attachmentRetentionDays: 180 });
		const data = mockUpdateProject.mock.calls[0][2];
		expect(data).not.toHaveProperty("attachmentRetentionDaysUpdatedAt");
	});

	it("does not stamp the timestamp when a project with no override is sent null", async () => {
		// `existingProject` is null-valued here. Without the `?? null` normalisation
		// on the comparison a MISSING row would read as `undefined`, and
		// `null !== undefined` would stamp on a request that changed nothing.
		mockProjectFindUnique.mockResolvedValue(null);
		await callUpdateProject({ id: "p1", attachmentRetentionDays: null });
		const data = mockUpdateProject.mock.calls[0][2];
		expect(data).not.toHaveProperty("attachmentRetentionDaysUpdatedAt");
		expect(data).not.toHaveProperty("attachmentRetentionDays");
	});

	it("leaves the column untouched when the field is omitted", async () => {
		await callUpdateProject({ id: "p1", name: "Renamed" });
		const data = mockUpdateProject.mock.calls[0][2];
		expect(data).not.toHaveProperty("attachmentRetentionDays");
		expect(data).not.toHaveProperty("attachmentRetentionDaysUpdatedAt");
		// The admin-only escalation must not fire for an unrelated edit.
		expect(mockResolvePermissions).toHaveBeenCalledTimes(1);
	});
});

describe("updateProjectProcedure — attachment retention permission gate", () => {
	it("requires PROJECT_SETTINGS_EDIT to change the retention window", async () => {
		grantOnly("PROJECT_UPDATE");
		await expect(
			callUpdateProject({ id: "p1", attachmentRetentionDays: 180 }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mockUpdateProject).not.toHaveBeenCalled();
	});

	it("requires PROJECT_SETTINGS_EDIT to CLEAR the retention window too", async () => {
		grantOnly("PROJECT_UPDATE");
		await expect(
			callUpdateProject({ id: "p1", attachmentRetentionDays: null }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mockUpdateProject).not.toHaveBeenCalled();
	});

	it("allows a caller with PROJECT_SETTINGS_EDIT", async () => {
		grantOnly("PROJECT_UPDATE", "PROJECT_SETTINGS_EDIT");
		await callUpdateProject({ id: "p1", attachmentRetentionDays: 180 });
		expect(mockUpdateProject.mock.calls[0][2]).toMatchObject({
			attachmentRetentionDays: 180,
		});
	});
});
