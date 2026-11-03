/**
 * `weave.plans.refine` through its real procedure chain: who may refine, in
 * which organization the model runs and bills, the prompt it is sent, how
 * its reply is read, and how a failure reaches the person. The agent
 * runtime's `weave-refine` engine runs the same checks through
 * `authorizeRefineRun`, which is held to the same table below.
 */
import { call } from "@orpc/server";
import { ChatGptPlanAuthError } from "@repo/ai/lib/chatgpt-plan/oauth";
import { AiUsageLimitExceededError } from "@repo/payments/lib/ai-usage-limit-error";
import {
	ORG_ROLE_PERMISSIONS,
	PROJECT_ROLE_PERMISSIONS,
} from "@repo/permissions";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AuthorizedProject,
	hasProjectBindingHolder,
	peekAuthorizedProject,
	recordAuthorizedProject,
	runWithProjectBindingHolder,
} from "../../../../lib/authorized-project-binding";

const ORG = "org-example-project";
const OTHER_ORG = "org-example-other";
const PROJECT_ID = "project-example-1";
const USER_ID = "user-example-1";

const mocks = vi.hoisted(() => ({
	getSession: vi.fn(),
	resolveEffectiveProjectPermissions: vi.fn(),
	hasProjectAccess: vi.fn(),
	getAIModelWithMetadata: vi.fn(),
	generateText: vi.fn(),
	trackUsage: vi.fn(),
	errorRowBinding: vi.fn(),
}));

const { passThrough } = vi.hoisted(() => ({
	passThrough: async () => {
		const { os } = await import("@orpc/server");
		return os.middleware(async ({ next }) => next());
	},
}));

vi.mock("@repo/payments", () => ({}));
vi.mock("@repo/auth", () => ({
	auth: { api: { getSession: (...a: unknown[]) => mocks.getSession(...a) } },
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	logDataEvent: vi.fn(async () => undefined),
}));
vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: (...a: unknown[]) =>
		mocks.getAIModelWithMetadata(...a),
	generateText: (...a: unknown[]) => mocks.generateText(...a),
	logModelUsageAsync: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: {
		project: {
			findUnique: async () => ({
				name: "Example project",
				description: "An example project",
				techStack: ["TypeScript", "Postgres"],
			}),
		},
	},
	getTenantContext: () => ({ effectiveWriteOrgId: null }),
	getOrganizationMembership: vi.fn(),
	grantProjectAccess: vi.fn(),
	hasOrganizationTie: vi.fn(async () => true),
	hasProjectAccess: (...a: unknown[]) => mocks.hasProjectAccess(...a),
	StoryVersionConflictError: class extends Error {},
}));
vi.mock("../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: (...a: unknown[]) =>
		mocks.resolveEffectiveProjectPermissions(...a),
}));
vi.mock("../../../../lib/rate-limit", () => ({
	checkRateLimit: async () => ({ allowed: true }),
	RATE_LIMIT_PRESETS: {},
}));
// Observability, audit and tenant-store middlewares each reach a database and
// are not under test; the permission middleware and resolvers are real.
vi.mock("../../../../orpc/middleware/request-counter-middleware", async () => ({
	requestCounterMiddleware: await passThrough(),
}));
vi.mock("../../../../orpc/middleware/error-metrics-middleware", async () => ({
	errorMetricsMiddleware: await passThrough(),
}));
// The error capture writes to a database; this stand-in only records the
// binding it would attribute the row to, read where the real one reads it.
vi.mock("../../../../orpc/middleware/audit-error-middleware", async () => {
	const { os } = await import("@orpc/server");
	const { peekAuthorizedProject } = await import(
		"../../../../lib/authorized-project-binding"
	);
	return {
		auditErrorMiddleware: os.middleware(async ({ next }) => {
			try {
				return await next();
			} catch (error) {
				mocks.errorRowBinding(peekAuthorizedProject());
				throw error;
			}
		}),
	};
});
vi.mock("../../../../orpc/middleware/audit-timing-middleware", async () => ({
	auditTimingMiddleware: await passThrough(),
}));
vi.mock("../../../../orpc/middleware/audit-activity-middleware", async () => ({
	auditActivityMiddleware: await passThrough(),
}));
vi.mock("../../../../orpc/middleware/touch-last-seen", async () => ({
	touchLastSeenMiddleware: await passThrough(),
}));
vi.mock("../../../../orpc/middleware/rpc-rate-limit-middleware", async () => ({
	rpcRateLimitMiddleware: await passThrough(),
}));
vi.mock("../../../../orpc/middleware/tenant-context-middleware", async () => ({
	tenantContextMiddleware: await passThrough(),
	getOrganizationIdFromContext: vi.fn(),
	getTenantFilterFromContext: vi.fn(),
}));

