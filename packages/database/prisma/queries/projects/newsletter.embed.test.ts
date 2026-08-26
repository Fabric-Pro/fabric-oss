import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the prisma client so the embed query helpers can be unit-tested without
// a DB. Mirrors the dir's established style (see newsletter.test.ts).
const settingsFindUnique = vi.fn();
const settingsUpdate = vi.fn();
vi.mock("../../client", () => ({
	db: {
		newsletterSettings: {
			// publicEmbedToken is @unique → resolveProjectByEmbedToken uses findUnique.
			findUnique: (...a: unknown[]) => settingsFindUnique(...a),
			update: (...a: unknown[]) => settingsUpdate(...a),
		},
	},
}));

import {
	newsletterSettingsDefaults,
	regenerateEmbedToken,
	resolveProjectByEmbedToken,
	setPublicWidgetState,
} from "./newsletter";

describe("resolveProjectByEmbedToken", () => {
	beforeEach(() => settingsFindUnique.mockReset());

	it("returns null for an empty token without hitting the DB", async () => {
		expect(await resolveProjectByEmbedToken("")).toBeNull();
		expect(settingsFindUnique).not.toHaveBeenCalled();
	});

	it("returns null for an unknown token", async () => {
		settingsFindUnique.mockResolvedValueOnce(null);
		expect(await resolveProjectByEmbedToken("nope")).toBeNull();
		expect(settingsFindUnique).toHaveBeenCalledWith(
			expect.objectContaining({ where: { publicEmbedToken: "nope" } }),
		);
	});

	it("returns project + widget fields when the settings row matches", async () => {
		settingsFindUnique.mockResolvedValueOnce({
			projectId: "p1",
			organizationId: "o1",
			userId: null,
			publicWidgetEnabled: true,
			publicEmbedTokenVersion: 3,
			publicWidgetTheme: "dark",
			publicWidgetAccent: "#9F2A3A",
			publicWidgetConfig: { width: 420 },
			createdByUserId: "creator-1",
		});
		const r = await resolveProjectByEmbedToken("tok");
		expect(r).toEqual({
			projectId: "p1",
			organizationId: "o1",
			userId: null,
			publicWidgetEnabled: true,
			publicEmbedTokenVersion: 3,
			createdByUserId: "creator-1",
			theme: "dark",
			accent: "#9F2A3A",
			config: { width: 420 },
		});
	});
});

