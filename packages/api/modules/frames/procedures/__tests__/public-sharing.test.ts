/**
 * Every app procedure that can set a frame public (create, update, publish) is
 * mounted behind `publicSharingErrors`, which turns the organization's refusal
 * (`PublicSharingDisabledError`, thrown by the database command that makes the
 * check) into a `FORBIDDEN` the caller can read. The rule itself is
 * `publicSharingRefusal`'s, pinned in `@repo/database`; what these cases pin is
 * that no public-setting procedure is left outside it, and what it answers.
 *
 * Run with: pnpm --filter @repo/api test modules/frames/procedures/__tests__/public-sharing.test.ts
 */

import { call, ORPCError, os } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { used, handlers, mockPublishFrame, mockCreateFrame, mockUpdateFrame } =
	vi.hoisted(() => ({
		used: {} as Record<string, unknown[]>,
		handlers: {} as Record<string, (...args: unknown[]) => unknown>,
		mockPublishFrame: vi.fn(),
		mockCreateFrame: vi.fn(),
		mockUpdateFrame: vi.fn(),
	}));

vi.mock("@repo/database", () => {
	class PublicSharingDisabledError extends Error {
		constructor() {
			super("Public sharing is disabled for this organization.");
			this.name = "PublicSharingDisabledError";
		}
	}
	return {
		PublicSharingDisabledError,
		publishFrame: mockPublishFrame,
		createFrame: mockCreateFrame,
		updateFrame: mockUpdateFrame,
	};
});

vi.mock("../../../../orpc/procedures", () => {
	let current = "";
	const chainable: any = {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers[current] = fn;
			return { _handler: fn };
		},
	};
	// Middleware mounted before `.route` belongs to the next route: keep it
	// until the path is known.
	const early: unknown[] = [];
	const proxy: any = {
		...chainable,
		use: (middleware: unknown) => {
			early.push(middleware);
			return proxy;
		},
		route: (route: { path: string }) => {
			current = route.path;
			used[current] = [...early];
			early.length = 0;
			return chainable;
		},
	};
	return {
		tenantProtectedProcedure: proxy,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
		resolveOrganizationId: vi.fn(
			(organizationId: string | null | undefined) =>
				organizationId ?? undefined,
		),
	};
});

import { PublicSharingDisabledError } from "@repo/database";
import { publicSharingErrors } from "../../lib/public-sharing-errors";
import "../create";
import "../publish";
import "../update";

const PUBLIC_SETTERS = [
	"/frames",
	"/frames/{id}",
	"/frames/{id}/publish",
] as const;

beforeEach(() => {
	vi.clearAllMocks();
});

describe("the procedures that can set a frame public", () => {
	it.each(PUBLIC_SETTERS)(
		"%s is mounted behind publicSharingErrors",
		(path) => {
			expect(used[path]).toContain(publicSharingErrors);
		},
	);
});

describe("publicSharingErrors", () => {
	const procedure = (failure: Error) =>
		os.use(publicSharingErrors).handler(async () => {
			throw failure;
		});

	it("answers the organization's refusal as FORBIDDEN, in the sentence the share path uses", async () => {
		const error = await call(
			procedure(new PublicSharingDisabledError()),
			undefined,
		).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(ORPCError);
		expect(error).toMatchObject({
			code: "FORBIDDEN",
			message: "Public sharing is disabled for this organization.",
		});
	});

	it("leaves any other failure as it was", async () => {
		const failure = new Error("database unavailable");

		const error = await call(procedure(failure), undefined).catch(
			(caught: unknown) => caught,
		);

		expect(error).toBe(failure);
	});
});

describe("frames.publish", () => {
	it("lets the refusal from the command out, for the middleware to answer", async () => {
		mockPublishFrame.mockRejectedValue(new PublicSharingDisabledError());

		await expect(
			handlers["/frames/{id}/publish"]({
				input: { id: "frame-1", organizationId: "org-1" },
				context: { user: { id: "owner-1" }, session: {} },
			}),
		).rejects.toBeInstanceOf(PublicSharingDisabledError);
		expect(mockPublishFrame).toHaveBeenCalledWith(
			expect.objectContaining({ id: "frame-1", organizationId: "org-1" }),
		);
	});

	it("answers the share token when the organization allows it", async () => {
		mockPublishFrame.mockResolvedValue({
			id: "frame-1",
			shareToken: "token-1",
			isPublic: true,
		});

		const result = await handlers["/frames/{id}/publish"]({
			input: { id: "frame-1", organizationId: "org-1" },
			context: { user: { id: "owner-1" }, session: {} },
		});

		expect(result).toEqual({
			id: "frame-1",
			shareToken: "token-1",
			isPublic: true,
		});
	});
});