import { authorizeRefineRun } from "../../lib/refine-request-turn";
import { refineRequestProcedure } from "../refine-request";

const context = { headers: new Headers() };
const MODEL = { modelId: "example-simple-model" };

const REPLY =
	"FEEDBACK: Which provider?\nUPDATED_MESSAGE: Add login with an example provider\nREADY: true";

const HISTORY = [
	{ role: "user" as const, content: "Use sessions" },
	{ role: "assistant" as const, content: "Cookie or token?" },
];

const GOLDEN_PROMPT = [
	"<project-context>",
	"Project: Example project",
	"Tech stack: TypeScript, Postgres",
	"Description: An example project",
	"</project-context>",
	"",
	"Current plan request:",
	"Add login",
	"",
	"",
	"Previous refinement exchanges:",
	"",
	"User: Use sessions",
	"",
	"Assistant: Cookie or token?",
	"",
	"",
	"User's latest input: Tokens, please",
].join("\n");

type Access =
	| { source: "none" }
	| {
			source: "owner" | "org" | "project-member";
			organizationId: string | null;
			permissions: readonly string[];
	  };

function access(value: Access) {
	mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
		organizationDeleted: false,
		...value,
	});
}

const ORG_MEMBER: Access = {
	source: "org",
	organizationId: ORG,
	permissions: ORG_ROLE_PERMISSIONS.member,
};

function refine(organizationId: string | null) {
	return call(
		refineRequestProcedure,
		{
			projectId: PROJECT_ID,
			organizationId,
			currentMessage: "Add login",
			refinementInput: "Tokens, please",
			history: HISTORY,
		},
		{ context },
	);
}

/**
 * The refusals both paths give, before any model is resolved, and the
 * project bound when each is raised, which the error row is attributed to.
 */
const REFUSALS: Array<{
	name: string;
	access: Access;
	organizationId?: string;
	projectAccess?: boolean;
	code: string;
	message: string;
	binding: AuthorizedProject | null;
}> = [
	{
		name: "no tie to the project",
		access: { source: "none" },
		code: "NOT_FOUND",
		message: "Project not found",
		binding: null,
	},
	{
		name: "an organization viewer",
		access: {
			source: "org",
			organizationId: ORG,
			permissions: ORG_ROLE_PERMISSIONS.viewer,
		},
		code: "FORBIDDEN",
		message: "Missing required permission: agent:execute",
		binding: null,
	},
	{
		name: "a project-member VIEWER",
		access: {
			source: "project-member",
			organizationId: ORG,
			permissions: PROJECT_ROLE_PERMISSIONS.VIEWER,
		},
		code: "FORBIDDEN",
		message: "Missing required permission: agent:execute",
		binding: null,
	},
	{
		name: "an organization other than the project's",
		access: ORG_MEMBER,
		organizationId: OTHER_ORG,
		code: "BAD_REQUEST",
		message: "organizationId does not match the project",
		binding: { projectId: PROJECT_ID, organizationId: ORG },
	},
	{
		name: "a personal project with an organization named",
		access: {
			source: "owner",
			organizationId: null,
			permissions: [],
		},
		code: "BAD_REQUEST",
		message: "organizationId does not match the project",
		binding: { projectId: PROJECT_ID, organizationId: null },
	},
	{
		name: "no project access",
		access: ORG_MEMBER,
		projectAccess: false,
		code: "FORBIDDEN",
		message: "You don't have access to this project",
		binding: { projectId: PROJECT_ID, organizationId: ORG },
	},
];

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getSession.mockResolvedValue({
		session: { activeOrganizationId: ORG },
		user: { id: USER_ID },
	});
	mocks.hasProjectAccess.mockResolvedValue(true);
	mocks.getAIModelWithMetadata.mockResolvedValue({
		model: MODEL,
		metadata: { modelString: "example-served", provider: "OPENAI_DIRECT" },
		trackUsage: mocks.trackUsage,
	});
	mocks.generateText.mockResolvedValue({ text: REPLY, usage: {} });
	access(ORG_MEMBER);
});

