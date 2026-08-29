/**
 * Focused zod-schema tests for the newsletter settings-update input (AC-6):
 * `detailLevel` must never reject an invalid value — omitted leaves it
 * unchanged, a valid tier passes through, and an invalid tier COERCES to
 * STANDARD via `.catch()` (never a validation error). `@repo/database` and
 * the orpc procedure chain are mocked so the module can be imported without a
 * real DB/Prisma client — mirrors the harness in `newsletter.test.ts`.
 *
 * Run with: pnpm --filter @repo/api test settings-update
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	db: { project: { findUnique: vi.fn() }, $transaction: vi.fn() },
	getNewsletterSettings: vi.fn(),
	upsertNewsletterSettings: vi.fn(),
	enrollProjectMembersAsSubscribers: vi.fn(),
	setPublicWidgetState: vi.fn(),
	recordAuditTx: vi.fn(),
	getLinkedTeamsChannels: vi.fn(),
	getLinkedSlackChannels: vi.fn(),
	NEWSLETTER_DETAIL_LEVELS: ["BRIEF", "STANDARD", "DETAILED"],
	DEFAULT_NEWSLETTER_DETAIL_LEVEL: "STANDARD",
	NEWSLETTER_DELIVERY_DESTINATIONS: ["EMAIL", "CHAT", "BOTH"],
	DEFAULT_NEWSLETTER_DELIVERY_DESTINATION: "EMAIL",
	NEWSLETTER_CHAT_PLATFORMS: ["TEAMS", "SLACK"],
}));

vi.mock("../../../../orpc/procedures", () => {
	// biome-ignore lint/suspicious/noExplicitAny: minimal chainable test double
	const chainable: any = {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => ({ _handler: fn }),
	};
	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: () => (c: unknown) => c,
		resolveOrganizationId: vi.fn(
			(organizationId: string | null) => organizationId ?? null,
		),
	};
});

import {
	db,
	getLinkedSlackChannels,
	getLinkedTeamsChannels,
	upsertNewsletterSettings,
} from "@repo/database";
import {
	updateNewsletterSettingsInput,
	updateSettingsProcedure,
} from "../settings-update";

describe("updateNewsletterSettingsInput.detailLevel (AC-6)", () => {
	it("omitted → undefined (leave unchanged)", () => {
		const r = updateNewsletterSettingsInput.parse({ projectId: "p" });
		expect(r.detailLevel).toBeUndefined();
	});
	it("valid value passes through", () => {
		const r = updateNewsletterSettingsInput.parse({
			projectId: "p",
			detailLevel: "BRIEF",
		});
		expect(r.detailLevel).toBe("BRIEF");
	});
	it("invalid value coerces to STANDARD, does NOT throw", () => {
		const r = updateNewsletterSettingsInput.parse({
			projectId: "p",
			detailLevel: "NONSENSE",
		});
		expect(r.detailLevel).toBe("STANDARD");
	});
});

describe("updateNewsletterSettingsInput.deliveryDestination", () => {
	it("omitted → undefined (unchanged)", () => {
		expect(
			updateNewsletterSettingsInput.parse({ projectId: "p" })
				.deliveryDestination,
		).toBeUndefined();
	});
	it("valid passes through", () => {
		expect(
			updateNewsletterSettingsInput.parse({
				projectId: "p",
				deliveryDestination: "BOTH",
			}).deliveryDestination,
		).toBe("BOTH");
	});
	it("invalid coerces to EMAIL, never throws", () => {
		expect(
			updateNewsletterSettingsInput.parse({
				projectId: "p",
				deliveryDestination: "SMS",
			}).deliveryDestination,
		).toBe("EMAIL");
	});
	it("accepts a chatChannels array", () => {
		const r = updateNewsletterSettingsInput.parse({
			projectId: "p",
			chatChannels: [{ platform: "SLACK", teamId: "T", channelId: "C" }],
		});
		expect(r.chatChannels?.[0].channelId).toBe("C");
	});
});

describe("updateSettingsProcedure handler — F3 chat channel validation", () => {
	it("drops a submitted chatChannel not present in the linked-channel set", async () => {
		const project = {
			id: "proj-1",
			organizationId: null,
			userId: "user-1",
		};
		vi.mocked(db.project.findUnique).mockResolvedValue(project);
		vi.mocked(db.$transaction).mockImplementation(async (fn: any) =>
			fn({}),
		);
		vi.mocked(getLinkedTeamsChannels).mockResolvedValue([
			{ teamId: "T1", channelId: "C1" },
		] as any);
		vi.mocked(getLinkedSlackChannels).mockResolvedValue([
			{ slackTeamId: "ST1", channelId: "SC1" },
		] as any);
		vi.mocked(upsertNewsletterSettings).mockResolvedValue({} as any);

		await (updateSettingsProcedure as any)._handler({
			input: {
				projectId: "proj-1",
				organizationId: null,
				chatChannels: [
					// linked — must survive
					{ platform: "TEAMS", teamId: "T1", channelId: "C1" },
					// NOT linked — must be dropped
					{ platform: "SLACK", teamId: "ST1", channelId: "UNLINKED" },
				],
				deliveryDestination: "BOTH",
			},
			context: {
				session: {},
				user: { id: "user-1" },
			},
		});

		expect(upsertNewsletterSettings).toHaveBeenCalledTimes(1);
		const [, payload] = vi.mocked(upsertNewsletterSettings).mock.calls[0];
		expect(payload.chatChannels).toEqual([
			{ platform: "TEAMS", teamId: "T1", channelId: "C1" },
		]);
		expect(payload.deliveryDestination).toBe("BOTH");
	});
});
