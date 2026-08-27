import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	getPendingInvitationByEmail: vi.fn(),
	getPendingProjectInvitationByEmail: vi.fn(),
	getUserByEmail: vi.fn(),
}));

vi.mock("@repo/config", () => ({
	config: { auth: { enableSignup: false } },
}));

import {
	getPendingInvitationByEmail,
	getPendingProjectInvitationByEmail,
	getUserByEmail,
} from "@repo/database";
import type { Mock } from "vitest";
import {
	invitationOnlyPlugin,
	lookupInvitation,
} from "../../plugins/invitation-only";

describe("invitation-only matchers", () => {
	const plugin = invitationOnlyPlugin();
	const matcher = plugin.hooks?.before?.[0]?.matcher;
	if (!matcher) {
		throw new Error("matcher missing");
	}

	it.each([
		"/sign-up/email",
		"/sign-up/username",
		"/sign-in/magic-link",
		"/callback/google",
		"/callback/github",
		"/oauth2/callback/microsoft",
	])("matches %s", (path) => {
		expect(matcher({ path } as never)).toBe(true);
	});

	it("does not match /get-session", () => {
		expect(matcher({ path: "/get-session" } as never)).toBe(false);
	});
});

describe("lookupInvitation", () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	it("normalizes email before lookup", async () => {
		(
			getPendingInvitationByEmail as unknown as ReturnType<typeof vi.fn>
		).mockResolvedValue({ id: "inv1" });
		await lookupInvitation(" Foo@Example.COM ");
		expect(getPendingInvitationByEmail).toHaveBeenCalledWith(
			"foo@example.com",
		);
	});

	it("returns null for empty/whitespace email", async () => {
		const res = await lookupInvitation("   ");
		expect(res).toBeNull();
		expect(getPendingInvitationByEmail).not.toHaveBeenCalled();
	});

	it("falls back to a project invitation when there is no org invitation", async () => {
		(getPendingInvitationByEmail as Mock).mockResolvedValue(null);
		(getPendingProjectInvitationByEmail as Mock).mockResolvedValue({
			id: "pinv1",
		});
		const res = await lookupInvitation("guest@example.com");
		expect(res).toMatchObject({ id: "pinv1" });
		expect(getPendingProjectInvitationByEmail).toHaveBeenCalledWith(
			"guest@example.com",
		);
	});
});

describe("invitation-only handler", () => {
	const plugin = invitationOnlyPlugin();
	const handler = plugin.hooks?.before?.[0]?.handler;
	if (!handler) {
		throw new Error("handler missing");
	}

	beforeEach(() => {
		vi.resetAllMocks();
	});

	it("blocks OAuth callback when enableSignup=false and no email in body", async () => {
		// config mock already sets enableSignup=false at module level
		(getPendingInvitationByEmail as Mock).mockResolvedValue(null);
		await expect(
			handler({ path: "/callback/google", body: {} } as never),
		).rejects.toMatchObject({
			status: "BAD_REQUEST",
			body: { code: "INVALID_INVITATION" },
		});
	});

	it("blocks sign-up when enableSignup=false and no pending invitation", async () => {
		(getPendingInvitationByEmail as Mock).mockResolvedValue(null);
		(getPendingProjectInvitationByEmail as Mock).mockResolvedValue(null);
		await expect(
			handler({
				path: "/sign-up/email",
				body: { email: "unknown@example.com" },
			} as never),
		).rejects.toMatchObject({
			status: "BAD_REQUEST",
			body: { code: "INVALID_INVITATION" },
		});
	});

	it("allows sign-up when enableSignup=false and a valid invitation exists", async () => {
		(getPendingInvitationByEmail as Mock).mockResolvedValue({ id: "inv1" });
		await expect(
			handler({
				path: "/sign-up/email",
				body: { email: "invited@example.com" },
			} as never),
		).resolves.toBeUndefined();
	});

	it("allows sign-up when enableSignup=false and a valid PROJECT invitation exists (no org invite)", async () => {
		(getPendingInvitationByEmail as Mock).mockResolvedValue(null);
		(getPendingProjectInvitationByEmail as Mock).mockResolvedValue({
			id: "pinv1",
		});
		await expect(
			handler({
				path: "/sign-up/email",
				body: { email: "guest@example.com" },
			} as never),
		).resolves.toBeUndefined();
	});

	it("allows magic-link sign-in for an existing user without invitation", async () => {
		(getUserByEmail as Mock).mockResolvedValue({ id: "u1" });
		(getPendingInvitationByEmail as Mock).mockResolvedValue(null);
		await expect(
			handler({
				path: "/sign-in/magic-link",
				body: { email: "existing@example.com" },
			} as never),
		).resolves.toBeUndefined();
		expect(getPendingInvitationByEmail).not.toHaveBeenCalled();
	});

	it("blocks magic-link signup for a new email without invitation", async () => {
		(getUserByEmail as Mock).mockResolvedValue(null);
		(getPendingInvitationByEmail as Mock).mockResolvedValue(null);
		(getPendingProjectInvitationByEmail as Mock).mockResolvedValue(null);
		await expect(
			handler({
				path: "/sign-in/magic-link",
				body: { email: "new@example.com" },
			} as never),
		).rejects.toMatchObject({
			status: "BAD_REQUEST",
			body: { code: "INVALID_INVITATION" },
		});
	});

	it("does not bypass /sign-up/email even when user already exists", async () => {
		(getUserByEmail as Mock).mockResolvedValue({ id: "u1" });
		(getPendingInvitationByEmail as Mock).mockResolvedValue(null);
		await expect(
			handler({
				path: "/sign-up/email",
				body: { email: "existing@example.com" },
			} as never),
		).rejects.toMatchObject({
			status: "BAD_REQUEST",
			body: { code: "INVALID_INVITATION" },
		});
		// /sign-up/email is signup-only — user lookup should not be consulted
		expect(getUserByEmail).not.toHaveBeenCalled();
	});
});

describe("invitation-only handler — open signup", () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	it("is a no-op when enableSignup=true (does not throw)", async () => {
		// Mutate the shared mock object — the plugin reads config.auth.enableSignup
		// at invocation time, so changing it on the live reference is sufficient.
		const { config } = await import("@repo/config");
		(config.auth as { enableSignup: boolean }).enableSignup = true;

		const plugin = invitationOnlyPlugin();
		const handler = plugin.hooks?.before?.[0]?.handler;
		if (!handler) {
			throw new Error("handler missing");
		}

		await expect(
			handler({ path: "/callback/google", body: {} } as never),
		).resolves.toBeUndefined();

		// Restore for subsequent tests
		(config.auth as { enableSignup: boolean }).enableSignup = false;
	});
});