describe("weave.plans.refine", () => {
	it("reads the served fallback only after generation", async () => {
		const metadata = {
			modelString: "example-configured",
			provider: "OPENAI_CHATGPT_PLAN",
			answerSnapshot: {
				modelString: "example-plan",
				provider: "OPENAI_CHATGPT_PLAN",
			},
		};
		mocks.getAIModelWithMetadata.mockResolvedValueOnce({
			model: MODEL,
			metadata,
			trackUsage: mocks.trackUsage,
		});
		mocks.generateText.mockImplementationOnce(async () => {
			metadata.answerSnapshot = {
				modelString: "example-api-served",
				provider: "OPENAI_DIRECT",
			};
			return { text: REPLY, usage: {} };
		});
		expect(await refine(ORG)).toMatchObject({
			model: { id: "example-api-served", viaPlan: false },
		});
	});
	it("refines in the caller's organization with the SIMPLE model and the shared prompt", async () => {
		await expect(refine(ORG)).resolves.toEqual({
			success: true,
			feedback: "Which provider?",
			updatedMessage: "Add login with an example provider",
			isReady: true,
			model: {
				id: "example-served",
				provider: "OPENAI_DIRECT",
				viaPlan: false,
			},
		});

		expect(mocks.getAIModelWithMetadata).toHaveBeenCalledTimes(1);
		expect(mocks.getAIModelWithMetadata).toHaveBeenCalledWith(
			{ taskType: "SIMPLE" },
			{ userId: USER_ID, organizationId: ORG },
		);
		expect(mocks.trackUsage).toHaveBeenCalledTimes(1);
		expect(mocks.generateText).toHaveBeenCalledWith({
			model: MODEL,
			instructions: expect.stringContaining(
				"FEEDBACK: <your clarifying question or confirmation>",
			),
			prompt: GOLDEN_PROMPT,
		});
		expect(mocks.hasProjectAccess).toHaveBeenCalledWith(
			PROJECT_ID,
			USER_ID,
			ORG,
		);
	});

	it("runs in the project's organization when the input names none", async () => {
		await refine(null);

		expect(mocks.getAIModelWithMetadata).toHaveBeenCalledWith(
			{ taskType: "SIMPLE" },
			{ userId: USER_ID, organizationId: ORG },
		);
	});

	it.each(REFUSALS)(
		"refuses $name with $code before any model call",
		async (refusal) => {
			access(refusal.access);
			if (refusal.projectAccess === false) {
				mocks.hasProjectAccess.mockResolvedValue(false);
			}

			await expect(
				refine(refusal.organizationId ?? ORG),
			).rejects.toMatchObject({
				code: refusal.code,
				message: refusal.message,
			});

			expect(mocks.getAIModelWithMetadata).not.toHaveBeenCalled();
			expect(mocks.generateText).not.toHaveBeenCalled();
		},
	);

	it("lets a project-member EDITOR (a guest) refine", async () => {
		access({
			source: "project-member",
			organizationId: ORG,
			permissions: PROJECT_ROLE_PERMISSIONS.EDITOR,
		});

		await expect(refine(ORG)).resolves.toMatchObject({ success: true });
	});

	it("wraps a model failure as a refinement failure", async () => {
		mocks.generateText.mockRejectedValue(new Error("boom"));

		await expect(refine(ORG)).rejects.toMatchObject({
			code: "INTERNAL_SERVER_ERROR",
			message: "Refinement failed: boom",
		});
	});

	it("wraps a usage-limit refusal as a refinement failure", async () => {
		const limit = new AiUsageLimitExceededError({
			message: "The example limit is spent.",
			limitId: "limit-example-1",
			dimension: "SPEND_USD",
			window: "MONTHLY",
			used: 10n,
			max: 10n,
			manageLimitsUrl: "https://example.com/limits",
		});
		mocks.getAIModelWithMetadata.mockRejectedValue(limit);

		await expect(refine(ORG)).rejects.toMatchObject({
			code: "INTERNAL_SERVER_ERROR",
			message: "Refinement failed: The example limit is spent.",
		});
	});

	it("passes a ChatGPT plan sign-in refusal on as the plan's own error", async () => {
		mocks.generateText.mockRejectedValue(
			new ChatGptPlanAuthError("Sign in again", "invalid_grant", true),
		);

		await expect(refine(ORG)).rejects.toMatchObject({
			code: "PRECONDITION_FAILED",
			data: { code: "CHATGPT_PLAN_UNAVAILABLE" },
		});
	});
});

