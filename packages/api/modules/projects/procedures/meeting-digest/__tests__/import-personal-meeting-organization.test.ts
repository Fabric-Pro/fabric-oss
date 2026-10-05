/**
 * Importing a personal meeting separates the two organizations it touches
 * (Fizzy #2904):
 *  - the DESTINATION — the context row and its embedding workflow — is the
 *    authorized project's organization;
 *  - the SOURCE — which of the caller's Microsoft connections the transcript is
 *    read through — is selected exactly as before the authorized-project
 *    binding, so it cannot silently switch (with an organization, the lookup
 *    falls back to a teammate's shared connection).
 * Exercised through the real procedure chain; only I/O is mocked.
 */
import { call } from "@orpc/server";
import { Permissions } from "@repo/permissions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG_PROJECT = "org-example-project";
const ORG_SESSION = "org-example-session";
const USER_ID = "user-example-1";

const mocks = vi.hoisted(() => ({
	getSession: vi.fn(),
	resolveEffectiveProjectPermissions: vi.fn(),
	executeMicrosoftTeamsTool: vi.fn(),
	createContext: vi.fn(),
	workflowStart: vi.fn(),
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
}));
vi.mock("@repo/database", () => ({
	db: { projectContext: { findFirst: vi.fn(async () => null) } },
	getTenantContext: () => ({ effectiveWriteOrgId: null }),
	getOrganizationMembership: vi.fn(async () => ({ role: "owner" })),
	grantProjectAccess: vi.fn(),
	StoryVersionConflictError: class extends Error {},
	hasProjectAccess: vi.fn(async () => true),
	isFeatureEnabled: vi.fn(async () => true),
	createContext: (...a: unknown[]) => mocks.createContext(...a),
}));
vi.mock("@repo/integrations/microsoft", () => ({
	executeMicrosoftTeamsTool: (...a: unknown[]) =>
		mocks.executeMicrosoftTeamsTool(...a),
}));
vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({
		workflow: { start: mocks.workflowStart },
	}),
}));
vi.mock("../personal-transcript-fetch", () => ({
	// Reads through the procedure's own Graph caller, so the organization it
	// hands the Microsoft tool is observable.
	fetchPersonalTranscriptContent: async ({
		callGraph,
	}: {
		callGraph: (m: string, a: Record<string, unknown>) => Promise<unknown>;
	}) => {
		await callGraph("get_online_meeting", {});
		return {
			content: "WEBVTT\n\nSpeaker: hello",
			meetingId: "meeting-1",
			transcriptId: "transcript-1",
		};
	},
}));
vi.mock("../../../../../lib/realtime", () => ({
	emitActivity: vi.fn(async () => undefined),
	emitContextChange: vi.fn(async () => undefined),
}));
vi.mock("../../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: (...a: unknown[]) =>
		mocks.resolveEffectiveProjectPermissions(...a),
}));
vi.mock("../../../../../lib/rate-limit", () => ({
	checkRateLimit: async () => ({ allowed: true }),
	RATE_LIMIT_PRESETS: {},
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
vi.mock("../../../../../orpc/middleware/audit-error-middleware", async () => ({
	auditErrorMiddleware: await passThrough(),
}));
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
		tenantContextMiddleware: await passThrough(),
		getOrganizationIdFromContext: vi.fn(),
		getTenantFilterFromContext: vi.fn(),
	}),
);

import { importPersonalMeetingProcedure } from "../import-personal-meeting";

const context = { headers: new Headers() };

function importMeeting(organizationId: string | null | undefined) {
	return call(
		importPersonalMeetingProcedure,
		{
			projectId: "project-1",
			joinUrl: "https://teams.example.com/l/meetup-join/example",
			...(organizationId === undefined ? {} : { organizationId }),
		},
		{ context },
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getSession.mockResolvedValue({
		session: { activeOrganizationId: ORG_SESSION },
		user: { id: USER_ID },
	});
	mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
		source: "org",
		organizationId: ORG_PROJECT,
		permissions: [Permissions.CONTEXT_CREATE],
		organizationDeleted: false,
	});
	mocks.executeMicrosoftTeamsTool.mockResolvedValue({});
	mocks.createContext.mockResolvedValue({ id: "context-1" });
	mocks.workflowStart.mockResolvedValue({});
});

describe("importPersonalMeeting — source and destination organizations", () => {
	it("explicit null: reads through the personal connection, stores in the project's organization", async () => {
		await importMeeting(null);

		// Fourth argument: the organization the connection is selected under.
		expect(
			mocks.executeMicrosoftTeamsTool.mock.calls[0]?.[3],
		).toBeUndefined();
		expect(mocks.createContext).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: ORG_PROJECT }),
		);
		const workflowArgs = mocks.workflowStart.mock.calls[0]?.[1] as {
			args: Array<{ organizationId?: string }>;
		};
		expect(workflowArgs.args[0]?.organizationId).toBe(ORG_PROJECT);
	});

	it("omitted: reads through the session's connection, stores in the project's organization", async () => {
		await importMeeting(undefined);

		expect(mocks.executeMicrosoftTeamsTool.mock.calls[0]?.[3]).toBe(
			ORG_SESSION,
		);
		expect(mocks.createContext).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: ORG_PROJECT }),
		);
	});

	it("another organization named: refused before Graph is called or anything is stored", async () => {
		await expect(importMeeting(ORG_SESSION)).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		expect(mocks.executeMicrosoftTeamsTool).not.toHaveBeenCalled();
		expect(mocks.createContext).not.toHaveBeenCalled();
	});
});
