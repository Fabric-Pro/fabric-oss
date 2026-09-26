/**
 * The public v1 prompts routes cannot exceed what the caller could do in the
 * app (AGENTS.md, "API keys never grant more than the UI").
 *
 * In the app only an organization's admins and owners may create or change its
 * prompts. `POST /prompts` always resolves an organization and created an
 * organization-scoped prompt for any member whose key carried
 * `prompts:write`; `PATCH /prompts/:id` updated any organization prompt the
 * same way. Both now re-read the key owner's live role on every call — for a
 * wildcard `*` key too — and refuse with the nested `{ error: { message } }`
 * shape, which keeps a role refusal distinguishable from the scope
 * middleware's flat `{ error: "Missing required scope: …" }`.
 *
 * Each refusal asserts on the write, not only the status code.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		createPrompt: vi.fn(),
		updatePrompt: vi.fn(),
		findPrompt: vi.fn(),
		verifyOrganizationMembership: vi.fn(),
		scopes: ["prompts:write"] as string[],
	},
}));

vi.mock("@repo/database", () => ({
	createPrompt: mocks.createPrompt,
	updatePrompt: mocks.updatePrompt,
	listPrompts: vi.fn(),
	db: { prompt: { findFirst: mocks.findPrompt } },
}));

vi.mock("../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: mocks.verifyOrganizationMembership,
}));

// A faithful stand-in for the real middleware: the scope refusal is the other
// half of the contract, and its flat body is what the role refusal must differ from.
vi.mock("../../external-api/middleware/api-key-auth", () => ({
	requireScope:
		(scope: string) =>
		async (
			c: { json: (body: unknown, status: number) => unknown },
			next: () => Promise<unknown>,
		) => {
			if (!mocks.scopes.includes(scope) && !mocks.scopes.includes("*")) {
				return c.json(
					{ error: `Missing required scope: ${scope}` },
					403,
				);
			}
			return next();
		},
}));

vi.mock("../helpers", async (importOriginal) => ({
	...(await importOriginal<typeof import("../helpers")>()),
	resolveV1Context: async () => ({
		userId: "user-1",
		organizationId: "org-1",
	}),
}));

const { registerPromptRoutes } = await import("../prompts");

const ROW = {
	id: "p-1",
	key: "meeting-summary",
	name: "Meeting summary",
	description: null,
	scope: "ORG",
	organizationId: "org-1",
	userId: null,
	category: null,
	tags: [],
	format: "PLAIN_TEXT",
	usageCount: 0,
	createdAt: new Date("2026-09-26T00:00:00Z"),
	updatedAt: new Date("2026-09-26T00:00:00Z"),
};

function request(method: "POST" | "PATCH", path: string, body: unknown) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("externalApiContext", {
			keyType: "personal",
			userId: "user-1",
			organizationId: undefined,
			scopes: mocks.scopes,
		});
		await next();
	});
	registerPromptRoutes(
		app as unknown as Parameters<typeof registerPromptRoutes>[0],
	);
	return app.request(path, {
		method,
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

const create = () =>
	request("POST", "/prompts", {
		key: "meeting-summary",
		name: "Meeting summary",
		content: "Summarise the notes.",
	});
const rename = () => request("PATCH", "/prompts/p-1", { name: "Renamed" });

const asRole = (role: string | null) =>
	mocks.verifyOrganizationMembership.mockResolvedValue(
		role ? { organization: { id: "org-1" }, role } : null,
	);

beforeEach(() => {
	mocks.createPrompt.mockReset().mockResolvedValue(ROW);
	mocks.updatePrompt
		.mockReset()
		.mockResolvedValue({ ...ROW, name: "Renamed" });
	mocks.findPrompt.mockReset().mockResolvedValue(ROW);
	mocks.verifyOrganizationMembership.mockReset();
	mocks.scopes = ["prompts:write"];
});

describe("v1 POST /prompts — the key owner's live role", () => {
	it("refuses a plain member and creates nothing", async () => {
		asRole("member");
		const res = await create();

		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({
			error: {
				message:
					"Only organization admins can create organization prompts",
			},
		});
		expect(mocks.createPrompt).not.toHaveBeenCalled();
		expect(mocks.verifyOrganizationMembership).toHaveBeenCalledWith(
			"org-1",
			"user-1",
		);
	});

	it("refuses a plain member even with a wildcard key", async () => {
		mocks.scopes = ["*"];
		asRole("member");

		expect((await create()).status).toBe(403);
		expect(mocks.createPrompt).not.toHaveBeenCalled();
	});

	it("refuses someone who is no longer a member", async () => {
		asRole(null);

		expect((await create()).status).toBe(403);
		expect(mocks.createPrompt).not.toHaveBeenCalled();
	});

	it.each(["admin", "owner"])(
		"lets an organization %s create",
		async (role) => {
			asRole(role);

			expect((await create()).status).toBe(201);
			expect(mocks.createPrompt).toHaveBeenCalledWith(
				expect.objectContaining({
					scope: "ORG",
					organizationId: "org-1",
				}),
			);
		},
	);

	it("keeps a scope refusal distinct from a role refusal", async () => {
		mocks.scopes = ["prompts:read"];
		asRole("admin");
		const res = await create();

		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({
			error: "Missing required scope: prompts:write",
		});
		expect(mocks.createPrompt).not.toHaveBeenCalled();
	});
});

describe("v1 PATCH /prompts/:id — the key owner's live role", () => {
	it("refuses a plain member on an organization prompt and writes nothing", async () => {
		asRole("member");
		const res = await rename();

		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({
			error: {
				message:
					"Only organization admins can update organization prompts",
			},
		});
		expect(mocks.updatePrompt).not.toHaveBeenCalled();
	});

	it("refuses a plain member even with a wildcard key", async () => {
		mocks.scopes = ["*"];
		asRole("member");

		expect((await rename()).status).toBe(403);
		expect(mocks.updatePrompt).not.toHaveBeenCalled();
	});

	it.each(["admin", "owner"])(
		"lets an organization %s update",
		async (role) => {
			asRole(role);

			expect((await rename()).status).toBe(200);
			expect(mocks.updatePrompt).toHaveBeenCalledWith(
				expect.objectContaining({ id: "p-1", name: "Renamed" }),
			);
		},
	);

	it("still 404s a prompt outside the caller's organization before any role check", async () => {
		mocks.findPrompt.mockResolvedValue(null);
		asRole("admin");

		expect((await rename()).status).toBe(404);
		expect(mocks.verifyOrganizationMembership).not.toHaveBeenCalled();
		expect(mocks.updatePrompt).not.toHaveBeenCalled();
	});
});