describe("authorizeRefineRun", () => {
	const authorize = (organizationId: string) =>
		authorizeRefineRun({
			userId: USER_ID,
			organizationId,
			projectId: PROJECT_ID,
			onRefusal: () => mocks.errorRowBinding(peekAuthorizedProject()),
		});

	it.each(REFUSALS)(
		"refuses $name with $code, as the procedure does",
		async (refusal) => {
			access(refusal.access);
			if (refusal.projectAccess === false) {
				mocks.hasProjectAccess.mockResolvedValue(false);
			}

			await expect(
				authorize(refusal.organizationId ?? ORG),
			).rejects.toMatchObject({
				code: refusal.code,
				message: refusal.message,
			});
			expect(mocks.errorRowBinding).toHaveBeenCalledExactlyOnceWith(
				refusal.binding,
			);
		},
	);

	it("admits a project-member EDITOR (a guest) in the project's organization", async () => {
		access({
			source: "project-member",
			organizationId: ORG,
			permissions: PROJECT_ROLE_PERMISSIONS.EDITOR,
		});

		await expect(authorize(ORG)).resolves.toEqual({
			authorized: { projectId: PROJECT_ID, organizationId: ORG },
			organizationId: ORG,
		});
		expect(mocks.hasProjectAccess).toHaveBeenCalledWith(
			PROJECT_ID,
			USER_ID,
			ORG,
		);
	});

	it("refuses another organization's project with no binding around the call", async () => {
		expect(hasProjectBindingHolder()).toBe(false);
		access({
			source: "org",
			organizationId: OTHER_ORG,
			permissions: ORG_ROLE_PERMISSIONS.member,
		});

		await expect(authorize(ORG)).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: "organizationId does not match the project",
		});
	});

	it("isolates a run from an ambient project binding and restores that binding", async () => {
		const ambient = {
			projectId: "project-example-ambient",
			organizationId: OTHER_ORG,
		};
		await runWithProjectBindingHolder(async () => {
			recordAuthorizedProject(ambient);
			await expect(authorize(ORG)).resolves.toEqual({
				authorized: { projectId: PROJECT_ID, organizationId: ORG },
				organizationId: ORG,
			});
			expect(peekAuthorizedProject()).toEqual(ambient);
		});
		expect(peekAuthorizedProject()).toBeNull();
		expect(hasProjectBindingHolder()).toBe(false);
	});
});
