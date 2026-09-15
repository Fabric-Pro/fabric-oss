/**
 * Customer outcomes by token (plan Slice 8) — the DTO is an allowlist.
 *
 * Run with: pnpm --filter @repo/api test modules/outcomes/__tests__/get-by-token.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	handler: null as null | ((...args: unknown[]) => unknown),
	db: {
		project: { findFirst: vi.fn(), findUnique: vi.fn() },
		featureVersion: { findMany: vi.fn() },
		userStory: { findMany: vi.fn() },
		codingRun: { findMany: vi.fn() },
		projectSuccessMetric: { findMany: vi.fn() },
		agentWorkspaceFile: { findMany: vi.fn() },
	},
}));

vi.mock("@repo/database", () => ({ db: mocks.db }));
vi.mock("@repo/utils", () => ({ getBaseUrl: () => "https://app.test" }));
vi.mock("../../../orpc/procedures", () => {
	const chainable: any = {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			mocks.handler = fn;
			return { _handler: fn };
		},
	};
	return {
		rateLimitedPublicProcedure: chainable,
		publicProcedure: chainable,
	};
});

import "../procedures/get-by-token";
import {
	buildCustomerOutcomes,
	CUSTOMER_OUTCOMES_DTO_KEYS,
} from "../lib/customer-outcomes";

const TOKEN = "Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6";
const SECRET_STORY_ID = "cstory_secret_id_123";
// A private (non-project) frame id that must never appear in the public DTO.
const PRIVATE_FRAME_ID = "frame_private_not_for_customers";
const PUBLIC_FRAME_ID = "cframe_public_789";
const SECRET_DESCRIPTION = "As a user I want a very private description";
const SECRET_EMAIL = "owner@example.com";

function seedProject() {
	mocks.db.project.findFirst.mockResolvedValue({ id: "proj-1" });
	mocks.db.project.findUnique.mockResolvedValue({
		id: "proj-1",
		name: "Acme Portal",
		visionPurpose: "Help SMBs get paid faster",
		visionCoreActions: ["send invoice", "collect payment"],
		visionCycle: "weekly",
		// Fields a careless select could leak — never in the DTO.
		userId: "user-owner",
		description: SECRET_DESCRIPTION,
	});
	mocks.db.featureVersion.findMany.mockResolvedValue([
		{
			createdAt: new Date("2026-09-02T00:00:00Z"),
			changeDescription: "Spike findings applied (run crun_1)",
			story: {
				id: SECRET_STORY_ID,
				identifier: "F-7",
				title: "Instant payouts",
				description: SECRET_DESCRIPTION,
			},
		},
		{
			createdAt: new Date("2026-09-01T00:00:00Z"),
			changeDescription: "Routine edit",
			story: {
				id: SECRET_STORY_ID,
				identifier: "F-7",
				title: "Instant payouts",
			},
		},
	]);
	mocks.db.userStory.findMany.mockResolvedValue([
		{
			identifier: "F-9",
			title: "Reminders",
			deliveryTrack: "SPIKE",
			trackUpdatedAt: new Date("2026-09-03T00:00:00Z"),
		},
	]);
	mocks.db.codingRun.findMany
		// spike runs
		.mockResolvedValueOnce([
			{
				demoFrameId: PUBLIC_FRAME_ID,
				story: { identifier: "F-7", title: "Instant payouts" },
			},
			{
				demoFrameId: PRIVATE_FRAME_ID,
				story: { identifier: "F-9", title: "Reminders" },
			},
		])
		// merged runs
		.mockResolvedValueOnce([
			{
				mergedAt: new Date("2026-09-05T00:00:00Z"),
				pullRequestUrl: "https://github.com/acme/portal/pull/12",
				story: { identifier: "F-7", title: "Instant payouts" },
			},
		]);
	mocks.db.agentWorkspaceFile.findMany.mockResolvedValue([
		{ id: PUBLIC_FRAME_ID, isPublic: true, shareToken: "pub-token" },
		{
			id: PRIVATE_FRAME_ID,
			isPublic: false,
			shareToken: "leaked-if-shown",
		},
	]);
	mocks.db.projectSuccessMetric.findMany.mockResolvedValue([
		{
			name: "Activation rate",
			direction: "UP",
			target: 50,
			lastValue: 41,
			previousValue: 38,
			lastObservedAt: new Date("2026-09-01T00:00:00Z"),
			// Would be a leak:
			webhookSecretHash: "hash-must-not-appear",
			userId: "user-owner",
		},
	]);
}

beforeEach(() => {
	for (const model of Object.values(mocks.db)) {
		for (const fn of Object.values(model)) {
			(fn as ReturnType<typeof vi.fn>).mockReset();
		}
	}
});

describe("outcomes.getByToken", () => {
	it("throws NOT_FOUND for an unknown or revoked token", async () => {
		mocks.db.project.findFirst.mockResolvedValue(null);
		await expect(
			mocks.handler?.({ input: { token: TOKEN }, context: {} }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.db.project.findFirst).toHaveBeenCalledWith({
			where: { outcomesShareToken: TOKEN },
			select: { id: true },
		});
	});

	it("throws NOT_FOUND for a malformed token without touching the database", async () => {
		await expect(
			mocks.handler?.({ input: { token: "short" }, context: {} }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.db.project.findFirst).not.toHaveBeenCalled();
	});

	it("returns only the allowlisted keys and no ids, descriptions or e-mails", async () => {
		seedProject();
		const dto = (await mocks.handler?.({
			input: { token: TOKEN },
			context: {},
		})) as Record<string, unknown>;

		expect(Object.keys(dto).sort()).toEqual(
			[...CUSTOMER_OUTCOMES_DTO_KEYS].sort(),
		);
		const decisions = dto.decisions as Record<string, unknown>[];
		const demos = dto.demos as Record<string, unknown>[];
		const shipped = dto.shipped as Record<string, unknown>[];
		const metrics = dto.metrics as Record<string, unknown>[];
		for (const d of decisions) {
			expect(Object.keys(d).sort()).toEqual(
				[
					"decidedAt",
					"storyIdentifier",
					"storyTitle",
					"summary",
				].sort(),
			);
		}
		for (const d of demos) {
			expect(
				Object.keys(d).every((k) =>
					["storyIdentifier", "title", "frameShareUrl"].includes(k),
				),
			).toBe(true);
		}
		for (const s of shipped) {
			expect(Object.keys(s).sort()).toEqual(
				[
					"mergedAt",
					"pullRequestUrl",
					"storyIdentifier",
					"storyTitle",
				].sort(),
			);
		}
		for (const m of metrics) {
			expect(Object.keys(m).sort()).toEqual(
				[
					"direction",
					"lastObservedAt",
					"lastValue",
					"name",
					"previousValue",
					"target",
				].sort(),
			);
		}

		const serialized = JSON.stringify(dto);
		expect(serialized).not.toContain(SECRET_STORY_ID);
		expect(serialized).not.toContain(PRIVATE_FRAME_ID);
		expect(serialized).not.toContain(PUBLIC_FRAME_ID);
		expect(serialized).not.toContain(SECRET_DESCRIPTION);
		expect(serialized).not.toContain(SECRET_EMAIL);
		expect(serialized).not.toContain("user-owner");
		expect(serialized).not.toContain("hash-must-not-appear");
		expect(serialized).not.toContain("crun_1");
	});

	it("keeps only decision-worthy versions plus human track changes, newest first", async () => {
		seedProject();
		const dto = (await mocks.handler?.({
			input: { token: TOKEN },
			context: {},
		})) as { decisions: { summary: string; storyIdentifier: string }[] };
		expect(dto.decisions.map((d) => d.summary)).toEqual([
			"Delivery track set to Spike",
			"Spike findings applied",
		]);
		expect(dto.decisions.some((d) => d.summary === "Routine edit")).toBe(
			false,
		);
	});

	it("links a demo only when its frame is public; private frames yield no URL", async () => {
		seedProject();
		const dto = (await mocks.handler?.({
			input: { token: TOKEN },
			context: {},
		})) as { demos: { storyIdentifier: string; frameShareUrl?: string }[] };
		expect(dto.demos).toEqual([
			{
				storyIdentifier: "F-7",
				title: "Instant payouts",
				frameShareUrl: "https://app.test/share/frame/pub-token",
			},
			{ storyIdentifier: "F-9", title: "Reminders" },
		]);
		expect(JSON.stringify(dto)).not.toContain("leaked-if-shown");
	});

	it("lists shipped work from CodingRun.mergedAt", async () => {
		seedProject();
		const dto = (await mocks.handler?.({
			input: { token: TOKEN },
			context: {},
		})) as { shipped: unknown[] };
		expect(dto.shipped).toEqual([
			{
				storyIdentifier: "F-7",
				storyTitle: "Instant payouts",
				mergedAt: new Date("2026-09-05T00:00:00Z"),
				pullRequestUrl: "https://github.com/acme/portal/pull/12",
			},
		]);
	});

	it("buildCustomerOutcomes returns null for a missing project", async () => {
		mocks.db.project.findUnique.mockResolvedValue(null);
		expect(await buildCustomerOutcomes("nope")).toBeNull();
	});
});
