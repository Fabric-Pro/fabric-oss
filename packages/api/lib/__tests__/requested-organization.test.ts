import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	hasOrganizationTie: vi.fn(async () => false),
}));

import { hasOrganizationTie } from "@repo/database";
import {
	forbiddenOrganizationResponse,
	NO_ORGANIZATION_MESSAGE,
	NOT_A_MEMBER_MESSAGE,
	resolveRequestedOrganization,
} from "../requested-organization";

const forbidden = (message: string) => ({
	ok: false,
	status: 403,
	error: "Forbidden",
	message,
});

describe("resolveRequestedOrganization — id supplied", () => {
	it("refuses an organization the caller has no tie to", async () => {
		const hasTie = vi.fn(async () => false);
		const result = await resolveRequestedOrganization({
			userId: "user-1",
			requestedOrganizationId: "org-victim",
			activeOrganizationId: "org-victim",
			hasTie,
		});
		expect(hasTie).toHaveBeenCalledWith("user-1", "org-victim");
		expect(result).toEqual(forbidden(NOT_A_MEMBER_MESSAGE));
	});

	it("does not substitute another organization on refusal", async () => {
		const result = await resolveRequestedOrganization({
			userId: "user-1",
			requestedOrganizationId: "org-victim",
			activeOrganizationId: "org-home",
			hasTie: async () => false,
		});
		expect(result.ok).toBe(false);
		expect("organizationId" in result).toBe(false);
	});

	it("honours an organization the caller is tied to, even when it is not the session's active one", async () => {
		const result = await resolveRequestedOrganization({
			userId: "user-1",
			requestedOrganizationId: "org-second-tab",
			activeOrganizationId: "org-first-tab",
			hasTie: async (_userId, organizationId) =>
				organizationId === "org-second-tab",
		});
		expect(result).toEqual({ ok: true, organizationId: "org-second-tab" });
	});

	it("admits a project-scoped guest: the tie check, not membership, decides", async () => {
		// `hasOrganizationTie` is what says true for an accepted, unexpired
		// project guest; the resolver must go through it, not a membership
		// row check of its own.
		vi.mocked(hasOrganizationTie).mockResolvedValueOnce(true);
		const result = await resolveRequestedOrganization({
			userId: "guest-1",
			requestedOrganizationId: "org-host",
			activeOrganizationId: null,
		});
		expect(hasOrganizationTie).toHaveBeenCalledWith("guest-1", "org-host");
		expect(result).toEqual({ ok: true, organizationId: "org-host" });
	});
});

describe("resolveRequestedOrganization — id omitted (ADR-018: no personal arm)", () => {
	it("resolves the session's active organization when the caller is tied to it", async () => {
		const hasTie = vi.fn(async () => true);
		for (const requested of [undefined, null, ""]) {
			const result = await resolveRequestedOrganization({
				userId: "user-1",
				requestedOrganizationId: requested,
				activeOrganizationId: "org-active",
				hasTie,
			});
			expect(result).toEqual({ ok: true, organizationId: "org-active" });
		}
		expect(hasTie).toHaveBeenCalledTimes(3);
		expect(hasTie).toHaveBeenCalledWith("user-1", "org-active");
	});

	it("refuses a stale active organization the caller has no tie to any more", async () => {
		const hasTie = vi.fn(async () => false);
		const result = await resolveRequestedOrganization({
			userId: "user-1",
			requestedOrganizationId: undefined,
			activeOrganizationId: "org-left",
			hasTie,
		});
		expect(hasTie).toHaveBeenCalledWith("user-1", "org-left");
		expect(result).toEqual(forbidden(NOT_A_MEMBER_MESSAGE));
	});

	it("refuses a session with no active organization instead of serving a null tenant", async () => {
		const hasTie = vi.fn(async () => true);
		for (const active of [undefined, null, ""]) {
			const result = await resolveRequestedOrganization({
				userId: "user-1",
				requestedOrganizationId: undefined,
				activeOrganizationId: active,
				hasTie,
			});
			expect(result).toEqual(forbidden(NO_ORGANIZATION_MESSAGE));
		}
		expect(hasTie).not.toHaveBeenCalled();
	});

	it("never yields an undefined organization on success", async () => {
		const result = await resolveRequestedOrganization({
			userId: "user-1",
			requestedOrganizationId: undefined,
			activeOrganizationId: "org-active",
			hasTie: async () => true,
		});
		expect(result.ok && typeof result.organizationId === "string").toBe(
			true,
		);
	});
});

describe("forbiddenOrganizationResponse", () => {
	it("returns a JSON 403 with the resolver's message", async () => {
		const response = forbiddenOrganizationResponse({
			ok: false,
			status: 403,
			error: "Forbidden",
			message: NOT_A_MEMBER_MESSAGE,
		});
		expect(response.status).toBe(403);
		expect(response.headers.get("Content-Type")).toBe("application/json");
		await expect(response.json()).resolves.toEqual({
			error: "Forbidden",
			message: NOT_A_MEMBER_MESSAGE,
		});
	});
});
