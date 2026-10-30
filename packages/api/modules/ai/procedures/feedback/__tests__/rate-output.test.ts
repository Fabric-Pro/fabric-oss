import { call } from "@orpc/server";
import { logger } from "@repo/logs";
import {
	resolveOrgPermissions,
	resolveProjectPermissions,
} from "@repo/permissions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	resolveEffectiveProjectPermissions: vi.fn(),
	write: vi.fn(),
	provenance: vi.fn(),
	list: vi.fn(),
	clear: vi.fn(),
	activeOrganizationRole: "member" as string | null,
	grantProjectAccess: vi.fn(),
	getOrganizationMembership: vi.fn(),
	hasOrganizationTie: vi.fn(),
	getSession: vi.fn(),
	effectiveWriteOrgId: null as string | null,
}));

vi.mock("@repo/payments", () => ({}));
vi.mock("@repo/config", () => ({ config: {} }));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@repo/auth", () => ({
	auth: { api: { getSession: (...a: unknown[]) => mocks.getSession(...a) } },
}));
vi.mock("@repo/database", () => ({
	db: {},
	clearAiOutcome: mocks.clear,
	getAiOutcomesForSubjects: mocks.list,
	recordAiOutcome: mocks.write,
	getAiOutputProvenance: mocks.provenance,
	getTenantContext: () => ({
		effectiveWriteOrgId: mocks.effectiveWriteOrgId,
	}),
	getOrganizationMembership: (...a: unknown[]) =>
		mocks.getOrganizationMembership(...a),
	grantProjectAccess: (...a: unknown[]) => mocks.grantProjectAccess(...a),
	hasOrganizationTie: (...a: unknown[]) => mocks.hasOrganizationTie(...a),
	StoryVersionConflictError: class extends Error {},
}));
vi.mock("../../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: (...a: unknown[]) =>
		mocks.resolveEffectiveProjectPermissions(...a),
}));
vi.mock("../../../../../lib/rate-limit", () => ({
	checkRateLimit: async () => ({
		allowed: true,
		remaining: 1,
		resetInSeconds: 60,
	}),
	RATE_LIMIT_PRESETS: {},
}));

// The observability and audit middlewares are not what these tests are about,
// and each reaches a database; pass them through so the chain under test is
// the REAL root → session → permission → handler order.
const { passThrough } = vi.hoisted(() => ({
	passThrough: async () => {
		const { os: orpc } = await import("@orpc/server");
		return orpc.middleware(async ({ next }) => next());
	},
}));
vi.mock(
	"../../../../../orpc/middleware/request-counter-middleware",
	async () => ({
		requestCounterMiddleware: await passThrough(),
	}),
);
vi.mock(
	"../../../../../orpc/middleware/error-metrics-middleware",
	async () => ({
		errorMetricsMiddleware: await passThrough(),
	}),
);
vi.mock(
	"../../../../../orpc/middleware/audit-error-middleware",
	async (importOriginal) => ({
		// Keep the shared audit helper export available to the procedure chain.
		...(await importOriginal<
			typeof import("../../../../../orpc/middleware/audit-error-middleware")
		>()),
		auditErrorMiddleware: await passThrough(),
	}),
);
vi.mock("../../../../../orpc/middleware/audit-timing-middleware", async () => ({
	auditTimingMiddleware: await passThrough(),
}));
vi.mock(
	"../../../../../orpc/middleware/audit-activity-middleware",
	async () => ({
		auditActivityMiddleware: await passThrough(),
	}),
);
vi.mock("../../../../../orpc/middleware/touch-last-seen", async () => ({
	touchLastSeenMiddleware: await passThrough(),
}));
vi.mock(
	"../../../../../orpc/middleware/rpc-rate-limit-middleware",
	async () => ({
		rpcRateLimitMiddleware: await passThrough(),
	}),
);
vi.mock(
	"../../../../../orpc/middleware/tenant-context-middleware",
	async () => ({
		tenantContextMiddleware: (await import("@orpc/server")).os.middleware(
			({ next }) =>
				next({
					context: {
						activeOrganizationRole: mocks.activeOrganizationRole,
						tenantContext: {
							type: "organization",
							organizationId: "example-session-org",
							userId: "example-user",
						},
						allowedProjectIds: [],
					},
				}),
		),
		getOrganizationIdFromContext: vi.fn(),
		getTenantFilterFromContext: vi.fn(),
	}),
);

import {
	clearAiOutputRating,
	listAiOutputRatings,
	rateAiOutput,
} from "../rate-output";

