import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
	projectFindUnique: vi.fn(),
}));

const flagMocks = vi.hoisted(() => ({
	isFeatureEnabled: vi.fn(),
	resolveProjectTenant: vi.fn(),
}));

const { FakeProjectNotFound, FakeTenantMismatch } = vi.hoisted(() => {
	class FakeProjectNotFound extends Error {
		constructor(readonly projectId: string) {
			super(`Project ${projectId} not found`);
			this.name = "PublishingSettingsProjectNotFoundError";
		}
	}
	class FakeTenantMismatch extends Error {
		constructor(readonly projectId: string) {
			super(`organizationId does not match project ${projectId}`);
			this.name = "PublishingSettingsTenantMismatchError";
		}
	}
	return { FakeProjectNotFound, FakeTenantMismatch };
});

vi.mock("@repo/database", () => ({
	db: { project: { findUnique: dbMocks.projectFindUnique } },
	isFeatureEnabled: flagMocks.isFeatureEnabled,
	resolveProjectTenant: flagMocks.resolveProjectTenant,
	getPublishingSuiteSettings: vi.fn(),
	upsertPublishingSuiteSettings: vi.fn(),
	PublishingSettingsProjectNotFoundError: FakeProjectNotFound,
	PublishingSettingsTenantMismatchError: FakeTenantMismatch,
	PUBLISHING_CADENCES: ["MANUAL", "WEEKLY", "BIWEEKLY", "MONTHLY"],
	MIN_PUBLISHING_LOOKBACK_DAYS: 1,
	MAX_PUBLISHING_LOOKBACK_DAYS: 365,
	// Real behaviour, not vi.fn(): update-settings.ts hands this to
	// `.transform()` while BUILDING its schema at module load, so a double
	// returning undefined fails every theme against the piped `.min(1)`.
	// The rule's agreement with the snapshot is pinned in packages/database;
	// here it only has to behave.
	normalizePreferenceLabel: (value: unknown) =>
		typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "",
	// A REAL tuple, not a vi.fn(): update-settings.ts builds
	// `z.enum(PUBLISHING_CHAT_PLATFORMS)` at module load, so a mock function here
	// is a construction-time TypeError rather than a failing assertion. Same
	// reason PUBLISHING_CADENCES and the lookback bounds above are real values.
	PUBLISHING_CHAT_PLATFORMS: ["TEAMS", "SLACK"],
	// Real values for the same module-load reason as the tuple above: the
	// preference schema is built with `z.enum(PUBLISHING_TOPIC_POST_TYPES)` and
	// `.max(MAX_PUBLISHING_PREFERENCE_ITEMS)` when update-settings.ts is
	// imported, so a mock function or an undefined here is a construction-time
	// TypeError, not a failing assertion.
	PUBLISHING_TOPIC_POST_TYPES: [
		"TWEET",
		"BLOG_POST",
		"CASE_STUDY",
		"STAKEHOLDER_EMAIL",
	],
	MAX_PUBLISHING_PREFERENCE_ITEMS: 25,
	MAX_PUBLISHING_PREFERENCE_ITEM_LENGTH: 60,
	MAX_PUBLISHING_STRATEGIC_PRIORITIES_LENGTH: 2000,
	getLinkedTeamsChannels: vi.fn(),
	getLinkedSlackChannels: vi.fn(),
	// Task 6: set-topic-snooze.ts (now sharing this barrel) builds
	// `z.enum(PUBLISHING_SNOOZE_PRESETS)` at MODULE scope — a REAL array,
	// never vi.fn(), for the same construction-time reason as the tuples
	// above. This file never exercises the snooze/read-state handlers.
	setPublishingTopicSnooze: vi.fn(),
	setPublishingTopicReadState: vi.fn(),
	PUBLISHING_SNOOZE_PRESETS: ["ONE_WEEK", "ONE_MONTH", "THREE_MONTHS"],
}));

