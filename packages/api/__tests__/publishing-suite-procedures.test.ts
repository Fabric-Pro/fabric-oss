/**
 * Publishing Suite oRPC procedures (Phase 1A Plan 3 Task 2).
 *
 * Two harnesses are used, mirroring existing repo conventions:
 *
 *  1. A faked `tenantProtectedProcedure` / `requireProjectPermission` chain
 *     builder (identical technique to
 *     `packages/api/modules/projects/procedures/test-cases/__tests__/*.test.ts`)
 *     that exposes each procedure's raw `.handler` for direct invocation and
 *     records the declared permission key on `__permission`. This covers
 *     handler behavior: flag gating, forwarding the raw client org to
 *     `createManualPublishingTopic` as an F2 guard input (tenant columns are
 *     derived atomically under a Project row lock INSIDE the helper, never from
 *     client input — P1/N1, C-High), and mapping the helper's typed outcomes
 *     (project-not-found -> NOT_FOUND, tenant-mismatch -> BAD_REQUEST, P2002 ->
 *     CONFLICT).
 *
 *  2. The REAL `requireProjectPermission` middleware (imported directly from
 *     `../orpc/middleware/require-permission`, unmocked — same technique as
 *     `packages/api/__tests__/require-project-permission.test.ts`) composed
 *     with the REAL `@repo/permissions` role tables. This proves the
 *     security-critical claim that a project-scoped Viewer is actually
 *     denied `PUBLISHING_TOPIC_UPDATE` — the fake chain in (1) only records
 *     which permission key a procedure declares, it does not enforce it.
 */

import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
	projectFindUnique: vi.fn(),
	projectMemberFindUnique: vi.fn(),
	memberFindFirst: vi.fn(),
}));

const flagMocks = vi.hoisted(() => ({
	isPublishingSuiteEnabled: vi.fn(() => true),
}));

// generateNow's handler delegates to this helper after its own project lookup
// + org guard; its own dedicated test coverage
// (request-publishing-generation.test.ts) already exercises the cooldown/
// in-flight/unavailable/started logic inside it, so it is mocked here the
// same way createManualPublishingTopic is mocked for createTopic below.
const generateNowMocks = vi.hoisted(() => ({
	requestPublishingGeneration: vi.fn(),
}));

const {
	FakePrismaClientKnownRequestError,
	FakePublishingTopicProjectNotFoundError,
	FakePublishingTopicTenantMismatchError,
} = vi.hoisted(() => {
	class FakePrismaClientKnownRequestError extends Error {
		code: string;
		constructor(message: string, opts: { code: string }) {
			super(message);
			this.name = "PrismaClientKnownRequestError";
			this.code = opts.code;
		}
	}
	// Mirror the real typed errors createManualPublishingTopic now throws (C-High
	// atomic tenant re-lock). The procedure maps them to NOT_FOUND / BAD_REQUEST;
	// tests reject the mocked helper with instances of these SAME classes so the
	// procedure's `instanceof` checks resolve.
	class FakePublishingTopicProjectNotFoundError extends Error {
		constructor(readonly projectId: string) {
			super(`Project ${projectId} not found`);
			this.name = "PublishingTopicProjectNotFoundError";
		}
	}
	class FakePublishingTopicTenantMismatchError extends Error {
		constructor(readonly projectId: string) {
			super(`organizationId does not match project ${projectId}`);
			this.name = "PublishingTopicTenantMismatchError";
		}
	}
	return {
		FakePrismaClientKnownRequestError,
		FakePublishingTopicProjectNotFoundError,
		FakePublishingTopicTenantMismatchError,
	};
});

vi.mock("@repo/database", () => ({
	db: {
		// generate-now.ts looks up the project via `findFirst` (it adds a
		// status/deletedAt eligibility filter alongside the id, so it is not a
		// pure unique lookup) — backed by the same mock fn as `findUnique`,
		// which the other procedures below and the real-middleware describe
		// use for their own plain id lookups.
		project: {
			findUnique: dbMocks.projectFindUnique,
			findFirst: dbMocks.projectFindUnique,
		},
		projectMember: { findUnique: dbMocks.projectMemberFindUnique },
		member: { findFirst: dbMocks.memberFindFirst },
	},
	grantProjectAccess: vi.fn(),
	getOrganizationMembership: vi.fn(),
	getTenantContext: vi.fn(() => ({})),
	getPublishingTopic: vi.fn(),
	listPublishingTopics: vi.fn(),
	getLatestPublishingCycle: vi.fn(),
	// 1C-4a: the cycle-history reader and its matching count.
	listPublishingCycles: vi.fn(),
	countPublishingCycles: vi.fn(),
	// Per-cycle reach, counted in people rather than in ledger rows.
	countPublishingCycleRecipients: vi.fn(),
	// 1C-4b: the per-channel ledger reader and the channel-name resolver.
	listPublishingChatDeliveriesForProjectCycle: vi.fn(),
	getLinkedChannelNames: vi.fn(),
	createManualPublishingTopic: vi.fn(),
	updatePublishingTopicStatus: vi.fn(),
	updatePublishingTopicPostTypes: vi.fn(),
	setPublishingTopicSnooze: vi.fn(),
	setPublishingTopicReadState: vi.fn(),
	// A REAL array, never vi.fn(): set-topic-snooze.ts builds
	// `z.enum(PUBLISHING_SNOOZE_PRESETS)` at MODULE scope, and
	// `z.enum(undefined)` throws at construction — which fails this file at
	// collection with an error three files away from its cause.
	PUBLISHING_SNOOZE_PRESETS: ["ONE_WEEK", "ONE_MONTH", "THREE_MONTHS"],
	resolveProjectTenant: vi.fn(),
	PublishingTopicProjectNotFoundError:
		FakePublishingTopicProjectNotFoundError,
	PublishingTopicTenantMismatchError: FakePublishingTopicTenantMismatchError,
	Prisma: {
		PrismaClientKnownRequestError: FakePrismaClientKnownRequestError,
	},
	// Settings read/write procedures now share this barrel (Task 4), so their
	// module-scope `z.enum(PUBLISHING_CADENCES)` / `.min(MIN_...).max(MAX_...)`
	// need these to resolve even though this file doesn't exercise them.
	//
	// THE OBLIGATION IS ON THE BARREL, NOT ON THIS FILE'S SUBJECT MATTER: every
	// module-scope value any procedure in `procedures/publishing-suite` reads at
	// IMPORT time has to be a real value here, because the whole barrel loads
	// before a single case runs. A missing one is not a failing assertion — it is
	// the entire file failing to collect. So when a sibling procedure grows a
	// module-scope schema, this mock grows with it, and the way to notice is to
	// run the WHOLE `@repo/api` suite rather than the file you edited.
	//
	// The values must also be REAL, never `vi.fn()`: `z.enum(undefined)` throws
	// at construction, which is exactly the shape of the 1C-3 breakage.
	getPublishingSuiteSettings: vi.fn(),
	upsertPublishingSuiteSettings: vi.fn(),
	PublishingSettingsProjectNotFoundError: class extends Error {},
	PublishingSettingsTenantMismatchError: class extends Error {},
	PUBLISHING_CADENCES: ["MANUAL", "WEEKLY", "BIWEEKLY", "MONTHLY"],
	MIN_PUBLISHING_LOOKBACK_DAYS: 1,
	MAX_PUBLISHING_LOOKBACK_DAYS: 365,
	// 1C-3: update-settings.ts builds `z.enum(PUBLISHING_CHAT_PLATFORMS)` at
	// module scope, and its handler resolves the project's live linked channels.
	PUBLISHING_CHAT_PLATFORMS: ["TEAMS", "SLACK"],
	getLinkedTeamsChannels: vi.fn(),
	getLinkedSlackChannels: vi.fn(),
	// 1C-2: the recommendation-preference fields, whose bounds and vocabulary
	// update-settings.ts also reads at module scope — the case the warning above
	// describes, arriving for real. Real numbers rather than 0 or 1: a bound of 0
	// builds a schema that rejects everything, so a later case added to this file
	// would fail against a limit no reviewer would think to suspect.
	PUBLISHING_TOPIC_POST_TYPES: [
		"TWEET",
		"BLOG_POST",
		"CASE_STUDY",
		"STAKEHOLDER_EMAIL",
	],
	MAX_PUBLISHING_PREFERENCE_ITEMS: 25,
	MAX_PUBLISHING_PREFERENCE_ITEM_LENGTH: 60,
	MAX_PUBLISHING_STRATEGIC_PRIORITIES_LENGTH: 2000,
	// A REAL function, not vi.fn(): update-settings.ts passes this straight to
	// `.transform()` while BUILDING its schema at module load, so a mock
	// returning undefined would make every theme fail the piped `.min(1)` —
	// a suite-wide failure whose cause is three files away.
	normalizePreferenceLabel: (value: unknown) =>
		typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "",
}));

