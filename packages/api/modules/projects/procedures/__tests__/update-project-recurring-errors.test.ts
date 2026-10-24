/**
 * Recurring-error detection toggle permission guard.
 *
 * Turning `autoDetectRecurringErrors` on lets a scheduled scan read the
 * project's application logs, so it is stricter than the procedure's
 * PROJECT_UPDATE gate: only callers with PROJECT_SETTINGS_EDIT (org
 * admin/owner, project OWNER/PROJECT_ADMIN) may change it, in either
 * direction.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUpdateProject = vi.fn();
const mockGetProject = vi.fn();
const mockResolveAccess = vi.fn();

vi.mock("@repo/database", async () => ({
	engagementProfileSchema: (await import("zod")).z.enum([
		"EXPLORE",
		"PROPOSAL",
		"GOVERNED",
		"DELEGATED",
	]),

	db: { project: { findUnique: (...a: unknown[]) => mockGetProject(...a) } },
	updateProject: (...a: unknown[]) => mockUpdateProject(...a),
	getProjectById: (...a: unknown[]) => mockGetProject(...a),
	seedTerminalStatusesIfEmpty: vi.fn(),
	Prisma: { JsonNull: Symbol("JsonNull") },
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
}));

vi.mock("../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: (...a: unknown[]) =>
		mockResolveAccess(...a),
}));

vi.mock("@repo/permissions", () => ({
	hasPermission: (perms: string[], p: string) => perms.includes(p),
}));

vi.mock("../../../../orpc/procedures", () => {
	const builder: Record<string, unknown> = {};
	builder.use = () => builder;
	builder.route = () => builder;
	builder.input = () => builder;
	builder.handler = (fn: unknown) => ({ handler: fn });
	return {
		tenantProtectedProcedure: builder,
		resolveOrganizationId: (o: string | null | undefined) => o ?? null,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: () => (c: unknown) => c,
	};
});

type Handler = (args: {
	input: Record<string, unknown>;
	context: { user: { id: string }; session: { id: string } };
}) => Promise<unknown>;

async function loadHandler(): Promise<Handler> {
	const mod = await import("../update-project");
	return (mod.updateProjectProcedure as unknown as { handler: Handler })
		.handler;
}

const context = { user: { id: "user-1" }, session: { id: "s" } };

beforeEach(() => {
	vi.clearAllMocks();
	mockGetProject.mockResolvedValue({
		id: "proj-1",
		userId: "user-1",
		organizationId: "org-1",
	});
	mockUpdateProject.mockResolvedValue({ id: "proj-1" });
});

describe("updateProjectProcedure — autoDetectRecurringErrors field guard", () => {
	it.each([true, false])(
		"rejects a member without PROJECT_SETTINGS_EDIT setting it to %s",
		async (value) => {
			mockResolveAccess.mockResolvedValue({
				source: "org-role",
				permissions: ["PROJECT_UPDATE"],
				organizationId: null,
			});
			const handler = await loadHandler();
			await expect(
				handler({
					input: { id: "proj-1", autoDetectRecurringErrors: value },
					context: { user: { id: "user-2" }, session: { id: "s" } },
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(mockUpdateProject).not.toHaveBeenCalled();
		},
	);

	it("lets a project admin switch it on and writes the flag", async () => {
		mockResolveAccess.mockResolvedValue({
			source: "org-role",
			permissions: ["PROJECT_UPDATE", "PROJECT_SETTINGS_EDIT"],
			organizationId: null,
		});
		const handler = await loadHandler();
		await handler({
			input: { id: "proj-1", autoDetectRecurringErrors: true },
			context,
		});
		expect(
			mockUpdateProject.mock.calls[0][2].autoDetectRecurringErrors,
		).toBe(true);
	});

	it("leaves the flag untouched when the field is absent", async () => {
		const handler = await loadHandler();
		await handler({ input: { id: "proj-1", name: "Renamed" }, context });
		expect(mockResolveAccess).not.toHaveBeenCalled();
		expect(
			"autoDetectRecurringErrors" in mockUpdateProject.mock.calls[0][2],
		).toBe(false);
	});
});

describe("updateProjectProcedure — recurring-error thresholds", () => {
	const tuning = {
		recurringErrorThreshold: 3,
		recurringErrorWindowHours: 48,
		recurringErrorSimilarityThreshold: 0.85,
	};

	it.each(Object.entries(tuning))(
		"rejects a member without PROJECT_SETTINGS_EDIT changing %s",
		async (field, value) => {
			mockResolveAccess.mockResolvedValue({
				source: "org-role",
				permissions: ["PROJECT_UPDATE"],
				organizationId: null,
			});
			const handler = await loadHandler();
			await expect(
				handler({
					input: { id: "proj-1", [field]: value },
					context: { user: { id: "user-2" }, session: { id: "s" } },
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(mockUpdateProject).not.toHaveBeenCalled();
		},
	);

	it("lets a project admin set them and writes each one", async () => {
		mockResolveAccess.mockResolvedValue({
			source: "org-role",
			permissions: ["PROJECT_UPDATE", "PROJECT_SETTINGS_EDIT"],
			organizationId: null,
		});
		const handler = await loadHandler();
		await handler({ input: { id: "proj-1", ...tuning }, context });
		expect(mockUpdateProject.mock.calls[0][2]).toMatchObject(tuning);
	});

	it("leaves them untouched when absent", async () => {
		const handler = await loadHandler();
		await handler({ input: { id: "proj-1", name: "Renamed" }, context });
		for (const field of Object.keys(tuning)) {
			expect(field in mockUpdateProject.mock.calls[0][2]).toBe(false);
		}
	});
});