// `generateNow` (Task 7) now shares this barrel; its helper imports
// `isTemporalAvailable` from `@repo/temporal`. This file never exercises
// that procedure's handler (only permission-gating + wiring for the settings
// procedures below), so replace the whole package rather than chase every
// export its real (huge) module graph transitively touches via @repo/ai /
// @repo/payments.
vi.mock("@repo/temporal", () => ({
	isTemporalAvailable: vi.fn(),
}));

vi.mock("../orpc/procedures", () => {
	const chain: Record<string, unknown> = {};
	for (const m of ["use", "route", "output"]) {
		chain[m] = () => chain;
	}
	// Unlike the other passthrough links, `.input()` records its argument (the
	// REAL `z.object({...})` built in the procedure module) onto the chain, the
	// same way `requireProjectPermission` already records `__permission`. This
	// lets tests assert against the actual schema instead of a hand-rolled copy
	// that would only prove the copy is right.
	chain.input = (schema: unknown) => {
		chain.__inputSchema = schema;
		return chain;
	};
	chain.handler = (fn: unknown) => ({
		handler: fn,
		__permission: chain.__permission,
		__inputSchema: chain.__inputSchema,
	});
	return {
		tenantProtectedProcedure: chain,
		requireProjectPermission: (p: string) => {
			chain.__permission = p;
			return () => chain;
		},
		Permissions: {
			PROJECT_SETTINGS_READ: "project:settings:read",
			PROJECT_SETTINGS_EDIT: "project:settings:edit",
		},
	};
});

import {
	getLinkedSlackChannels,
	getLinkedTeamsChannels,
	getPublishingSuiteSettings,
	PUBLISHING_CADENCES,
	upsertPublishingSuiteSettings,
} from "@repo/database";
import { Permissions } from "@repo/permissions";
import {
	getPublishingSuiteSettingsProcedure,
	updatePublishingSuiteSettingsProcedure,
} from "../modules/projects/procedures/publishing-suite";

type ZodLikeSchema = { safeParse: (value: unknown) => { success: boolean } };
type HandlerBearing = {
	handler: Function;
	__permission: string;
	__inputSchema: ZodLikeSchema;
};
const getHandler = (
	getPublishingSuiteSettingsProcedure as unknown as HandlerBearing
).handler;
const updateHandler = (
	updatePublishingSuiteSettingsProcedure as unknown as HandlerBearing
).handler;
// The REAL `z.object({...})` from update-settings.ts — captured by the
// `.input()` hook in the mocked chain above, not rebuilt here.
const updateInputSchema = (
	updatePublishingSuiteSettingsProcedure as unknown as HandlerBearing
).__inputSchema;

const ctx = {
	user: { id: "u1", name: "U", email: "u@example.com" },
	session: {},
};

beforeEach(() => {
	vi.clearAllMocks();
	flagMocks.isFeatureEnabled.mockResolvedValue(true);
	// ADR-018 ("An organization is the only tenant context"): the default
	// tenant the feature gate resolves is org-scoped, not personal —
	// assertPublishingSuiteFeatureEnabled now refuses a project with no
	// organization outright. A null default here would fail every test below
	// at the gate before it reached what it actually means to exercise. The
	// dedicated personal-context tests override this explicitly (see
	// "getSettings" below).
	flagMocks.resolveProjectTenant.mockResolvedValue({
		organizationId: "org1",
		userId: null,
	});
	dbMocks.projectFindUnique.mockResolvedValue({
		id: "p1",
		organizationId: null,
	});
});

describe("permission declarations", () => {
	it("getSettings is gated on PROJECT_SETTINGS_READ", () => {
		expect(
			(getPublishingSuiteSettingsProcedure as unknown as HandlerBearing)
				.__permission,
		).toBe(Permissions.PROJECT_SETTINGS_READ);
	});

	it("updateSettings is gated on PROJECT_SETTINGS_EDIT", () => {
		expect(
			(
				updatePublishingSuiteSettingsProcedure as unknown as HandlerBearing
			).__permission,
		).toBe(Permissions.PROJECT_SETTINGS_EDIT);
	});
});