vi.mock("@repo/utils/feature-flag", () => ({
	isPublishingSuiteEnabled: flagMocks.isPublishingSuiteEnabled,
}));

// `generateNow` (Task 7) now shares this barrel. Its own helper,
// `requestPublishingGeneration`, imports `isTemporalAvailable` from
// `@repo/temporal` — replace the whole package rather than chase every export
// its real (huge) module graph transitively touches via @repo/ai /
// @repo/payments. The generateNow tests below mock the helper itself (see
// generateNowMocks), so this mock is never actually exercised by them; it
// stays so the OTHER procedures in this file, which only load the barrel and
// never call generateNow's handler, still resolve `@repo/temporal` cleanly.
vi.mock("@repo/temporal", () => ({
	isTemporalAvailable: vi.fn(),
}));

vi.mock("../modules/projects/lib/request-publishing-generation", () => ({
	requestPublishingGeneration: generateNowMocks.requestPublishingGeneration,
}));

vi.mock("../orpc/procedures", () => {
	const chain: Record<string, unknown> = {};
	for (const m of ["use", "route", "output"]) {
		chain[m] = () => chain;
	}
	chain.input = (schema: unknown) => {
		chain.__input = schema;
		return chain;
	};
	chain.handler = (fn: unknown) => {
		const permission = chain.__permission;
		// RESET after snapshotting. One `chain` is shared by every procedure
		// module in this mock, and `requireProjectPermission` mutates it, so
		// without this `__permission` is a global that survives across module
		// boundaries: a procedure declaring NO gate inherits whatever the module
		// evaluated before it left behind, and its gating assertion passes
		// vacuously. Under the barrel's ordering that inherited value is often
		// the very constant the assertion expects.
		chain.__permission = undefined;
		const input = chain.__input;
		// Same reset, same reason: without it a procedure that declares no
		// schema inherits whichever schema the previously-loaded module left
		// behind, and the schema-boundary assertion passes vacuously against
		// someone else's schema.
		chain.__input = undefined;
		return { handler: fn, __permission: permission, __input: input };
	};
	return {
		tenantProtectedProcedure: chain,
		requireProjectPermission: (p: string) => {
			chain.__permission = p;
			return () => chain;
		},
		Permissions: {
			PUBLISHING_TOPIC_READ: "publishing-topic:read",
			PUBLISHING_TOPIC_CREATE: "publishing-topic:create",
			PUBLISHING_TOPIC_UPDATE: "publishing-topic:update",
		},
	};
});

import {
	countPublishingCycleRecipients,
	countPublishingCycles,
	createManualPublishingTopic,
	getLatestPublishingCycle,
	getLinkedChannelNames,
	getPublishingSuiteSettings,
	listPublishingChatDeliveriesForProjectCycle,
	listPublishingCycles,
	getPublishingTopic,
	listPublishingTopics,
	Prisma,
	PublishingTopicProjectNotFoundError,
	PublishingTopicTenantMismatchError,
	setPublishingTopicReadState,
	setPublishingTopicSnooze,
	updatePublishingTopicPostTypes,
	updatePublishingTopicStatus,
} from "@repo/database";
import { Permissions } from "@repo/permissions";
import {
	createPublishingTopicProcedure,
	generatePublishingTopicsNowProcedure,
	getPublishingTopicProcedure,
	latestPublishingCycleProcedure,
	listCycleChatDeliveriesProcedure,
	listPublishingCyclesProcedure,
	listPublishingTopicsProcedure,
	setTopicReadStateProcedure,
	setTopicSnoozeProcedure,
	updatePublishingTopicPostTypesProcedure,
	updatePublishingTopicStatusProcedure,
} from "../modules/projects/procedures/publishing-suite";

type HandlerBearing = {
	handler: Function;
	__permission: string;
	__input: { safeParse: (v: unknown) => { success: boolean } };
};

const listHandler = (listPublishingTopicsProcedure as unknown as HandlerBearing)
	.handler;
const latestHandler = (
	latestPublishingCycleProcedure as unknown as HandlerBearing
).handler;
const createHandler = (
	createPublishingTopicProcedure as unknown as HandlerBearing
).handler;
const updateHandler = (
	updatePublishingTopicStatusProcedure as unknown as HandlerBearing
).handler;
const updatePostTypesHandler = (
	updatePublishingTopicPostTypesProcedure as unknown as HandlerBearing
).handler;
const generateNowHandler = (
	generatePublishingTopicsNowProcedure as unknown as HandlerBearing
).handler;
const listCyclesHandler = (
	listPublishingCyclesProcedure as unknown as HandlerBearing
).handler;
const chatDeliveriesHandler = (
	listCycleChatDeliveriesProcedure as unknown as HandlerBearing
).handler;
const snoozeHandler = setTopicSnoozeProcedure as unknown as HandlerBearing;
const readStateHandler =
	setTopicReadStateProcedure as unknown as HandlerBearing;

