/**
 * Real session authentication, project permission and organization binding chain;
 * observability/tenant DB setup and the canonical source reader are isolated.
 * Reader-specific live-ACL tests live alongside context-reader.ts.
 */
import { call } from "@orpc/server";
import { contextQualitySourceRevision } from "@repo/rag/lib/context-quality";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getSession: vi.fn(),
	permissions: vi.fn(),
	read: vi.fn(),
	grantProjectAccess: vi.fn(),
}));

const { passThrough } = vi.hoisted(() => ({
	passThrough: async () => {
		const { os } = await import("@orpc/server");
		return os.middleware(async ({ next }) => next());
	},
}));

vi.mock("@repo/auth", () => ({
	auth: { api: { getSession: mocks.getSession } },
}));
vi.mock("@repo/payments", () => ({}));
vi.mock("@repo/config", () => ({ config: {} }));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@repo/database", () => ({
	db: {},
	getTenantContext: () => ({ effectiveWriteOrgId: null }),
	getOrganizationMembership: vi.fn(),
	hasOrganizationTie: vi.fn(),
	isPlatformAdmin: vi.fn(),
	grantProjectAccess: mocks.grantProjectAccess,
	StoryVersionConflictError: class extends Error {},
}));
vi.mock("../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: mocks.permissions,
}));
vi.mock("../../../lib/rate-limit", () => ({
	checkRateLimit: async () => ({
		allowed: true,
		remaining: 1,
		resetInSeconds: 60,
	}),
	RATE_LIMIT_PRESETS: {},
}));
vi.mock("../../../orpc/middleware/request-counter-middleware", async () => ({
	requestCounterMiddleware: await passThrough(),
}));
vi.mock("../../../orpc/middleware/error-metrics-middleware", async () => ({
	errorMetricsMiddleware: await passThrough(),
}));
vi.mock("../../../orpc/middleware/audit-error-middleware", async () => ({
	auditErrorMiddleware: await passThrough(),
}));
vi.mock("../../../orpc/middleware/audit-timing-middleware", async () => ({
	auditTimingMiddleware: await passThrough(),
}));
vi.mock("../../../orpc/middleware/audit-activity-middleware", async () => ({
	auditActivityMiddleware: await passThrough(),
}));
vi.mock("../../../orpc/middleware/touch-last-seen", async () => ({
	touchLastSeenMiddleware: await passThrough(),
}));
vi.mock("../../../orpc/middleware/rpc-rate-limit-middleware", async () => ({
	rpcRateLimitMiddleware: await passThrough(),
}));
vi.mock("../../../orpc/middleware/tenant-context-middleware", async () => ({
	tenantContextMiddleware: await passThrough(),
	getOrganizationIdFromContext: vi.fn(),
	getTenantFilterFromContext: vi.fn(),
}));
vi.mock("../lib/context-reader", async (importOriginal) => ({
	...(await importOriginal<typeof import("../lib/context-reader")>()),
	readProjectContextSnapshot: mocks.read,
}));

import { evaluateProjectContext } from "../lib/commands";
import {
	ContextReadError,
	type ProjectContextReadInput,
} from "../lib/context-reader";
import { contextQualityRouter } from "../router";

const ORG = "org-example-alpha";
const PROJECT = "project-example-alpha";
const USER = "user-example-alpha";
const SOURCE = "source-example-alpha";
const CONTENT = "Example protected appointment policy.";
const REVISION = contextQualitySourceRevision(CONTENT);
const context = { headers: new Headers() };

function evaluation() {
	return {
		version: 1 as const,
		sources: [{ sourceId: SOURCE, expectedRevision: REVISION }],
		cases: [
			{
				id: "case-example-alpha",
				recordedAnswer: "Patients may cancel online.",
				retrievedSourceIds: [SOURCE],
				citedSourceIds: [SOURCE],
				expectations: {
					expectedSourceIds: [SOURCE],
					requiredPhrases: ["cancel online"],
					forbiddenPhrases: [],
				},
			},
		],
	};
}