describe("getSettings", () => {
	it("returns the helper's settings for a reachable project", async () => {
		vi.mocked(getPublishingSuiteSettings).mockResolvedValue({
			id: null,
			projectId: "p1",
			cadence: "WEEKLY",
			lookbackDays: null,
			notificationsEnabled: true,
			createdAt: null,
			updatedAt: null,
		} as never);

		const res = await getHandler({
			input: { projectId: "p1", organizationId: null },
			context: ctx,
		});

		expect(res).toEqual({
			settings: expect.objectContaining({ cadence: "WEEKLY" }),
		});
	});

	it("is NOT_FOUND when the project is unreachable in this tenant", async () => {
		dbMocks.projectFindUnique.mockResolvedValue(null);
		await expect(
			getHandler({
				input: { projectId: "p1", organizationId: null },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(getPublishingSuiteSettings).not.toHaveBeenCalled();
	});

	// Security ratchet contract (input-org-unverified-ratchet.test.ts): the
	// project lookup must key SOLELY on the project id — the organization is
	// derived from the loaded record, never used to scope the read. See
	// get-settings.ts for the full rationale.
	it("looks up the project by id only — never scoped by a caller-supplied organizationId or userId", async () => {
		// The project genuinely belongs to org-1 (matching the input) so the
		// call succeeds — this test is about the shape of the `findUnique` call,
		// not the guard, which has its own tests below.
		dbMocks.projectFindUnique.mockResolvedValue({
			id: "p1",
			organizationId: "org-1",
		});
		vi.mocked(getPublishingSuiteSettings).mockResolvedValue({
			id: null,
			projectId: "p1",
			cadence: "WEEKLY",
			lookbackDays: null,
			notificationsEnabled: true,
			createdAt: null,
			updatedAt: null,
		} as never);

		await getHandler({
			input: { projectId: "p1", organizationId: "org-1" },
			context: ctx,
		});

		expect(dbMocks.projectFindUnique).toHaveBeenCalledTimes(1);
		const { where, select } = dbMocks.projectFindUnique.mock
			.calls[0][0] as {
			where: Record<string, unknown>;
			select: Record<string, unknown>;
		};
		// The whole point of the ratchet: no organizationId/userId clause taken
		// from caller input widens or narrows this lookup.
		expect(where).toEqual({ id: "p1" });
		expect(select.organizationId).toBe(true);
	});

	it("a non-null organizationId that does not match the project's own organizationId is rejected as BAD_REQUEST", async () => {
		dbMocks.projectFindUnique.mockResolvedValue({
			id: "p1",
			organizationId: "org-1",
		});

		await expect(
			getHandler({
				input: { projectId: "p1", organizationId: "org-wrong" },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(getPublishingSuiteSettings).not.toHaveBeenCalled();
	});

	// ADR-018 ("An organization is the only tenant context") inverts this: a
	// truly personal-context project (no organization at all) is now refused
	// by the feature gate BEFORE this procedure's own org-guard is ever
	// reached — it is not merely tolerated as a guest-with-no-active-org edge
	// case any more. This replaces the old pin ("...the guest case must not
	// regress"), which asserted the opposite.
	it("is NOT_FOUND for a truly personal-context project — refused by the gate, per ADR-018", async () => {
		flagMocks.resolveProjectTenant.mockResolvedValue({
			organizationId: null,
			userId: "u1",
		});
		dbMocks.projectFindUnique.mockResolvedValue({
			id: "p1",
			organizationId: null,
		});

		await expect(
			getHandler({
				input: { projectId: "p1", organizationId: null },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(getPublishingSuiteSettings).not.toHaveBeenCalled();
	});

	it("null organizationId also succeeds for an organization-context project — a guest reading an org project must not regress", async () => {
		dbMocks.projectFindUnique.mockResolvedValue({
			id: "p1",
			organizationId: "org-1",
		});
		vi.mocked(getPublishingSuiteSettings).mockResolvedValue({
			id: null,
			projectId: "p1",
			cadence: "WEEKLY",
			lookbackDays: null,
			notificationsEnabled: true,
			createdAt: null,
			updatedAt: null,
		} as never);

		await expect(
			getHandler({
				input: { projectId: "p1", organizationId: null },
				context: ctx,
			}),
		).resolves.toEqual({
			settings: expect.objectContaining({ cadence: "WEEKLY" }),
		});
	});

	it("organization context: returns settings when the caller's organizationId matches the project's own organizationId", async () => {
		dbMocks.projectFindUnique.mockResolvedValue({
			id: "p1",
			organizationId: "org-1",
		});
		vi.mocked(getPublishingSuiteSettings).mockResolvedValue({
			id: null,
			projectId: "p1",
			cadence: "WEEKLY",
			lookbackDays: null,
			notificationsEnabled: true,
			createdAt: null,
			updatedAt: null,
		} as never);

		await expect(
			getHandler({
				input: { projectId: "p1", organizationId: "org-1" },
				context: ctx,
			}),
		).resolves.toEqual({
			settings: expect.objectContaining({ cadence: "WEEKLY" }),
		});
	});
});

describe("updateSettings", () => {
	it("forwards the client org as a guard and the actor as createdByUserId", async () => {
		vi.mocked(upsertPublishingSuiteSettings).mockResolvedValue({
			cadence: "MONTHLY",
		} as never);

		await updateHandler({
			input: {
				projectId: "p1",
				organizationId: "org-1",
				cadence: "MONTHLY",
			},
			context: ctx,
		});

		expect(upsertPublishingSuiteSettings).toHaveBeenCalledWith({
			projectId: "p1",
			clientOrganizationId: "org-1",
			createdByUserId: "u1",
			cadence: "MONTHLY",
			lookbackDays: undefined,
			notificationsEnabled: undefined,
			chatChannels: undefined,
		});
	});

	it("drops a submitted channel that is no longer linked to the project", async () => {
		// The client's list can be stale — a channel unlinked after the form
		// loaded. Dropping it is deliberate, and so is dropping it SILENTLY rather
		// than rejecting: the user's actual edit (whatever else they changed) must
		// still save, and the removed channel is already gone from the list they
		// are looking at once the query invalidates.
		vi.mocked(upsertPublishingSuiteSettings).mockResolvedValue({} as never);
		vi.mocked(getLinkedTeamsChannels).mockResolvedValue([] as never);
		vi.mocked(getLinkedSlackChannels).mockResolvedValue([
			{ slackTeamId: "T-example", channelId: "C-live" },
		] as never);

		await updateHandler({
			input: {
				projectId: "p1",
				organizationId: null,
				chatChannels: [
					{
						platform: "SLACK",
						teamId: "T-example",
						channelId: "C-live",
					},
					{
						platform: "SLACK",
						teamId: "T-example",
						channelId: "C-gone",
					},
				],
			},
			context: ctx,
		});

		expect(upsertPublishingSuiteSettings).toHaveBeenCalledWith(
			expect.objectContaining({
				chatChannels: [
					{
						platform: "SLACK",
						teamId: "T-example",
						channelId: "C-live",
					},
				],
			}),
		);
	});

	it("passes an empty selection through untouched, so chat can be turned off", async () => {
		// The live-set filter must not run on an empty list and must not turn it
		// into `undefined` — that would make "turn chat off" indistinguishable from
		// "leave the selection alone", and the off switch would silently stop
		// working. The un-called readers are asserted too: guarding on presence
		// rather than length would still produce `[]` here while spending two
		// reads to do it, so only this second assertion tells the two apart.
		vi.mocked(upsertPublishingSuiteSettings).mockResolvedValue({} as never);

		await updateHandler({
			input: { projectId: "p1", organizationId: null, chatChannels: [] },
			context: ctx,
		});

		expect(upsertPublishingSuiteSettings).toHaveBeenCalledWith(
			expect.objectContaining({ chatChannels: [] }),
		);
		expect(getLinkedSlackChannels).not.toHaveBeenCalled();
		expect(getLinkedTeamsChannels).not.toHaveBeenCalled();
	});

	it("maps a tenant mismatch to BAD_REQUEST", async () => {
		vi.mocked(upsertPublishingSuiteSettings).mockRejectedValue(
			new FakeTenantMismatch("p1"),
		);
		await expect(
			updateHandler({
				input: {
					projectId: "p1",
					organizationId: "wrong",
					cadence: "WEEKLY",
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("maps a missing project to NOT_FOUND", async () => {
		vi.mocked(upsertPublishingSuiteSettings).mockRejectedValue(
			new FakeProjectNotFound("p1"),
		);
		await expect(
			updateHandler({
				input: {
					projectId: "p1",
					organizationId: null,
					cadence: "WEEKLY",
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});

describe("updateSettings input schema (the real z.object from update-settings.ts)", () => {
	// `cadence` is plain TEXT with no database CHECK, and the cadence-to-interval
	// lookup falls through to WEEKLY on an unrecognised value — this schema is
	// the only runtime validation for it anywhere in the system. Same story for
	// `lookbackDays`: unconstrained in the database despite the documented
	// 1..365 range. These cases run the schema for real via `.safeParse`,
	// captured off the chain's `.input()` call rather than rebuilt here.
	const baseInput = { projectId: "p1", organizationId: null };

	it("rejects an unrecognised cadence", () => {
		expect(
			updateInputSchema.safeParse({ ...baseInput, cadence: "BOGUS" })
				.success,
		).toBe(false);
	});

	it("rejects a lowercase cadence — the realistic typo that would silently behave as WEEKLY forever rather than erroring", () => {
		expect(
			updateInputSchema.safeParse({ ...baseInput, cadence: "weekly" })
				.success,
		).toBe(false);
	});

	it("rejects lookbackDays: 0 (just below the minimum)", () => {
		expect(
			updateInputSchema.safeParse({ ...baseInput, lookbackDays: 0 })
				.success,
		).toBe(false);
	});

	it("rejects lookbackDays: 366 (just above the maximum)", () => {
		expect(
			updateInputSchema.safeParse({ ...baseInput, lookbackDays: 366 })
				.success,
		).toBe(false);
	});

	it("rejects a non-integer lookbackDays", () => {
		expect(
			updateInputSchema.safeParse({ ...baseInput, lookbackDays: 7.5 })
				.success,
		).toBe(false);
	});

	it.each(PUBLISHING_CADENCES)("accepts cadence %s", (cadence) => {
		expect(
			updateInputSchema.safeParse({ ...baseInput, cadence }).success,
		).toBe(true);
	});

	it("accepts lookbackDays: null (clears the override back to the engine default)", () => {
		expect(
			updateInputSchema.safeParse({ ...baseInput, lookbackDays: null })
				.success,
		).toBe(true);
	});

	it("accepts a well-formed chat target list AND carries it through", () => {
		// ASSERTED ON THE PARSED DATA, not on `.success`. An unknown key is
		// stripped by zod rather than rejected, so a success-only assertion here
		// is true before the field exists at all — it was, when this case was
		// first written, and it passed against a schema that had never heard of
		// chatChannels.
		const parsed = updateInputSchema.safeParse({
			...baseInput,
			chatChannels: [
				{
					platform: "SLACK",
					teamId: "T-example",
					channelId: "C-example",
				},
			],
		}) as {
			success: boolean;
			data?: { chatChannels?: unknown };
		};
		expect(parsed.success).toBe(true);
		expect(parsed.data?.chatChannels).toEqual([
			{ platform: "SLACK", teamId: "T-example", channelId: "C-example" },
		]);
	});

	it("rejects a chat target list longer than the cap", () => {
		// The cap is a wire bound, not a product limit: an uncapped array is an
		// unbounded JSON payload persisted on a settings row and later walked one
		// provider call at a time.
		expect(
			updateInputSchema.safeParse({
				...baseInput,
				chatChannels: Array.from({ length: 51 }, (_, i) => ({
					platform: "SLACK",
					teamId: "T-example",
					channelId: `C-example-${i}`,
				})),
			}).success,
		).toBe(false);
	});

	it("rejects a chat target on a platform the delivery path has no branch for", () => {
		expect(
			updateInputSchema.safeParse({
				...baseInput,
				chatChannels: [
					{
						platform: "DISCORD",
						teamId: "T-example",
						channelId: "C-example",
					},
				],
			}).success,
		).toBe(false);
	});

	it("accepts the lookbackDays boundaries 1 and 365", () => {
		expect(
			updateInputSchema.safeParse({ ...baseInput, lookbackDays: 1 })
				.success,
		).toBe(true);
		expect(
			updateInputSchema.safeParse({ ...baseInput, lookbackDays: 365 })
				.success,
		).toBe(true);
	});

	it("accepts an input omitting every optional field", () => {
		expect(updateInputSchema.safeParse(baseInput).success).toBe(true);
	});
});

describe("feature flag gating — flag OFF is NOT_FOUND", () => {
	beforeEach(() => {
		flagMocks.isFeatureEnabled.mockResolvedValue(false);
	});

	it("getSettings", async () => {
		await expect(
			getHandler({
				input: { projectId: "p1", organizationId: null },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(getPublishingSuiteSettings).not.toHaveBeenCalled();
	});

	it("updateSettings", async () => {
		await expect(
			updateHandler({
				input: {
					projectId: "p1",
					organizationId: null,
					cadence: "WEEKLY",
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(upsertPublishingSuiteSettings).not.toHaveBeenCalled();
	});
});

/**
 * 1C-1b part 2 (§7.1(a), FR8–FR10): the advisory recommendation preferences at
 * the WIRE boundary.
 *
 * Two properties, and the second is the one a schema gets wrong by default.
 *
 * The bounds are straightforward. The three-state contract is not: `undefined`
 * (leave the stored value alone), `[]` / `null` (clear it) and a value
 * (replace it) must all survive the boundary as themselves. A schema that
 * folds any pair of them together turns "clear my themes" into "change
 * nothing", silently, with a green suite.
 */
const prefsBase = { projectId: "p1", organizationId: null };

describe("recommendation preferences — bounds", () => {
	const list = (n: number, item = "theme") =>
		Array.from({ length: n }, () => item);

	it("accepts a themes list at the cap and rejects one past it", () => {
		expect(
			updateInputSchema.safeParse({
				...prefsBase,
				preferredThemes: list(25),
			}).success,
		).toBe(true);
		expect(
			updateInputSchema.safeParse({
				...prefsBase,
				preferredThemes: list(26),
			}).success,
		).toBe(false);
	});

	it("bounds an individual theme, not just the list", () => {
		// One very long theme bloats a prompt as effectively as a hundred short
		// ones, and only the per-item cap notices it.
		expect(
			updateInputSchema.safeParse({
				...prefsBase,
				preferredThemes: ["a".repeat(60)],
			}).success,
		).toBe(true);
		expect(
			updateInputSchema.safeParse({
				...prefsBase,
				preferredThemes: ["a".repeat(61)],
			}).success,
		).toBe(false);
	});

	it("rejects a blank theme", () => {
		// A blank would be dropped by the snapshot normalizer anyway, so accepting
		// it here means the stored row and the hashed snapshot disagree about what
		// the project configured.
		expect(
			updateInputSchema.safeParse({ ...prefsBase, preferredThemes: [""] })
				.success,
		).toBe(false);
	});

	it("rejects a WHITESPACE-ONLY theme, and trims the ones it keeps", () => {
		// The gap `.min(1)` alone left. "" was already rejected; "   " was not, and
		// it is the shape that does damage: the row stores a theme, the snapshot
		// normalizer drops it, and the settings then claim a preference the prompt
		// and the hash have never heard of. Reachable by any caller that is not
		// this repo's own form, which trims before it sends.
		//
		// Named rather than escaped: in a test about whitespace, a two-character
		// escape is the thing a reader skims straight past.
		const TAB = String.fromCharCode(9);
		const NEWLINE = String.fromCharCode(10);
		for (const blank of ["   ", TAB, NEWLINE + "  "]) {
			expect(
				updateInputSchema.safeParse({
					...prefsBase,
					preferredThemes: [blank],
				}).success,
			).toBe(false);
		}
		// And a surviving item arrives canonical rather than as typed, so the
		// stored row cannot differ from the snapshot by padding alone.
		expect(
			updateInputSchema.safeParse({
				...prefsBase,
				preferredThemes: ["  developer experience  "],
			}).data?.preferredThemes,
		).toEqual(["developer experience"]);
	});

	it("collapses inner whitespace and line breaks in a theme, then bounds what survives", () => {
		// Raised in adversarial review. Trimming alone still accepted
		// "Developer   Experience" and an item carrying a line break, while
		// buildPublishingPreferencesSnapshot collapses every whitespace run — so
		// the row an admin read back differed from the text the prompt was built
		// from, and a newline inside a theme would have been rendered into the
		// middle of the clause's bulleted list.
		//
		// This case asserts the OBSERVABLE result only. The stronger claim — that
		// the boundary and the snapshot share ONE rule rather than two that agree
		// today — cannot honestly be made here: this suite replaces `@repo/database`
		// wholesale, so any comparison against the snapshot would compare the test
		// double with itself. It is pinned against the real modules in
		// packages/database/__tests__/publishing-preferences.test.ts instead.
		const NEWLINE = String.fromCharCode(10);
		const parsed = updateInputSchema.safeParse({
			...prefsBase,
			preferredThemes: [
				"Developer   Experience",
				"Release" + NEWLINE + "Engineering",
			],
		});

		expect(parsed.success).toBe(true);
		expect(parsed.data?.preferredThemes).toEqual([
			"Developer Experience",
			"Release Engineering",
		]);
	});

	it("bounds the theme AFTER normalizing, so the cap counts what reaches the model", () => {
		// Order matters and is easy to get backwards. A value that is over the cap
		// only because of a whitespace run is under it once collapsed, and the
		// model never sees the run — so bounding first would reject a theme that
		// is, as far as the prompt is concerned, perfectly legal.
		const long = "x".repeat(40) + "     " + "y".repeat(19); // 64 raw, 60 collapsed
		const parsed = updateInputSchema.safeParse({
			...prefsBase,
			preferredThemes: [long],
		});

		expect(parsed.success).toBe(true);
		expect(parsed.data?.preferredThemes?.[0]).toHaveLength(60);
	});

	it("folds a blank strategicPriorities into the null clear, not a fourth spelling", () => {
		// "" and "   " plainly mean CLEAR. Stored verbatim they leave the row
		// holding a value the snapshot reads as null — the same stored-vs-canonical
		// split as the whitespace theme, on the free-text field. Rejecting was the
		// alternative and is worse: a 400 for an input whose intent is unambiguous.
		const TAB = String.fromCharCode(9);
		const NEWLINE = String.fromCharCode(10);
		for (const blank of ["", "   ", NEWLINE + TAB + " "]) {
			const parsed = updateInputSchema.safeParse({
				...prefsBase,
				strategicPriorities: blank,
			});
			expect(parsed.success).toBe(true);
			expect(parsed.data?.strategicPriorities).toBeNull();
		}
		// A real value loses its ends and nothing else — line structure is part of
		// the instruction downstream, so the interior is never reflowed.
		expect(
			updateInputSchema.safeParse({
				...prefsBase,
				strategicPriorities:
					"  ship weekly" + NEWLINE + "then measure  ",
			}).data?.strategicPriorities,
		).toBe("ship weekly" + NEWLINE + "then measure");
	});

	it("leaves strategicPriorities ABSENT when omitted, transform notwithstanding", () => {
		// The precondition that transform could silently break. It runs on an
		// `.optional()` field; if parsing ADDED the key, the storage layer's
		// `!== undefined` guard would start seeing it on every call and "omitted
		// leaves the stored value alone" would quietly become "omitted clears it".
		// Nothing else in this suite would notice.
		const parsed = updateInputSchema.safeParse(prefsBase);
		expect(parsed.success).toBe(true);
		expect("strategicPriorities" in (parsed.data ?? {})).toBe(false);
	});

	it("bounds strategicPriorities", () => {
		expect(
			updateInputSchema.safeParse({
				...prefsBase,
				strategicPriorities: "x".repeat(2000),
			}).success,
		).toBe(true);
		expect(
			updateInputSchema.safeParse({
				...prefsBase,
				strategicPriorities: "x".repeat(2001),
			}).success,
		).toBe(false);
	});

	it("accepts the three CLEAR spellings at the schema, not just at the handler", () => {
		// The handler tests below drive `updateHandler` directly, which bypasses
		// this schema entirely — the mocked oRPC chain records `.input()` without
		// ever validating. So dropping `.nullable()` from strategicPriorities used
		// to redden NOTHING: the clear path was covered at the handler and
		// unguarded at the wire. This case is the missing half.
		expect(
			updateInputSchema.safeParse({ ...prefsBase, preferredThemes: [] })
				.success,
		).toBe(true);
		expect(
			updateInputSchema.safeParse({
				...prefsBase,
				preferredPostTypes: [],
			}).success,
		).toBe(true);
		expect(
			updateInputSchema.safeParse({
				...prefsBase,
				strategicPriorities: null,
			}).success,
		).toBe(true);
	});

	it("accepts every post type in the enum and nothing outside it", () => {
		expect(
			updateInputSchema.safeParse({
				...prefsBase,
				preferredPostTypes: [
					"TWEET",
					"BLOG_POST",
					"CASE_STUDY",
					"STAKEHOLDER_EMAIL",
				],
			}).success,
		).toBe(true);
		// The plausible-but-absent value, and the human LABEL — the two ways a
		// caller arrives at something the generator can never emit.
		expect(
			updateInputSchema.safeParse({
				...prefsBase,
				preferredPostTypes: ["NEWSLETTER"],
			}).success,
		).toBe(false);
		expect(
			updateInputSchema.safeParse({
				...prefsBase,
				preferredPostTypes: ["Blog Post"],
			}).success,
		).toBe(false);
	});
});

describe("recommendation preferences — the three states survive the boundary", () => {
	beforeEach(() => {
		dbMocks.projectFindUnique.mockResolvedValue({
			id: "p1",
			organizationId: null,
		});
		// Re-arm the helper explicitly. `vi.clearAllMocks()` in the file-level
		// beforeEach resets call records but NOT implementations, so the
		// `mockRejectedValue(new FakeProjectNotFound(...))` installed by the
		// NOT_FOUND case earlier in this file leaks into every test that runs
		// after it — which is every test appended below it.
		vi.mocked(upsertPublishingSuiteSettings).mockResolvedValue({} as never);
	});

	it("passes an empty list through as [], not as undefined", async () => {
		await updateHandler({
			input: { ...prefsBase, preferredThemes: [] },
			context: ctx,
		});

		expect(upsertPublishingSuiteSettings).toHaveBeenCalledWith(
			expect.objectContaining({ preferredThemes: [] }),
		);
	});

	it("leaves all three undefined when the caller omits them", async () => {
		// A save from a form that only edits cadence must not reach the helper
		// carrying `[]` for fields it never showed — that would clear them.
		await updateHandler({
			input: { ...prefsBase, cadence: "WEEKLY" },
			context: ctx,
		});

		const arg = vi.mocked(upsertPublishingSuiteSettings).mock.calls[0]?.[0];
		expect(arg?.preferredThemes).toBeUndefined();
		expect(arg?.preferredPostTypes).toBeUndefined();
		expect(arg?.strategicPriorities).toBeUndefined();
	});

	it("passes strategicPriorities: null through as null", async () => {
		await updateHandler({
			input: { ...prefsBase, strategicPriorities: null },
			context: ctx,
		});

		expect(upsertPublishingSuiteSettings).toHaveBeenCalledWith(
			expect.objectContaining({ strategicPriorities: null }),
		);
	});
});