describe("setPublicWidgetState", () => {
	function makeTx(
		locked: {
			publicWidgetEnabled: boolean;
			publicEmbedToken: string | null;
			publicEmbedTokenVersion: number;
		} | null,
		updated: {
			publicEmbedToken: string | null;
			publicEmbedTokenVersion: number;
		},
	) {
		return {
			$queryRaw: vi.fn().mockResolvedValue(locked ? [locked] : []),
			newsletterSettings: { update: vi.fn().mockResolvedValue(updated) },
			// biome-ignore lint/suspicious/noExplicitAny: mock tx client
		} as any;
	}

	it("first enable on a null-token row mints a token and does NOT bump version", async () => {
		const tx = makeTx(
			{
				publicWidgetEnabled: false,
				publicEmbedToken: null,
				publicEmbedTokenVersion: 1,
			},
			{ publicEmbedToken: "minted", publicEmbedTokenVersion: 1 },
		);
		const r = await setPublicWidgetState("p1", true, tx);
		expect(r).toEqual({ changed: true, token: "minted", version: 1 });

		const arg = tx.newsletterSettings.update.mock.calls[0][0];
		expect(arg.data.publicWidgetEnabled).toBe(true);
		// A token was minted.
		expect(typeof arg.data.publicEmbedToken).toBe("string");
		expect(arg.data.publicEmbedToken.length).toBeGreaterThan(0);
		// No version bump on first mint.
		expect(arg.data).not.toHaveProperty("publicEmbedTokenVersion");
	});

	it("a second enable keeps the same token and version (changed:false, no mint)", async () => {
		const tx = makeTx(
			{
				publicWidgetEnabled: true,
				publicEmbedToken: "tok",
				publicEmbedTokenVersion: 1,
			},
			{ publicEmbedToken: "tok", publicEmbedTokenVersion: 1 },
		);
		const r = await setPublicWidgetState("p1", true, tx);
		expect(r).toEqual({ changed: false, token: "tok", version: 1 });

		const arg = tx.newsletterSettings.update.mock.calls[0][0];
		expect(arg.data.publicWidgetEnabled).toBe(true);
		// Already has a token → no re-mint.
		expect(arg.data).not.toHaveProperty("publicEmbedToken");
		expect(arg.data).not.toHaveProperty("publicEmbedTokenVersion");
	});

	it("disable of an enabled row bumps version, keeps token, returns changed:true", async () => {
		const tx = makeTx(
			{
				publicWidgetEnabled: true,
				publicEmbedToken: "tok",
				publicEmbedTokenVersion: 2,
			},
			{ publicEmbedToken: "tok", publicEmbedTokenVersion: 3 },
		);
		const r = await setPublicWidgetState("p1", false, tx);
		expect(r).toEqual({ changed: true, token: "tok", version: 3 });

		expect(tx.newsletterSettings.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					publicWidgetEnabled: false,
					publicEmbedTokenVersion: { increment: 1 },
				}),
			}),
		);
		// Disable never mints a token.
		expect(
			tx.newsletterSettings.update.mock.calls[0][0].data,
		).not.toHaveProperty("publicEmbedToken");
	});

	it("disable of an already-disabled row is a no-op: changed:false, NO version bump", async () => {
		const tx = makeTx(
			{
				publicWidgetEnabled: false,
				publicEmbedToken: "tok",
				publicEmbedTokenVersion: 4,
			},
			{ publicEmbedToken: "tok", publicEmbedTokenVersion: 4 },
		);
		const r = await setPublicWidgetState("p1", false, tx);
		expect(r).toEqual({ changed: false, token: "tok", version: 4 });

		const arg = tx.newsletterSettings.update.mock.calls[0][0];
		expect(arg.data).not.toHaveProperty("publicEmbedTokenVersion");
		expect(arg.data).not.toHaveProperty("publicEmbedToken");
	});

	it("locks the row with SELECT ... FOR UPDATE before updating", async () => {
		const tx = makeTx(
			{
				publicWidgetEnabled: true,
				publicEmbedToken: "tok",
				publicEmbedTokenVersion: 1,
			},
			{ publicEmbedToken: "tok", publicEmbedTokenVersion: 1 },
		);
		await setPublicWidgetState("p1", true, tx);
		expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
		// The raw fragment must request a row lock.
		const sqlParts = tx.$queryRaw.mock.calls[0][0] as TemplateStringsArray;
		expect(sqlParts.join(" ").toUpperCase()).toContain("FOR UPDATE");
	});

	it("returns a defensive no-op when the settings row is absent", async () => {
		const tx = makeTx(null, {
			publicEmbedToken: null,
			publicEmbedTokenVersion: 1,
		});
		const r = await setPublicWidgetState("p1", true, tx);
		expect(r).toEqual({ changed: false, token: "", version: 1 });
		expect(tx.newsletterSettings.update).not.toHaveBeenCalled();
	});

	it("rejects a non-transaction client (base db)", async () => {
		// The guard is `if ("$transaction" in client) throw …`: a base PrismaClient
		// exposes `$transaction` (a TransactionClient does not), so handing the base
		// db in must throw BEFORE any query runs — never silently lose the FOR UPDATE
		// lock guarantee.
		const fakeBaseDb = {
			$transaction: vi.fn(),
			$queryRaw: vi.fn(),
			newsletterSettings: { update: vi.fn() },
			// biome-ignore lint/suspicious/noExplicitAny: mock base db client
		} as any;
		await expect(
			setPublicWidgetState("p1", true, fakeBaseDb),
		).rejects.toThrow(/transaction client/i);
		expect(fakeBaseDb.$queryRaw).not.toHaveBeenCalled();
		expect(fakeBaseDb.newsletterSettings.update).not.toHaveBeenCalled();
	});
});

describe("regenerateEmbedToken", () => {
	beforeEach(() => settingsUpdate.mockReset());

	it("writes a new token AND increments the version", async () => {
		settingsUpdate.mockResolvedValueOnce({
			publicEmbedToken: "fresh",
			publicEmbedTokenVersion: 5,
		});
		const r = await regenerateEmbedToken("p1");
		expect(r).toEqual({ token: "fresh", version: 5 });

		const arg = settingsUpdate.mock.calls[0][0];
		expect(arg.where).toEqual({ projectId: "p1" });
		expect(typeof arg.data.publicEmbedToken).toBe("string");
		expect(arg.data.publicEmbedToken.length).toBeGreaterThan(0);
		expect(arg.data.publicEmbedTokenVersion).toEqual({ increment: 1 });
	});
});

describe("newsletterSettingsDefaults — widget fields", () => {
	it("yields disabled widget defaults so first load returns defined fields", () => {
		const d = newsletterSettingsDefaults("p1");
		expect(d).toMatchObject({
			publicWidgetEnabled: false,
			publicEmbedToken: null,
			publicEmbedTokenVersion: 1,
			publicWidgetTheme: null,
			publicWidgetAccent: null,
			publicWidgetConfig: null,
		});
	});
});
