import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	canUseOrganizationAiChat: vi.fn(),
	findMany: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	canUseOrganizationAiChat: mocks.canUseOrganizationAiChat,
	db: { aiChat: { findMany: mocks.findMany } },
}));

vi.mock("@repo/api/modules/v1/instruction-direct-repository", () => ({
	getDirectRepositoryState: vi.fn(),
}));

import { executePlatformTool } from "../platform-tools";
import type { GatewaySession } from "../types";

const session: GatewaySession = {
	sessionId: "example-session",
	userId: "example-user",
	organizationId: "example-org",
	userName: "Example Developer",
	email: "dev@example.com",
	role: "user",
	credential: "organization-key",
	scopes: ["chats:read"],
	createdAt: new Date("2026-01-01T00:00:00Z"),
	expiresAt: new Date("2026-01-02T00:00:00Z"),
};

const now = new Date("2026-01-01T00:00:00Z");
const chat = {
	id: "example-chat",
	title: "Example chat",
	createdAt: now,
	updatedAt: now,
};

beforeEach(() => {
	vi.resetAllMocks();
	mocks.canUseOrganizationAiChat.mockResolvedValue(true);
	mocks.findMany.mockResolvedValue([chat]);
});

it("refuses a missing scope before checking the creator's live permission", async () => {
	const result = await executePlatformTool(
		"fabric_list_chats",
		{},
		{
			...session,
			scopes: ["projects:read"],
		},
	);

	expect(result.isError).toBe(true);
	expect(JSON.parse(result.content[0].text).error).toContain(
		'does not have the "chats:read" scope required by fabric_list_chats',
	);
	expect(mocks.canUseOrganizationAiChat).not.toHaveBeenCalled();
	expect(mocks.findMany).not.toHaveBeenCalled();
});

it.each(["chats:read", "*"])(
	"refuses chat reads after the key creator loses AI chat permission (%s)",
	async (scope) => {
		mocks.canUseOrganizationAiChat.mockResolvedValue(false);
		const result = await executePlatformTool(
			"fabric_list_chats",
			{},
			{
				...session,
				scopes: [scope],
			},
		);

		expect(result.isError).toBe(true);
		expect(JSON.parse(result.content[0].text)).toEqual({
			error: "No permission to read chats in this organization",
		});
		expect(mocks.canUseOrganizationAiChat).toHaveBeenCalledExactlyOnceWith(
			session.userId,
			session.organizationId,
		);
		expect(mocks.findMany).not.toHaveBeenCalled();
	},
);

it("refuses to read chats when the wildcard key has no organization context", async () => {
	const result = await executePlatformTool(
		"fabric_list_chats",
		{},
		{
			...session,
			credential: "personal-key",
			organizationId: null,
			scopes: ["*"],
		},
	);

	expect(result.isError).toBe(true);
	expect(JSON.parse(result.content[0].text)).toEqual({
		error: "No permission to read chats in this organization",
	});
	expect(mocks.canUseOrganizationAiChat).not.toHaveBeenCalled();
	expect(mocks.findMany).not.toHaveBeenCalled();
});

it("lists only the verified creator's chats in the authorized organization", async () => {
	const result = await executePlatformTool(
		"fabric_list_chats",
		{ limit: 2 },
		session,
	);

	expect(result.isError).toBeUndefined();
	expect(JSON.parse(result.content[0].text)).toEqual({
		chats: [
			{
				...chat,
				createdAt: now.toISOString(),
				updatedAt: now.toISOString(),
			},
		],
		count: 1,
	});
	expect(mocks.canUseOrganizationAiChat).toHaveBeenCalledExactlyOnceWith(
		session.userId,
		session.organizationId,
	);
	expect(mocks.findMany).toHaveBeenCalledExactlyOnceWith({
		where: {
			userId: session.userId,
			organizationId: session.organizationId,
		},
		select: { id: true, title: true, createdAt: true, updatedAt: true },
		orderBy: { updatedAt: "desc" },
		take: 2,
	});
});