const input = {
	featureKey: "document-generation",
	subjectType: "copilot-message",
	subjectId: "example-message",
	outcome: "RATED_UP" as const,
	projectId: "example-project",
};
const context = { headers: new Headers() };
beforeEach(() => {
	vi.clearAllMocks();
	mocks.effectiveWriteOrgId = null;
	mocks.activeOrganizationRole = "member";
	mocks.getSession.mockResolvedValue({
		session: { activeOrganizationId: "example-session-org" },
		user: { id: "example-user" },
	});
	mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
		source: "project-member",
		organizationId: "example-session-org",
		permissions: resolveProjectPermissions("EDITOR"),
	});
	mocks.write.mockResolvedValue({ outcome: "RATED_UP" });
	mocks.provenance.mockResolvedValue(null);
	mocks.list.mockResolvedValue({ "example-message": "RATED_UP" });
	mocks.clear.mockResolvedValue(1);
});
describe("reply rating project authorization and tenant binding", () => {
	it("allows an invited project editor without organization membership and records the project's organization", async () => {
		mocks.activeOrganizationRole = null;
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
			source: "project-member",
			organizationId: "example-project-org",
			permissions: resolveProjectPermissions("EDITOR"),
		});
		await call(rateAiOutput, input, { context });
		expect(mocks.write).toHaveBeenCalledWith(
			expect.objectContaining({
				...input,
				userId: "example-user",
				organizationId: "example-project-org",
			}),
		);
		expect(mocks.grantProjectAccess).toHaveBeenCalledWith(
			"example-project",
			"example-project-org",
		);
	});
	it("allows project chat access without a session organization", async () => {
		mocks.getSession.mockResolvedValue({
			session: { activeOrganizationId: null },
			user: { id: "example-user" },
		});
		mocks.activeOrganizationRole = null;
		await call(rateAiOutput, input, { context });
		expect(mocks.write).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: input.projectId,
				organizationId: "example-session-org",
			}),
		);
	});
	it("refuses another organization's project when the user has no access", async () => {
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
			source: "none",
			organizationId: "example-other-org",
			permissions: [],
		});
		await expect(
			call(rateAiOutput, input, { context }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.write).not.toHaveBeenCalled();
	});
	it("refuses a project the user cannot read", async () => {
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
			source: "project-member",
			organizationId: "example-session-org",
			permissions: [],
		});
		await expect(
			call(rateAiOutput, input, { context }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.write).not.toHaveBeenCalled();
	});
	it("refuses a missing project", async () => {
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue(null);
		await expect(
			call(rateAiOutput, input, { context }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.write).not.toHaveBeenCalled();
	});
	it("refuses a project with no organization", async () => {
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
			source: "project-member",
			organizationId: null,
			permissions: resolveProjectPermissions("EDITOR"),
		});
		await expect(
			call(rateAiOutput, input, { context }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.write).not.toHaveBeenCalled();
	});
	it("writes an accessible project editor's rating", async () => {
		await call(rateAiOutput, input, { context });
		expect(mocks.write).toHaveBeenCalledWith(
			expect.objectContaining({
				...input,
				userId: "example-user",
				organizationId: "example-session-org",
			}),
		);
	});
	it("writes a projectless rating with a null project and the session organization", async () => {
		const { projectId: _projectId, ...projectless } = input;
		await call(rateAiOutput, projectless, { context });
		expect(mocks.write).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: null,
				organizationId: "example-session-org",
			}),
		);
	});
	it("requires AI_CHAT for a projectless caller without an organization role", async () => {
		mocks.activeOrganizationRole = null;
		const { projectId: _projectId, ...projectless } = input;
		await expect(
			call(rateAiOutput, projectless, { context }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.write).not.toHaveBeenCalled();
	});
	it.each(["VIEWER", "COMMENTER"])(
		"refuses a project %s guest who lacks AI_CHAT",
		async (role) => {
			mocks.activeOrganizationRole = null;
			mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
				source: "project-member",
				organizationId: "example-project-org",
				permissions: resolveProjectPermissions(role),
			});
			await expect(
				call(rateAiOutput, input, { context }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(mocks.write).not.toHaveBeenCalled();
		},
	);
	it("refuses an organization viewer who lacks AI_CHAT on the project", async () => {
		mocks.activeOrganizationRole = "viewer";
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
			source: "org",
			organizationId: "example-session-org",
			permissions: resolveOrgPermissions("viewer"),
		});
		await expect(
			call(rateAiOutput, input, { context }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.write).not.toHaveBeenCalled();
	});
	it("lists an editor guest's own votes using project permission when the session organization differs", async () => {
		mocks.activeOrganizationRole = "viewer";
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
			source: "project-member",
			organizationId: "example-project-org",
			permissions: resolveProjectPermissions("EDITOR"),
		});
		await expect(
			call(
				listAiOutputRatings,
				{
					featureKey: input.featureKey,
					subjectType: input.subjectType,
					subjectIds: [input.subjectId],
					projectId: input.projectId,
				},
				{ context },
			),
		).resolves.toEqual({ outcomes: { "example-message": "RATED_UP" } });
		expect(mocks.list).toHaveBeenCalledWith({
			featureKey: input.featureKey,
			subjectType: input.subjectType,
			subjectIds: [input.subjectId],
			userId: "example-user",
		});
		expect(mocks.grantProjectAccess).toHaveBeenCalledWith(
			input.projectId,
			"example-project-org",
		);
	});
	it("clears an editor guest's own vote using project permission when the session organization differs", async () => {
		mocks.activeOrganizationRole = "viewer";
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
			source: "project-member",
			organizationId: "example-project-org",
			permissions: resolveProjectPermissions("EDITOR"),
		});
		await expect(
			call(
				clearAiOutputRating,
				{
					featureKey: input.featureKey,
					subjectType: input.subjectType,
					subjectId: input.subjectId,
					projectId: input.projectId,
				},
				{ context },
			),
		).resolves.toEqual({ cleared: true });
		expect(mocks.clear).toHaveBeenCalledWith({
			featureKey: input.featureKey,
			subjectType: input.subjectType,
			subjectId: input.subjectId,
			userId: "example-user",
		});
	});
	it("keeps projectless list and clear calls behind the session AI_CHAT permission", async () => {
		mocks.activeOrganizationRole = "viewer";
		const subject = {
			featureKey: input.featureKey,
			subjectType: input.subjectType,
			subjectId: input.subjectId,
		};
		await expect(
			call(
				listAiOutputRatings,
				{
					featureKey: input.featureKey,
					subjectType: input.subjectType,
					subjectIds: [input.subjectId],
				},
				{ context },
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			call(clearAiOutputRating, subject, { context }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.list).not.toHaveBeenCalled();
		expect(mocks.clear).not.toHaveBeenCalled();
	});
	it.each(["VIEWER", "COMMENTER"])(
		"refuses project %s guests on list and clear as well",
		async (role) => {
			mocks.activeOrganizationRole = null;
			mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
				source: "project-member",
				organizationId: "example-project-org",
				permissions: resolveProjectPermissions(role),
			});
			await expect(
				call(
					listAiOutputRatings,
					{
						featureKey: input.featureKey,
						subjectType: input.subjectType,
						subjectIds: [input.subjectId],
						projectId: input.projectId,
					},
					{ context },
				),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			await expect(
				call(
					clearAiOutputRating,
					{
						featureKey: input.featureKey,
						subjectType: input.subjectType,
						subjectId: input.subjectId,
						projectId: input.projectId,
					},
					{ context },
				),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(mocks.list).not.toHaveBeenCalled();
			expect(mocks.clear).not.toHaveBeenCalled();
		},
	);
	it("preserves projectless list and clear for session chat users", async () => {
		const subject = {
			featureKey: input.featureKey,
			subjectType: input.subjectType,
			subjectId: input.subjectId,
		};
		await expect(
			call(
				listAiOutputRatings,
				{
					featureKey: input.featureKey,
					subjectType: input.subjectType,
					subjectIds: [input.subjectId],
				},
				{ context },
			),
		).resolves.toEqual({ outcomes: { "example-message": "RATED_UP" } });
		await expect(
			call(clearAiOutputRating, subject, { context }),
		).resolves.toEqual({ cleared: true });
		expect(mocks.list).toHaveBeenCalledWith({
			featureKey: input.featureKey,
			subjectType: input.subjectType,
			subjectIds: [input.subjectId],
			userId: "example-user",
		});
		expect(mocks.clear).toHaveBeenCalledWith({
			...subject,
			userId: "example-user",
		});
	});
});