function snapshot() {
	return {
		sourceId: SOURCE,
		sourceKind: "project_context" as const,
		projectId: PROJECT,
		organizationId: ORG,
		title: "Example policy",
		content: CONTENT,
		revision: REVISION,
		byteLength: Buffer.byteLength(CONTENT),
		indexingExcluded: false,
		readMode: "direct" as const,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getSession.mockResolvedValue({
		user: { id: USER },
		session: { activeOrganizationId: ORG },
	});
	mocks.permissions.mockResolvedValue({
		source: "org",
		organizationId: ORG,
		permissions: ["context:read"],
	});
	mocks.read.mockImplementation(async (input: ProjectContextReadInput) => {
		if (input.expectedRevision && input.expectedRevision !== REVISION) {
			throw new ContextReadError("STALE_REVISION");
		}
		return snapshot();
	});
});

describe("context quality oRPC contract", () => {
	it("never echoes confidential malformed evaluation property names in validation issues", async () => {
		const raw = {
			...evaluation(),
			"private example answer placed in a key": "private example value",
		};
		let failure: unknown;
		try {
			await call(
				contextQualityRouter.evaluate,
				{ projectId: PROJECT, evaluation: raw },
				{ context },
			);
		} catch (error) {
			failure = error;
		}
		expect(failure).toMatchObject({ code: "BAD_REQUEST" });
		expect(JSON.stringify(failure)).not.toContain("private example");
		expect(String(failure)).not.toContain("private example");
		expect(mocks.read).not.toHaveBeenCalled();
	});
	it("returns exactly the shared command report for the same recorded snapshot", async () => {
		const raw = evaluation();
		const direct = await evaluateProjectContext(
			{ organizationId: ORG, projectId: PROJECT, userId: USER },
			raw,
		);
		const rpc = await call(
			contextQualityRouter.evaluate,
			{ projectId: PROJECT, evaluation: raw },
			{ context },
		);
		expect(rpc).toEqual(direct);
	});
	it("authenticates inspection and forwards the authorized project organization", async () => {
		const result = await call(
			contextQualityRouter.inspect,
			{ projectId: PROJECT, sourceId: SOURCE },
			{ context },
		);
		expect(result).toEqual(snapshot());
		expect(mocks.read).toHaveBeenCalledWith({
			projectId: PROJECT,
			organizationId: ORG,
			userId: USER,
			sourceId: SOURCE,
		});
	});

	it("uses the same evaluation request as REST and the shared recorded-output engine", async () => {
		const raw = evaluation();
		const result = await call(
			contextQualityRouter.evaluate,
			{ projectId: PROJECT, evaluation: raw },
			{ context },
		);
		expect(result).toMatchObject({
			status: "passed",
			projectId: PROJECT,
			organizationId: ORG,
			counts: { cases: 1, passed: 1, failed: 0 },
		});
		expect(mocks.read).toHaveBeenCalledTimes(2);
		expect(JSON.stringify(result)).not.toContain(CONTENT);
		expect(JSON.stringify(result)).not.toContain(
			raw.cases[0].recordedAnswer,
		);
	});

	it("refuses an unauthenticated user before dispatch", async () => {
		mocks.getSession.mockResolvedValue(null);
		await expect(
			call(
				contextQualityRouter.inspect,
				{ projectId: PROJECT, sourceId: SOURCE },
				{ context },
			),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.permissions).not.toHaveBeenCalled();
		expect(mocks.read).not.toHaveBeenCalled();
	});

	it("refuses missing current context:read permission for both operations", async () => {
		mocks.permissions.mockResolvedValue({
			source: "project-member",
			organizationId: ORG,
			permissions: [],
		});
		await expect(
			call(
				contextQualityRouter.inspect,
				{ projectId: PROJECT, sourceId: SOURCE },
				{ context },
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			call(
				contextQualityRouter.evaluate,
				{ projectId: PROJECT, evaluation: evaluation() },
				{ context },
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.read).not.toHaveBeenCalled();
	});

	it("supports a project guest whose active organization differs from the host", async () => {
		mocks.getSession.mockResolvedValue({
			user: { id: USER },
			session: { activeOrganizationId: "org-example-home" },
		});
		mocks.permissions.mockResolvedValue({
			source: "project-member",
			organizationId: ORG,
			permissions: ["context:read"],
		});
		const result = await call(
			contextQualityRouter.evaluate,
			{ projectId: PROJECT, evaluation: evaluation() },
			{ context },
		);
		expect(result.organizationId).toBe(ORG);
		expect(mocks.grantProjectAccess).toHaveBeenCalledWith(PROJECT, ORG);
	});

	it("rejects a caller-supplied organization outside the project before dispatch", async () => {
		await expect(
			call(
				contextQualityRouter.evaluate,
				{
					projectId: PROJECT,
					organizationId: "org-example-bravo",
					evaluation: evaluation(),
				},
				{ context },
			),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.read).not.toHaveBeenCalled();
	});

	it("hides a project with no current user tie", async () => {
		mocks.permissions.mockResolvedValue({
			source: "none",
			organizationId: "org-example-bravo",
			permissions: [],
		});
		await expect(
			call(
				contextQualityRouter.inspect,
				{ projectId: "project-example-bravo", sourceId: SOURCE },
				{ context },
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.read).not.toHaveBeenCalled();
	});

	it("does not resolve a null organization into a personal context", async () => {
		mocks.permissions.mockResolvedValue({
			source: "owner",
			organizationId: null,
			permissions: [],
		});
		await expect(
			call(
				contextQualityRouter.inspect,
				{ projectId: PROJECT, sourceId: SOURCE },
				{ context },
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.read).not.toHaveBeenCalled();
	});

	it.each([
		["NOT_FOUND", "NOT_FOUND"],
		["FORBIDDEN", "FORBIDDEN"],
		["NOT_READY", "CONFLICT"],
		["STALE_REVISION", "CONFLICT"],
		["TOO_LARGE", "PAYLOAD_TOO_LARGE"],
	] as const)("maps reader %s to %s", async (readerCode, code) => {
		mocks.read.mockRejectedValue(new ContextReadError(readerCode));
		await expect(
			call(
				contextQualityRouter.evaluate,
				{ projectId: PROJECT, evaluation: evaluation() },
				{ context },
			),
		).rejects.toMatchObject({ code });
	});

	it("withholds a report when a source is erased during evaluation", async () => {
		mocks.read
			.mockResolvedValueOnce(snapshot())
			.mockRejectedValueOnce(new ContextReadError("NOT_FOUND"));
		await expect(
			call(
				contextQualityRouter.evaluate,
				{ projectId: PROJECT, evaluation: evaluation() },
				{ context },
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.read).toHaveBeenCalledTimes(2);
	});

	it("rejects a stale inspection pin with a safe conflict", async () => {
		const raw = evaluation();
		raw.sources[0].expectedRevision = "0".repeat(64);
		await expect(
			call(
				contextQualityRouter.evaluate,
				{ projectId: PROJECT, evaluation: raw },
				{ context },
			),
		).rejects.toMatchObject({
			code: "CONFLICT",
			message: "Context source changed. Read it again before evaluating.",
		});
	});

	it("rejects raw source bytes in an evaluation request before reading", async () => {
		const raw = {
			...evaluation(),
			sources: [{ ...evaluation().sources[0], content: CONTENT }],
		};
		await expect(
			call(
				contextQualityRouter.evaluate,
				{ projectId: PROJECT, evaluation: raw },
				{ context },
			),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.read).not.toHaveBeenCalled();
	});
});
