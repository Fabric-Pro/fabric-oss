import { beforeEach, describe, expect, it, vi } from "vitest";

const { findUnique } = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock("@repo/database", () => ({
	db: { mCPServer: { findUnique } },
	isPmServerIdKeySentinel: (id: string) => id.startsWith("key:"),
	readPmServerIdKeySentinel: (id: string) => id.slice("key:".length),
}));

import {
	createStampToolTypeResolver,
	isLinkFromActiveTool,
	linkBelongsToActiveTool,
} from "../poll-link-scope";

beforeEach(() => findUnique.mockReset());

const link = (
	externalMcpServerId: string | null,
	externalUrl: string | null,
) => ({
	externalMcpServerId,
	externalUrl,
});

describe("isLinkFromActiveTool", () => {
	it("keeps every link when the active tool type is unknown (today's behaviour)", () => {
		expect(
			isLinkFromActiveTool(
				link("srv-fz", "https://app.fizzy.do/1/cards/5"),
				null,
				"fizzy",
			),
		).toBe(true);
	});

	it("decides by the stamp's tool type when it resolves", () => {
		expect(
			isLinkFromActiveTool(link("srv-fz", null), "gitlab", "fizzy"),
		).toBe(false);
		// Same tool, different server row — still polled.
		expect(
			isLinkFromActiveTool(link("srv-gl-old", null), "gitlab", "gitlab"),
		).toBe(true);
	});

	it("falls back to the URL host for a null or unresolvable stamp", () => {
		expect(
			isLinkFromActiveTool(
				link(null, "https://app.fizzy.do/1/cards/5"),
				"gitlab",
				null,
			),
		).toBe(false);
		expect(
			isLinkFromActiveTool(
				link("srv-gone", "https://app.fizzy.do/1/cards/5"),
				"gitlab",
				null,
			),
		).toBe(false);
		// Import-created GitLab link: no stamp, GitLab URL.
		expect(
			isLinkFromActiveTool(
				link(null, "https://gitlab.com/acme/portal/-/issues/5"),
				"gitlab",
				null,
			),
		).toBe(true);
		// No URL, unparsable URL, or a custom host proves nothing — kept.
		expect(isLinkFromActiveTool(link(null, null), "gitlab", null)).toBe(
			true,
		);
		expect(
			isLinkFromActiveTool(link(null, "not a url"), "gitlab", null),
		).toBe(true);
		expect(
			isLinkFromActiveTool(
				link(null, "https://tracker.example.com/5"),
				"gitlab",
				null,
			),
		).toBe(true);
	});
});

describe("createStampToolTypeResolver", () => {
	it("reads a key sentinel without the database", async () => {
		const resolve = createStampToolTypeResolver();
		expect(await resolve("key:gitlab-official")).toBe("gitlab");
		expect(findUnique).not.toHaveBeenCalled();
	});

	it("looks a server id up once and maps its key", async () => {
		findUnique.mockResolvedValue({ key: "fizzy" });
		const resolve = createStampToolTypeResolver();
		expect(await resolve("srv-fz")).toBe("fizzy");
		expect(await resolve("srv-fz")).toBe("fizzy");
		expect(findUnique).toHaveBeenCalledTimes(1);
		expect(findUnique).toHaveBeenCalledWith({
			where: { id: "srv-fz" },
			select: { key: true },
		});
	});

	it("returns null for a missing row, an unmapped key, and no stamp", async () => {
		const resolve = createStampToolTypeResolver();
		findUnique.mockResolvedValueOnce(null);
		expect(await resolve("srv-gone")).toBeNull();
		findUnique.mockResolvedValueOnce({ key: "slack" });
		expect(await resolve("srv-slack")).toBeNull();
		expect(await resolve(null)).toBeNull();
		expect(await resolve(undefined)).toBeNull();
	});
});

describe("linkBelongsToActiveTool", () => {
	it("resolves the stamp and applies the predicate; an unknown active tool skips the lookup", async () => {
		findUnique.mockResolvedValue({ key: "fizzy" });
		const resolve = createStampToolTypeResolver();
		expect(
			await linkBelongsToActiveTool(
				link("srv-fz", null),
				"gitlab",
				resolve,
			),
		).toBe(false);
		expect(await linkBelongsToActiveTool({}, "gitlab", resolve)).toBe(true);
		findUnique.mockClear();
		expect(
			await linkBelongsToActiveTool(link("srv-fz", null), null, resolve),
		).toBe(true);
		expect(findUnique).not.toHaveBeenCalled();
	});
});