describe("rating output provenance", () => {
	const provenance = {
		projectId: "example-project",
		modelCanonicalName: "example-model",
		promptVersionId: null,
	};
	it("fills the model from provenance for the authorized project and user", async () => {
		mocks.provenance.mockResolvedValue(provenance);
		await call(rateAiOutput, input, { context });
		expect(mocks.provenance).toHaveBeenCalledWith({
			organizationId: "example-session-org",
			userId: "example-user",
			subjectType: "copilot-message",
			subjectId: input.subjectId,
		});
		expect(mocks.write).toHaveBeenCalledWith(
			expect.objectContaining({
				modelCanonicalName: "example-model",
				promptVersionId: null,
			}),
		);
	});
	it.each(["user", "organization"])(
		"does not borrow another %s's provenance for the same message id",
		async (boundary) => {
			mocks.provenance.mockImplementation(async (key) =>
				key.userId === "example-user" &&
				key.organizationId === "example-session-org"
					? provenance
					: null,
			);
			if (boundary === "user") {
				mocks.getSession.mockResolvedValue({
					session: { activeOrganizationId: "example-session-org" },
					user: { id: "example-other-user" },
				});
			} else {
				mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
					source: "project-member",
					organizationId: "example-other-org",
					permissions: resolveProjectPermissions("EDITOR"),
				});
			}
			await call(rateAiOutput, input, { context });
			expect(mocks.provenance).toHaveBeenCalledWith(
				expect.objectContaining(
					boundary === "user"
						? { userId: "example-other-user" }
						: { organizationId: "example-other-org" },
				),
			);
			expect(mocks.write).toHaveBeenCalledWith(
				expect.objectContaining({
					modelCanonicalName: null,
					promptVersionId: null,
				}),
			);
		},
	);
	it("does not use provenance belonging to a different project", async () => {
		mocks.provenance.mockResolvedValue({
			...provenance,
			projectId: "example-other-project",
		});
		await call(rateAiOutput, input, { context });
		expect(mocks.write).toHaveBeenCalledWith(
			expect.objectContaining({
				modelCanonicalName: null,
				promptVersionId: null,
			}),
		);
	});
	it("ignores browser model and prompt fields", async () => {
		await call(
			rateAiOutput,
			{
				...input,
				modelCanonicalName: "example-forged-model",
				promptVersionId: "example-forged-prompt",
			} as typeof input,
			{ context },
		);
		expect(mocks.write).toHaveBeenCalledWith(
			expect.objectContaining({
				modelCanonicalName: null,
				promptVersionId: null,
			}),
		);
	});
	it.each([
		[
			Object.assign(new Error("example-private-subject-content"), {
				name: "PrismaClientKnownRequestError",
				code: "P2021",
			}),
			{ name: "PrismaClientKnownRequestError", code: "P2021" },
		],
		[
			{
				name: "ExampleDatabaseError",
				code: 42,
				message: "example-private-subject-content",
			},
			{ name: "ExampleDatabaseError", code: 42 },
		],
		[new Error("example-private-subject-content"), { name: "Error" }],
		["example-private-subject-content", {}],
		[
			{
				name: "ExampleDatabaseError",
				code: { message: "example-private-subject-content" },
			},
			{ name: "ExampleDatabaseError" },
		],
	])(
		"records a rating after lookup failure and logs only error name/code (%#)",
		async (error, diagnostics) => {
			mocks.provenance.mockRejectedValueOnce(error);
			await expect(
				call(
					rateAiOutput,
					{ ...input, comment: "example-feedback-content" },
					{ context },
				),
			).resolves.toEqual({ outcome: "RATED_UP" });
			expect(mocks.write).toHaveBeenCalledWith(
				expect.objectContaining({
					modelCanonicalName: null,
					promptVersionId: null,
					comment: "example-feedback-content",
				}),
			);
			expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
				"[ai.feedback] Failed to look up output provenance",
				diagnostics,
			);
		},
	);

	it("only looks up Copilot messages", async () => {
		await call(
			rateAiOutput,
			{ ...input, subjectType: "example-other-output" },
			{ context },
		);
		expect(mocks.provenance).not.toHaveBeenCalled();
	});
});

describe("public HTTP rating input", () => {
	it("strips browser model fields on the public rate endpoint", async () => {
		const { OpenAPIHandler } = await import("@orpc/openapi/fetch");
		const handler = new OpenAPIHandler({ rateAiOutput });
		const result = await handler.handle(
			new Request("http://localhost/ai/feedback/rate", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					...input,
					modelCanonicalName: "example-forged-model",
					promptVersionId: "example-forged-prompt",
				}),
			}),
			{ context },
		);
		expect(result.matched).toBe(true);
		expect(result.response?.status).toBe(200);
		expect(mocks.write).toHaveBeenCalledWith(
			expect.objectContaining({
				modelCanonicalName: null,
				promptVersionId: null,
			}),
		);
	});
});
