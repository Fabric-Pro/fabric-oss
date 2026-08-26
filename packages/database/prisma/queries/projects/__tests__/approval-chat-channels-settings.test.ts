import { beforeEach, describe, expect, it, vi } from "vitest";

const upsert = vi.fn();
vi.mock("../../../client", () => ({
	db: { newsletterSettings: { upsert } },
}));

const { newsletterSettingsDefaults, upsertNewsletterSettings } = await import(
	"../newsletter"
);

const base = {
	userId: null,
	organizationId: "org-1",
	createdByUserId: "user-1",
};

beforeEach(() => {
	vi.clearAllMocks();
	upsert.mockResolvedValue({});
});

describe("approvalChatChannels persistence", () => {
	it("defaults to an empty list for a project with no settings row", () => {
		expect(newsletterSettingsDefaults("p-1").approvalChatChannels).toEqual(
			[],
		);
	});

	it("persists a submitted list on create and on update", async () => {
		const channels = [
			{
				platform: "SLACK" as const,
				teamId: "T-example",
				channelId: "C-example",
				channelName: "releases",
			},
		];
		await upsertNewsletterSettings("p-1", {
			...base,
			approvalChatChannels: channels,
		});
		const arg = upsert.mock.calls[0][0];
		expect(arg.create.approvalChatChannels).toEqual(channels);
		expect(arg.update.approvalChatChannels).toEqual(channels);
	});

	it("an empty list is persisted, because [] means turn chat alerts off", async () => {
		await upsertNewsletterSettings("p-1", {
			...base,
			approvalChatChannels: [],
		});
		expect(upsert.mock.calls[0][0].update.approvalChatChannels).toEqual([]);
	});

	it("an omitted field leaves the stored value untouched on update", async () => {
		await upsertNewsletterSettings("p-1", { ...base, enabled: true });
		expect(upsert.mock.calls[0][0].update).not.toHaveProperty(
			"approvalChatChannels",
		);
	});
});