const ctx = {
	user: { id: "u1", name: "U", email: "u@example.com" },
	session: {},
};

beforeEach(() => {
	vi.clearAllMocks();
	flagMocks.isPublishingSuiteEnabled.mockReturnValue(true);
	// 1C-4b: `listCycles` now reads the settings row for `chatChannelsConfigured`.
	// A default RETURN, not just a `vi.fn()` — every pre-existing listCycles case
	// would otherwise receive undefined and throw on `settings.chatChannels`,
	// turning a whole describe block red for a reason that is not a finding.
	vi.mocked(getPublishingSuiteSettings).mockResolvedValue({
		chatChannels: [],
	} as never);
});

describe("publishing-suite procedures — permission gating", () => {
	it("listTopics is gated on PUBLISHING_TOPIC_READ", () => {
		expect(
			(listPublishingTopicsProcedure as unknown as HandlerBearing)
				.__permission,
		).toBe(Permissions.PUBLISHING_TOPIC_READ);
	});

	it("latestCycle is gated on PUBLISHING_TOPIC_READ", () => {
		expect(
			(latestPublishingCycleProcedure as unknown as HandlerBearing)
				.__permission,
		).toBe(Permissions.PUBLISHING_TOPIC_READ);
	});

	it("createTopic is gated on PUBLISHING_TOPIC_CREATE", () => {
		expect(
			(createPublishingTopicProcedure as unknown as HandlerBearing)
				.__permission,
		).toBe(Permissions.PUBLISHING_TOPIC_CREATE);
	});

	it("updateTopicStatus is gated on PUBLISHING_TOPIC_UPDATE", () => {
		expect(
			(updatePublishingTopicStatusProcedure as unknown as HandlerBearing)
				.__permission,
		).toBe(Permissions.PUBLISHING_TOPIC_UPDATE);
	});

	it("updateTopicPostTypes is gated on PUBLISHING_TOPIC_UPDATE", () => {
		expect(
			(
				updatePublishingTopicPostTypesProcedure as unknown as HandlerBearing
			).__permission,
		).toBe(Permissions.PUBLISHING_TOPIC_UPDATE);
	});

	it("generateNow is gated on PUBLISHING_TOPIC_CREATE", () => {
		expect(
			(generatePublishingTopicsNowProcedure as unknown as HandlerBearing)
				.__permission,
		).toBe(Permissions.PUBLISHING_TOPIC_CREATE);
	});
});

describe("getTopic", () => {
	const getHandler = (
		getPublishingTopicProcedure as unknown as HandlerBearing
	).handler;

	it("is gated on PUBLISHING_TOPIC_READ", () => {
		expect(
			(getPublishingTopicProcedure as unknown as HandlerBearing)
				.__permission,
		).toBe(Permissions.PUBLISHING_TOPIC_READ);
	});

	it("returns the topic and passes the viewer through", async () => {
		vi.mocked(getPublishingTopic).mockResolvedValue({
			topic: { id: "t1", title: "A topic" },
		} as never);

		const res = await getHandler({
			input: { projectId: "p1", topicId: "t1", organizationId: null },
			context: ctx,
		});

		expect(getPublishingTopic).toHaveBeenCalledWith({
			id: "t1",
			projectId: "p1",
			viewerUserId: "u1",
		});
		expect(res).toEqual({ topic: { id: "t1", title: "A topic" } });
	});

	it("throws NOT_FOUND when the topic is not in this project", async () => {
		// DV16: a topic id from another project must be indistinguishable from
		// a topic that does not exist, so the page cannot be used to probe for
		// topics in projects the viewer cannot see.
		vi.mocked(getPublishingTopic).mockResolvedValue(null as never);

		await expect(
			getHandler({
				input: {
					projectId: "p1",
					topicId: "foreign",
					organizationId: null,
				},
				context: ctx,
			}),
		).rejects.toThrow(/not found/i);
	});
});

describe("listTopics", () => {
	it("returns items from listPublishingTopics", async () => {
		vi.mocked(listPublishingTopics).mockResolvedValue({
			items: [{ id: "t1" }],
		} as never);

		const res = await listHandler({
			input: { projectId: "p1", organizationId: null },
			context: ctx,
		});

		expect(listPublishingTopics).toHaveBeenCalledWith({
			projectId: "p1",
			status: undefined,
			viewerUserId: "u1",
		});
		expect(res).toEqual({ items: [{ id: "t1" }] });
	});

	it("passes the authenticated user's id as viewerUserId", async () => {
		vi.mocked(listPublishingTopics).mockResolvedValue({
			items: [],
		} as never);

		await listHandler({
			input: { projectId: "p1", organizationId: null },
			context: {
				user: { id: "viewer-1", name: "V", email: "v@example.com" },
				session: {},
			},
		});

		expect(listPublishingTopics).toHaveBeenCalledWith(
			expect.objectContaining({ viewerUserId: "viewer-1" }),
		);
	});
});

describe("latestCycle", () => {
	it("returns the latest cycle", async () => {
		vi.mocked(getLatestPublishingCycle).mockResolvedValue({
			id: "c1",
			status: "READY",
			startedAt: new Date("2026-07-01"),
			completedAt: new Date("2026-07-01"),
		} as never);

		const res = await latestHandler({
			input: { projectId: "p1", organizationId: null },
			context: ctx,
		});

		expect(getLatestPublishingCycle).toHaveBeenCalledWith("p1");
		expect(res).toMatchObject({ cycle: { id: "c1" } });
	});
});

