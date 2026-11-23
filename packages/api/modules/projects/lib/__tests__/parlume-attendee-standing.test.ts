import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	hasPermission: vi.fn(),
	userFindUnique: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		user: {
			findUnique: (...args: unknown[]) => mocks.userFindUnique(...args),
		},
	},
}));

vi.mock("../../../../orpc/middleware/require-permission", () => ({
	userHasProjectPermission: (...args: unknown[]) =>
		mocks.hasPermission(...args),
}));

const {
	findParlumeAttendeeWithoutRead,
	mayReadParlumeProject,
	parlumeDepartureNotice,
} = await import("../parlume-attendee-standing");

beforeEach(() => {
	vi.resetAllMocks();
	mocks.hasPermission.mockResolvedValue(true);
	mocks.userFindUnique.mockResolvedValue({ name: "Dana Member" });
});

describe("mayReadParlumeProject", () => {
	it("asks for project read", async () => {
		await expect(
			mayReadParlumeProject({ userId: "user-1", projectId: "project-1" }),
		).resolves.toBe(true);
		expect(mocks.hasPermission).toHaveBeenCalledWith({
			userId: "user-1",
			projectId: "project-1",
			permission: "project:read",
		});
	});
});

describe("findParlumeAttendeeWithoutRead", () => {
	it("checks each confirmed attendee once and finds no one while all still read the project", async () => {
		await expect(
			findParlumeAttendeeWithoutRead({
				projectId: "project-1",
				userIds: ["user-1", "user-2", "user-1"],
			}),
		).resolves.toBeNull();
		expect(mocks.hasPermission).toHaveBeenCalledTimes(2);
		expect(mocks.userFindUnique).not.toHaveBeenCalled();
	});

	it("names the attendee who lost project read", async () => {
		mocks.hasPermission.mockImplementation(
			async ({ userId }: { userId: string }) => userId !== "user-2",
		);

		await expect(
			findParlumeAttendeeWithoutRead({
				projectId: "project-1",
				userIds: ["user-1", "user-2"],
			}),
		).resolves.toEqual({ name: "Dana Member" });
		expect(mocks.userFindUnique).toHaveBeenCalledWith({
			where: { id: "user-2" },
			select: { name: true },
		});
	});

	it("checks no one when no attendee is confirmed", async () => {
		await expect(
			findParlumeAttendeeWithoutRead({
				projectId: "project-1",
				userIds: [],
			}),
		).resolves.toBeNull();
		expect(mocks.hasPermission).not.toHaveBeenCalled();
	});
});

describe("parlumeDepartureNotice", () => {
	it("names the person by display name, in one plain paragraph", () => {
		expect(
			parlumeDepartureNotice({ kind: "attendee", name: " Sam Lee " }),
		).toBe(
			"I'm leaving: I could not confirm that Sam Lee can see this project in Fabric. I answer only when everyone in the meeting can.",
		);
	});

	it.each([
		["Sam Lee sam@example.com", "Sam Lee"],
		["Sam https://example.com/x Lee", "Sam Lee"],
		["Visit example.com now", "Visit now"],
		["www.example.com", "a participant"],
		["EXAMPLE.COM", "a participant"],
		["sam@example.com", "a participant"],
		["Sam example.com.", "Sam"],
		["Sam example.com,", "Sam"],
		["Sam (example.com)", "Sam"],
		["Sam [x](example.com)", "Sam"],
		["Sam example。com", "Sam"],
		["Sam example．com", "Sam"],
		["Dr.Smith Lee", "Dr.Smith Lee"],
		["", "a participant"],
		[null, "a participant"],
	])("prints %s as %s, without a link or an address", (name, shown) => {
		const notice = parlumeDepartureNotice({ kind: "attendee", name });

		expect(notice).toContain(`that ${shown} can see`);
		expect(notice).not.toMatch(/@|https?:|www\.|example\.com/);
	});

	it("says why a channel meeting cannot be answered in", () => {
		expect(parlumeDepartureNotice({ kind: "channel" })).toBe(
			"I'm leaving: this meeting's chat belongs to a Teams channel, and I cannot check that everyone who reads it can see this project in Fabric.",
		);
	});
});