describe("createTopic", () => {
	// C-High: the handler no longer resolves the tenant itself — tenant
	// resolution + the F2 client-org guard now happen ATOMICALLY inside
	// createManualPublishingTopic (Project row re-locked FOR UPDATE, tuple
	// re-derived under lock). The handler forwards the raw client org as an F2
	// guard input (NEVER stamped) and maps the helper's typed outcomes to ORPC
	// error codes. These unit tests assert that mapping; the atomic tenant
	// derivation itself is proven against real Postgres in
	// packages/database/__tests__/publishing-suite-queries.test.ts.
	it("forwards the client org as an F2 guard input (never stamped) and returns the created MANUAL/SELECTED topic", async () => {
		vi.mocked(createManualPublishingTopic).mockResolvedValue({
			topic: { id: "t1", status: "SELECTED", origin: "MANUAL" },
		} as never);

		const res = await createHandler({
			input: {
				projectId: "p1",
				organizationId: "org-1",
				title: "New topic",
				description: null,
			},
			context: ctx,
		});

		expect(createManualPublishingTopic).toHaveBeenCalledWith({
			projectId: "p1",
			clientOrganizationId: "org-1", // F2 guard only — tenant columns are Project-derived inside the helper
			createdById: "u1",
			title: "New topic",
			description: null,
		});
		expect(res).toEqual({
			topic: { id: "t1", status: "SELECTED", origin: "MANUAL" },
		});
	});

	it("F2a: an invited guest sending organizationId:null forwards clientOrganizationId:null and succeeds — NOT BAD_REQUEST", async () => {
		// The guest's session has no active org (personal-context page), so the
		// client sends `organizationId: null`. requireProjectPermission already
		// authorized them before the handler runs. null/omitted must pass — the
		// helper derives the tenant from the Project row regardless.
		vi.mocked(createManualPublishingTopic).mockResolvedValue({
			topic: { id: "t2", status: "SELECTED", origin: "MANUAL" },
		} as never);

		const res = await createHandler({
			input: {
				projectId: "p1",
				organizationId: null,
				title: "Guest topic",
			},
			context: ctx,
		});

		expect(createManualPublishingTopic).toHaveBeenCalledWith(
			expect.objectContaining({ clientOrganizationId: null }),
		);
		expect(res).toEqual({
			topic: { id: "t2", status: "SELECTED", origin: "MANUAL" },
		});
	});

	it("F2b: a PublishingTopicTenantMismatchError (positively-wrong non-null org) maps to BAD_REQUEST", async () => {
		vi.mocked(createManualPublishingTopic).mockRejectedValue(
			new PublishingTopicTenantMismatchError("p1"),
		);

		await expect(
			createHandler({
				input: {
					projectId: "p1",
					organizationId: "org-wrong",
					title: "New topic",
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("maps PublishingTopicProjectNotFoundError to NOT_FOUND", async () => {
		vi.mocked(createManualPublishingTopic).mockRejectedValue(
			new PublishingTopicProjectNotFoundError("missing"),
		);

		await expect(
			createHandler({
				input: {
					projectId: "missing",
					organizationId: null,
					title: "T",
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("maps a P2002 dedupe conflict to CONFLICT", async () => {
		vi.mocked(createManualPublishingTopic).mockRejectedValue(
			new Prisma.PrismaClientKnownRequestError(
				"Unique constraint failed",
				{
					code: "P2002",
				} as never,
			),
		);

		await expect(
			createHandler({
				input: { projectId: "p1", organizationId: null, title: "Dup" },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});

	it("rethrows non-typed, non-P2002 errors from createManualPublishingTopic", async () => {
		vi.mocked(createManualPublishingTopic).mockRejectedValue(
			new Error("boom"),
		);

		await expect(
			createHandler({
				input: { projectId: "p1", organizationId: null, title: "T" },
				context: ctx,
			}),
		).rejects.toThrow("boom");
	});
});

describe("updateTopicStatus", () => {
	it("updates status and returns the topic", async () => {
		vi.mocked(updatePublishingTopicStatus).mockResolvedValue({
			topic: { id: "t1", status: "DECLINED" },
		} as never);

		const res = await updateHandler({
			input: {
				projectId: "p1",
				topicId: "t1",
				status: "DECLINED",
				declineReason: "not a fit",
			},
			context: ctx,
		});

		expect(updatePublishingTopicStatus).toHaveBeenCalledWith({
			id: "t1",
			projectId: "p1",
			status: "DECLINED",
			declineReason: "not a fit",
		});
		expect(res).toEqual({ topic: { id: "t1", status: "DECLINED" } });
	});

	it("NOT_FOUND when the topic does not resolve in the project", async () => {
		vi.mocked(updatePublishingTopicStatus).mockResolvedValue(null);

		await expect(
			updateHandler({
				input: {
					projectId: "p1",
					topicId: "missing",
					status: "DECLINED",
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("forwards publishedUrl to the DB helper when publishing", async () => {
		vi.mocked(updatePublishingTopicStatus).mockResolvedValue({
			topic: {
				id: "t1",
				status: "PUBLISHED",
				publishedUrl: "https://example.com/post",
			},
		} as never);

		const res = await updateHandler({
			input: {
				projectId: "p1",
				topicId: "t1",
				status: "PUBLISHED",
				publishedUrl: "https://example.com/post",
			},
			context: ctx,
		});

		expect(updatePublishingTopicStatus).toHaveBeenCalledWith({
			id: "t1",
			projectId: "p1",
			status: "PUBLISHED",
			declineReason: undefined,
			publishedUrl: "https://example.com/post",
		});
		expect(res).toEqual({
			topic: {
				id: "t1",
				status: "PUBLISHED",
				publishedUrl: "https://example.com/post",
			},
		});
	});
});

describe("updateTopicPostTypes", () => {
	it("forwards a non-empty override and returns the topic", async () => {
		vi.mocked(updatePublishingTopicPostTypes).mockResolvedValue({
			topic: { id: "t1" },
		} as never);
		const res = await updatePostTypesHandler({
			input: {
				projectId: "p1",
				topicId: "t1",
				postTypes: ["TWEET", "BLOG_POST"],
			},
			context: ctx,
		});
		expect(updatePublishingTopicPostTypes).toHaveBeenCalledWith({
			id: "t1",
			projectId: "p1",
			postTypes: ["TWEET", "BLOG_POST"],
		});
		expect(res).toEqual({ topic: { id: "t1" } });
	});

	it("forwards null to reset the override to the AI suggestion", async () => {
		vi.mocked(updatePublishingTopicPostTypes).mockResolvedValue({
			topic: { id: "t1" },
		} as never);
		await updatePostTypesHandler({
			input: { projectId: "p1", topicId: "t1", postTypes: null },
			context: ctx,
		});
		expect(updatePublishingTopicPostTypes).toHaveBeenCalledWith(
			expect.objectContaining({ postTypes: null }),
		);
	});

	it("forwards an empty array (clear) — distinct from null", async () => {
		vi.mocked(updatePublishingTopicPostTypes).mockResolvedValue({
			topic: { id: "t1" },
		} as never);
		await updatePostTypesHandler({
			input: { projectId: "p1", topicId: "t1", postTypes: [] },
			context: ctx,
		});
		expect(updatePublishingTopicPostTypes).toHaveBeenCalledWith(
			expect.objectContaining({ postTypes: [] }),
		);
	});

	it("NOT_FOUND when the topic does not resolve in the project", async () => {
		vi.mocked(updatePublishingTopicPostTypes).mockResolvedValue(null);
		await expect(
			updatePostTypesHandler({
				input: {
					projectId: "p1",
					topicId: "missing",
					postTypes: ["TWEET"],
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});

describe("generateNow", () => {
	it("looks up the project, then dispatches through requestPublishingGeneration", async () => {
		dbMocks.projectFindUnique.mockResolvedValue({
			id: "p1",
			organizationId: null,
			userId: "owner-1",
		});
		generateNowMocks.requestPublishingGeneration.mockResolvedValue({
			status: "started",
		});

		const res = await generateNowHandler({
			input: { projectId: "p1", organizationId: null },
			context: ctx,
		});

		expect(
			generateNowMocks.requestPublishingGeneration,
		).toHaveBeenCalledWith({
			projectId: "p1",
			triggeredByUserId: "u1",
		});
		expect(res).toEqual({ status: "started" });
	});

	it("F3: scopes the project lookup with the eligibility filter (status ACTIVE, deletedAt null) so an archived or soft-deleted project reads as NOT_FOUND instead of a false start", async () => {
		dbMocks.projectFindUnique.mockResolvedValue({
			id: "p1",
			organizationId: null,
			userId: "owner-1",
		});
		generateNowMocks.requestPublishingGeneration.mockResolvedValue({
			status: "started",
		});

		await generateNowHandler({
			input: { projectId: "p1", organizationId: null },
			context: ctx,
		});

		expect(dbMocks.projectFindUnique).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "p1", status: "ACTIVE", deletedAt: null },
			}),
		);
	});

	it("NOT_FOUND when the project lookup finds nothing", async () => {
		dbMocks.projectFindUnique.mockResolvedValue(null);

		await expect(
			generateNowHandler({
				input: { projectId: "missing", organizationId: null },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(
			generateNowMocks.requestPublishingGeneration,
		).not.toHaveBeenCalled();
	});

	// Mirrors the F2a/F2b org-guard cases in the createTopic describe above —
	// the only non-trivial branch in generate-now.ts (`!= null` / `?? null`).
	it("F2a: a null organizationId passes for an org-owned project — the guest case must not regress", async () => {
		dbMocks.projectFindUnique.mockResolvedValue({
			id: "p1",
			organizationId: "org-1",
			userId: "owner-1",
		});
		generateNowMocks.requestPublishingGeneration.mockResolvedValue({
			status: "started",
		});

		const res = await generateNowHandler({
			input: { projectId: "p1", organizationId: null },
			context: ctx,
		});

		expect(res).toEqual({ status: "started" });
		// The guard passed (no BAD_REQUEST) and the call reached through with
		// the resolved project's id — requestPublishingGeneration no longer
		// takes a `project` field; it re-reads the project itself.
		expect(
			generateNowMocks.requestPublishingGeneration,
		).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p1" }));
	});

	it("F2b: a non-null organizationId that does not match the project's own organizationId is rejected as BAD_REQUEST", async () => {
		dbMocks.projectFindUnique.mockResolvedValue({
			id: "p1",
			organizationId: "org-1",
			userId: "owner-1",
		});

		await expect(
			generateNowHandler({
				input: { projectId: "p1", organizationId: "org-wrong" },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(
			generateNowMocks.requestPublishingGeneration,
		).not.toHaveBeenCalled();
	});
});

describe("feature flag gating — flag OFF is NOT_FOUND for every procedure", () => {
	beforeEach(() => {
		flagMocks.isPublishingSuiteEnabled.mockReturnValue(false);
	});

	it("listTopics", async () => {
		await expect(
			listHandler({
				input: { projectId: "p1", organizationId: null },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(listPublishingTopics).not.toHaveBeenCalled();
	});

	it("latestCycle", async () => {
		await expect(
			latestHandler({
				input: { projectId: "p1", organizationId: null },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(getLatestPublishingCycle).not.toHaveBeenCalled();
	});

	it("createTopic", async () => {
		await expect(
			createHandler({
				input: { projectId: "p1", organizationId: null, title: "T" },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(createManualPublishingTopic).not.toHaveBeenCalled();
	});

	it("updateTopicStatus", async () => {
		await expect(
			updateHandler({
				input: { projectId: "p1", topicId: "t1", status: "DECLINED" },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(updatePublishingTopicStatus).not.toHaveBeenCalled();
	});

	it("updateTopicPostTypes", async () => {
		await expect(
			updatePostTypesHandler({
				input: {
					projectId: "p1",
					topicId: "t1",
					postTypes: ["TWEET"],
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(updatePublishingTopicPostTypes).not.toHaveBeenCalled();
	});

	it("generateNow", async () => {
		await expect(
			generateNowHandler({
				input: { projectId: "p1", organizationId: null },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(
			generateNowMocks.requestPublishingGeneration,
		).not.toHaveBeenCalled();
	});
});

describe("requireProjectPermission — PUBLISHING_TOPIC_UPDATE real enforcement", () => {
	// This block deliberately bypasses the faked chain above and exercises the
	// REAL middleware (mirrors packages/api/__tests__/require-project-permission.test.ts)
	// composed with the REAL @repo/permissions role tables, so the FORBIDDEN
	// claim is backed by actual role-resolution logic, not a stub.
	const PROJECT_ID = "proj-1";
	const ORG_ID = "org-A";
	const OWNER_ID = "user-owner";
	const VIEWER_ID = "user-viewer";
	const EDITOR_ID = "user-editor";

	type MwContext = {
		user: { id: string };
		tenantContext: {
			userId: string;
			type: "organization" | "personal" | "none";
			organizationId: string | null;
		};
		activeOrganizationRole: string | null;
		allowedProjectIds: string[];
	};

	async function loadMiddleware() {
		const mod = await import("../orpc/middleware/require-permission");
		return mod.requireProjectPermission;
	}

	async function invokeMw(mw: unknown, context: MwContext, input: unknown) {
		const next = vi.fn().mockResolvedValue({ output: "ok" });
		await (
			mw as (
				arg: { context: MwContext; next: typeof next },
				input: unknown,
			) => Promise<unknown>
		)({ context, next }, input);
		return { next };
	}

	beforeEach(() => {
		dbMocks.projectFindUnique.mockReset();
		dbMocks.projectMemberFindUnique.mockReset();
		dbMocks.memberFindFirst.mockReset();
	});

	it("an active project VIEWER is denied PUBLISHING_TOPIC_UPDATE (FORBIDDEN)", async () => {
		dbMocks.projectFindUnique.mockResolvedValue({
			id: PROJECT_ID,
			organizationId: ORG_ID,
			userId: OWNER_ID,
		});
		dbMocks.projectMemberFindUnique.mockResolvedValue({
			role: "VIEWER",
			acceptedAt: new Date(),
			expiresAt: null,
		});

		const requireProjectPermission = await loadMiddleware();
		const mw = requireProjectPermission(
			Permissions.PUBLISHING_TOPIC_UPDATE,
		);

		await expect(
			invokeMw(
				mw,
				{
					user: { id: VIEWER_ID },
					tenantContext: {
						userId: VIEWER_ID,
						type: "organization",
						organizationId: ORG_ID,
					},
					activeOrganizationRole: null,
					allowedProjectIds: [],
				},
				{ projectId: PROJECT_ID },
			),
		).rejects.toThrow(/FORBIDDEN|Missing required permission/);
		// Path C (active ProjectMember) is authoritative and short-circuits
		// before the org-role fallback is ever consulted.
		expect(dbMocks.memberFindFirst).not.toHaveBeenCalled();
	});

	it("an active project EDITOR is granted PUBLISHING_TOPIC_UPDATE", async () => {
		dbMocks.projectFindUnique.mockResolvedValue({
			id: PROJECT_ID,
			organizationId: ORG_ID,
			userId: OWNER_ID,
		});
		dbMocks.projectMemberFindUnique.mockResolvedValue({
			role: "EDITOR",
			acceptedAt: new Date(),
			expiresAt: null,
		});

		const requireProjectPermission = await loadMiddleware();
		const mw = requireProjectPermission(
			Permissions.PUBLISHING_TOPIC_UPDATE,
		);

		const { next } = await invokeMw(
			mw,
			{
				user: { id: EDITOR_ID },
				tenantContext: {
					userId: EDITOR_ID,
					type: "organization",
					organizationId: ORG_ID,
				},
				activeOrganizationRole: null,
				allowedProjectIds: [],
			},
			{ projectId: PROJECT_ID },
		);
		expect(next).toHaveBeenCalled();
	});
});

describe("listCycles — the cycle history reader (Fizzy #1850, 1C-4a)", () => {
	const page = (over: Record<string, unknown> = {}) => ({
		input: {
			projectId: "p1",
			organizationId: null,
			limit: 15,
			offset: 0,
			status: "all",
			...over,
		},
		context: ctx,
	});

	// The reach query always resolves to an object — an empty one when no cycle
	// on the page owed anybody a notification, which is the common case. The
	// default belongs here rather than as a `?? {}` inside the procedure: the
	// return type is not nullable, so coalescing there would defend against
	// nothing except this mock.
	beforeEach(() => {
		vi.mocked(countPublishingCycleRecipients).mockResolvedValue({});
	});

	it("is gated on PUBLISHING_TOPIC_READ", () => {
		expect(
			(listPublishingCyclesProcedure as unknown as HandlerBearing)
				.__permission,
		).toBe(Permissions.PUBLISHING_TOPIC_READ);
	});

	it("behaves as if the route does not exist when the feature flag is off", async () => {
		flagMocks.isPublishingSuiteEnabled.mockReturnValue(false);
		await expect(listCyclesHandler(page())).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		// NOT_FOUND alone would also pass if the gate ran AFTER the read. The
		// point of a flag gate is that the data is never touched.
		expect(listPublishingCycles).not.toHaveBeenCalled();
		expect(countPublishingCycles).not.toHaveBeenCalled();
	});

	it("maps the trigger breadcrumb to a label and never returns the user id", async () => {
		vi.mocked(listPublishingCycles).mockResolvedValue([
			{
				id: "c1",
				status: "READY",
				startedAt: new Date("2026-08-01"),
				completedAt: new Date("2026-08-01"),
				triggeredByUserId: "acting-user-77",
				_count: { topics: 3 },
			},
			{
				id: "c2",
				status: "NO_TOPICS",
				startedAt: new Date("2026-07-01"),
				completedAt: new Date("2026-07-01"),
				triggeredByUserId: null,
				_count: { topics: 0 },
			},
		] as never);
		vi.mocked(countPublishingCycles).mockResolvedValue(2);

		const res = await listCyclesHandler(page());

		expect(res.cycles[0].trigger).toBe("manual");
		expect(res.cycles[1].trigger).toBe("scheduled");
		expect(res.cycles[0].topicCount).toBe(3);
		expect(res.total).toBe(2);
		// Structural rather than field-by-field: a later refactor that spreads
		// the row would put the id back, and a per-field assertion would not
		// notice because every field it names would still be correct.
		expect(JSON.stringify(res)).not.toContain("acting-user-77");
	});

	it("passes the notification outcome through to the row", async () => {
		// The row projection is rebuilt field by field on purpose, so a column
		// reaches the client only if someone names it here. The type system
		// catches its removal at the consuming component, but only while a
		// consumer still reads it — this asserts the contract at its source.
		//
		// NO_RECIPIENTS rather than SENT: it is the outcome that motivated the
		// column, and the one a reader most needs, because it is what a refresh
		// looks like when chat was broadcast and nobody was attributed.
		vi.mocked(listPublishingCycles).mockResolvedValue([
			{
				id: "c1",
				status: "READY",
				startedAt: new Date("2026-08-01"),
				completedAt: new Date("2026-08-01"),
				triggeredByUserId: null,
				notificationOutcome: "NO_RECIPIENTS",
				_count: { topics: 2 },
			},
		] as never);
		vi.mocked(countPublishingCycles).mockResolvedValue(1);

		const res = await listCyclesHandler(page());

		expect(res.cycles[0].notificationOutcome).toBe("NO_RECIPIENTS");
	});

	it("merges per-cycle reach onto the right row, and reads an absent entry as zero", async () => {
		// Two rows, counts for only one. The absent entry is the ordinary case,
		// not an error: six of the nine outcomes write no ledger row at all, so
		// a cycle that owed nobody anything simply has nothing to group.
		vi.mocked(listPublishingCycles).mockResolvedValue([
			{
				id: "c1",
				status: "READY",
				startedAt: new Date("2026-08-01"),
				completedAt: new Date("2026-08-01"),
				triggeredByUserId: null,
				notificationOutcome: "SENT",
				_count: { topics: 2 },
			},
			{
				id: "c2",
				status: "NO_TOPICS",
				startedAt: new Date("2026-07-01"),
				completedAt: new Date("2026-07-01"),
				triggeredByUserId: null,
				notificationOutcome: "NOT_APPLICABLE",
				_count: { topics: 0 },
			},
		] as never);
		vi.mocked(countPublishingCycles).mockResolvedValue(2);
		vi.mocked(countPublishingCycleRecipients).mockResolvedValue({
			c1: { owed: 5, delivered: 2 },
		});

		const res = await listCyclesHandler(page());

		// Keyed by cycle id, so a row cannot inherit its neighbour's reach —
		// which an index-based merge would do the moment the two queries
		// disagree about ordering.
		expect(res.cycles[0].notifiedRecipients).toEqual({
			owed: 5,
			delivered: 2,
		});
		expect(res.cycles[1].notifiedRecipients).toEqual({
			owed: 0,
			delivered: 0,
		});
		// Scoped to the project as well as the ids: the reach query must not be
		// answerable for a cycle id the caller was never authorized to read.
		expect(countPublishingCycleRecipients).toHaveBeenCalledWith("p1", [
			"c1",
			"c2",
		]);
	});

	it("reads the page and the count with the SAME status filter", async () => {
		vi.mocked(listPublishingCycles).mockResolvedValue([] as never);
		vi.mocked(countPublishingCycles).mockResolvedValue(0);

		await listCyclesHandler(
			page({ status: "failed", limit: 50, offset: 100 }),
		);

		expect(listPublishingCycles).toHaveBeenCalledWith("p1", {
			limit: 50,
			offset: 100,
			status: "failed",
		});
		// Two different filters would give a total that does not describe the
		// rows, and the pager would then offer pages that hold nothing.
		expect(countPublishingCycles).toHaveBeenCalledWith("p1", "failed");
	});

	it("scopes the read to the project in the input, not the org", async () => {
		vi.mocked(listPublishingCycles).mockResolvedValue([] as never);
		vi.mocked(countPublishingCycles).mockResolvedValue(0);

		// A caller naming an organization they do not belong to changes nothing:
		// the read is keyed on projectId, which requireProjectPermission has
		// already authorized on (projectId, userId).
		await listCyclesHandler(page({ organizationId: "org-not-mine" }));

		expect(listPublishingCycles).toHaveBeenCalledWith(
			"p1",
			expect.objectContaining({ status: "all" }),
		);
	});

	it("reports the delivery count and whether the project targets any channel", async () => {
		vi.mocked(listPublishingCycles).mockResolvedValue([
			{
				id: "c1",
				status: "READY",
				startedAt: new Date("2026-08-01"),
				completedAt: new Date("2026-08-01"),
				triggeredByUserId: null,
				_count: { topics: 3, chatDeliveries: 2 },
			},
		] as never);
		vi.mocked(countPublishingCycles).mockResolvedValue(1);
		vi.mocked(getPublishingSuiteSettings).mockResolvedValue({
			chatChannels: [
				{ platform: "SLACK", teamId: "T1", channelId: "C1" },
			],
		} as never);

		const res = await listCyclesHandler(page());

		expect(res.cycles[0].chatDeliveryCount).toBe(2);
		// The discriminator that separates "the broadcast wrote no rows" from
		// "this project never targeted a channel" — six whole-run gates in the
		// activity write no ledger row at all, so a count of zero alone conflates
		// a refused broadcast with an unconfigured one.
		expect(res.chatChannelsConfigured).toBe(true);
	});

	// BOTH negative shapes, because they come from different places: `[]` is the
	// stored OFF switch, `null` is what `publishingSuiteSettingsDefaults` returns
	// for a project with no settings row at all. Without these, a handler that
	// hardcoded `true` passes the whole block.
	// `"SLACK"` is the case that distinguishes `Array.isArray` from a cast plus
	// `.length`: a STRING has a length, so the cast reads it as five configured
	// channels. `[]` and `null` do not tell the two apart — every other non-array
	// scalar degrades to `undefined > 0` and happens to be safe, which is what
	// makes the cast look correct until it is not. The column is `Json?` with no
	// CHECK.
	it.each([[[]], [null], ["SLACK"], [{}]])(
		"reports no configured channels for %s",
		async (chatChannels) => {
			vi.mocked(listPublishingCycles).mockResolvedValue([] as never);
			vi.mocked(countPublishingCycles).mockResolvedValue(0);
			vi.mocked(getPublishingSuiteSettings).mockResolvedValue({
				chatChannels,
			} as never);

			const res = await listCyclesHandler(page());
			expect(res.chatChannelsConfigured).toBe(false);
		},
	);
});

describe("cycleChatDeliveries — the per-channel ledger reader (Fizzy #1850, 1C-4b)", () => {
	const call = () => ({
		input: { projectId: "p1", organizationId: null, cycleId: "c1" },
		context: ctx,
	});

	it("is gated on PUBLISHING_TOPIC_READ", () => {
		expect(
			(listCycleChatDeliveriesProcedure as unknown as HandlerBearing)
				.__permission,
		).toBe(Permissions.PUBLISHING_TOPIC_READ);
	});

	it("behaves as if the route does not exist when the feature flag is off", async () => {
		flagMocks.isPublishingSuiteEnabled.mockReturnValue(false);
		await expect(chatDeliveriesHandler(call())).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		// NOT_FOUND alone would also pass if the gate ran AFTER the read. The
		// point of a flag gate is that the data is never touched.
		expect(
			listPublishingChatDeliveriesForProjectCycle,
		).not.toHaveBeenCalled();
	});

	it("binds the untrusted cycle id to the project", async () => {
		vi.mocked(
			listPublishingChatDeliveriesForProjectCycle,
		).mockResolvedValue([] as never);
		await chatDeliveriesHandler(call());
		// Argument ORDER matters and is not symmetric: swapped, the reader would
		// look for a cycle whose id is a project id and return nothing, which
		// renders identically to "this refresh reached no channel".
		expect(
			listPublishingChatDeliveriesForProjectCycle,
		).toHaveBeenCalledWith("c1", "p1");
	});

	it("skips the channel-name read entirely when the ledger is empty", async () => {
		vi.mocked(
			listPublishingChatDeliveriesForProjectCycle,
		).mockResolvedValue([] as never);
		const res = await chatDeliveriesHandler(call());
		expect(res).toEqual({ deliveries: [] });
		expect(getLinkedChannelNames).not.toHaveBeenCalled();
	});

	it("never returns the raw provider text", async () => {
		// A NAMED sentinel, and an UNRECOGNISED one on purpose. Without a
		// distinctive value `not.toContain` passes trivially on a null or absent
		// errorMessage while a spread would ship the whole provider body; and an
		// unrecognised string additionally exercises the fail-closed path. The
		// positive assertion below is what makes the negative one mean something.
		vi.mocked(
			listPublishingChatDeliveriesForProjectCycle,
		).mockResolvedValue([
			{
				platform: "TEAMS",
				externalTeamId: "T1",
				channelId: "C1",
				status: "FAILED",
				reason: "POST_FAILED",
				errorMessage:
					'Microsoft Graph API error: 500 - {"tenantId":"LEAK-SENTINEL"}',
			},
		] as never);
		vi.mocked(getLinkedChannelNames).mockResolvedValue(new Map());

		const res = await chatDeliveriesHandler(call());

		expect(JSON.stringify(res)).not.toContain("LEAK-SENTINEL");
		expect(res.deliveries[0].reason).toContain("Check the worker logs");
	});

	// The ONLY test that pins the wiring of `reason` vs `errorMessage` at the
	// call site. Both columns are `String?`, so transposing the two arguments
	// compiles and every other case here still passes — SENT rows have both
	// null, and the FAILED sentinel case degrades to the same generic sentence
	// either way. Swapped, this one collapses both skip classifications into
	// "This channel was skipped for this refresh", which is exactly the
	// information the slice exists to surface.
	it.each([
		["CHANNEL_NOT_LINKED", "no longer linked"],
		["LINKER_NOT_AUTHORIZED", "no longer has access"],
	])("maps the %s skip reason through to the panel", async (reason, copy) => {
		vi.mocked(
			listPublishingChatDeliveriesForProjectCycle,
		).mockResolvedValue([
			{
				platform: "SLACK",
				externalTeamId: "T1",
				channelId: "C1",
				status: "SKIPPED",
				reason,
				errorMessage: "LEAK-SENTINEL",
			},
		] as never);
		vi.mocked(getLinkedChannelNames).mockResolvedValue(new Map());

		const res = await chatDeliveriesHandler(call());

		expect(res.deliveries[0].reason).toContain(copy);
		// The writer never sets errorMessage on a SKIPPED row; reading it would
		// be reading a column with no writer, and echoing it would defeat the
		// fail-closed rule.
		expect(JSON.stringify(res)).not.toContain("LEAK-SENTINEL");
	});

	it("falls back to the raw channel id when a channel was unlinked since", async () => {
		vi.mocked(
			listPublishingChatDeliveriesForProjectCycle,
		).mockResolvedValue([
			{
				platform: "SLACK",
				externalTeamId: "T1",
				channelId: "C1",
				status: "SENT",
				reason: null,
				errorMessage: null,
			},
		] as never);
		vi.mocked(getLinkedChannelNames).mockResolvedValue(new Map());

		const res = await chatDeliveriesHandler(call());
		// The ledger is a historical record: a row disappearing because someone
		// unlinked a channel afterwards would misreport what happened.
		expect(res.deliveries[0].channelName).toBe("C1");
		expect(res.deliveries[0].reason).toBeNull();
	});

	it("resolves a display name through the ledger's full identity", async () => {
		vi.mocked(
			listPublishingChatDeliveriesForProjectCycle,
		).mockResolvedValue([
			{
				platform: "SLACK",
				externalTeamId: "T1",
				channelId: "C1",
				status: "SENT",
				reason: null,
				errorMessage: null,
			},
		] as never);
		vi.mocked(getLinkedChannelNames).mockResolvedValue(
			new Map([["SLACK:T1:C1", "release-notes"]]),
		);

		const res = await chatDeliveriesHandler(call());
		expect(res.deliveries[0].channelName).toBe("release-notes");
		expect(res.deliveries[0].externalTeamId).toBe("T1");
	});
});

describe("setTopicSnooze", () => {
	beforeEach(() => vi.clearAllMocks());

	it("declares the update permission", () => {
		expect(snoozeHandler.__permission).toBe(
			Permissions.PUBLISHING_TOPIC_UPDATE,
		);
	});

	it("is invisible when the feature flag is off", async () => {
		flagMocks.isPublishingSuiteEnabled.mockReturnValueOnce(false);
		await expect(
			snoozeHandler.handler({
				input: { projectId: "p1", topicId: "t1", preset: "ONE_WEEK" },
				context: { user: { id: "u1" } },
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	// NEGATIVE CONTROL (spec 6.3): the wake time must be derived server-side
	// from the preset. Asserting only that `snoozedUntil` is absent is NOT
	// enough — the helper takes an injectable `now`, so a broken procedure
	// could forward a caller timestamp as `now` and still pass that check while
	// accepting an arbitrary wake time. This asserts the WHOLE argument shape:
	// the only keys that may reach the helper are the four below.
	it("forwards only preset and reason — no caller timestamp by any name", async () => {
		(setPublishingTopicSnooze as unknown as Mock).mockResolvedValue({
			topic: { id: "t1" },
		});
		await snoozeHandler.handler({
			input: {
				projectId: "p1",
				topicId: "t1",
				preset: "ONE_WEEK",
				snoozedUntil: "1999-01-01T00:00:00.000Z",
				now: "1999-01-01T00:00:00.000Z",
			},
			context: { user: { id: "u1" } },
		});
		const passed = (setPublishingTopicSnooze as unknown as Mock).mock
			.calls[0][0];
		expect(Object.keys(passed).sort()).toEqual([
			"id",
			"preset",
			"projectId",
			"reason",
		]);
		expect(passed.preset).toBe("ONE_WEEK");
	});

	// The schema boundary, which the raw-handler cases above bypass entirely.
	// A public REST caller reaches the Zod schema, not the handler, so this is
	// where "no custom durations" is actually enforced. Requires the one-line
	// harness change in Step 1b, because the fake chain otherwise discards the
	// schema `.input()` was called with.
	it("rejects a duration the preset enum does not contain", () => {
		const schema = snoozeHandler.__input;
		expect(
			schema.safeParse({
				projectId: "p1",
				topicId: "t1",
				preset: "TWO_DAYS",
			}).success,
		).toBe(false);
		// And accepts the three it does.
		for (const preset of ["ONE_WEEK", "ONE_MONTH", "THREE_MONTHS"]) {
			expect(
				schema.safeParse({ projectId: "p1", topicId: "t1", preset })
					.success,
			).toBe(true);
		}
	});

	it("maps a missing topic to NOT_FOUND", async () => {
		(setPublishingTopicSnooze as unknown as Mock).mockResolvedValue(null);
		await expect(
			snoozeHandler.handler({
				input: { projectId: "p1", topicId: "nope", preset: null },
				context: { user: { id: "u1" } },
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});

describe("setTopicReadState", () => {
	beforeEach(() => vi.clearAllMocks());

	// Marking your own copy read is not editing the topic. Gating it behind
	// edit rights would make the Inbox lie for a read-only member.
	it("declares the READ permission, not update", () => {
		expect(readStateHandler.__permission).toBe(
			Permissions.PUBLISHING_TOPIC_READ,
		);
	});

	it("passes the authenticated user, never a caller-supplied id", async () => {
		(setPublishingTopicReadState as unknown as Mock).mockResolvedValue(
			true,
		);
		await readStateHandler.handler({
			input: {
				projectId: "p1",
				topicId: "t1",
				read: true,
				userId: "impersonated",
			},
			context: { user: { id: "u1" } },
		});
		const passed = (setPublishingTopicReadState as unknown as Mock).mock
			.calls[0][0];
		expect(passed.userId).toBe("u1");
	});

	it("maps a missing topic to NOT_FOUND", async () => {
		(setPublishingTopicReadState as unknown as Mock).mockResolvedValue(
			false,
		);
		await expect(
			readStateHandler.handler({
				input: { projectId: "p1", topicId: "nope", read: true },
				context: { user: { id: "u1" } },
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});
