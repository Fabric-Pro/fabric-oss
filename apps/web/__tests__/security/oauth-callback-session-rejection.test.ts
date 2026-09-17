/**
 * The integration OAuth callback procedures are session-bound: the browser the
 * provider redirected must hold a Fabric session, and it must be the account
 * that started the flow. Those refusals arrive at the callback routes as oRPC
 * errors, not as a `{ success: false }` result, so the routes must still
 * render the popup's error path — the parent window gets an `*_oauth_error`
 * message, never a success — with copy that tells the user what to do.
 */

import { ORPCError } from "@orpc/client";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const oauthCallback = vi.fn();
const githubCallback = vi.fn();
const gitlabCallback = vi.fn();

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		integrations: {
			oauth: { callback: (...args: unknown[]) => oauthCallback(...args) },
			github: {
				callback: (...args: unknown[]) => githubCallback(...args),
			},
			gitlab: {
				callback: (...args: unknown[]) => gitlabCallback(...args),
			},
		},
	},
}));

import { GET as providerGet } from "../../app/api/integrations/[provider]/oauth/callback/route";
import {
	NOT_SIGNED_IN_MESSAGE,
	oauthCallbackFailureMessage,
} from "../../app/api/integrations/github/oauth/callback/callback-error";
import { GET as githubGet } from "../../app/api/integrations/github/oauth/callback/route";
import { GET as gitlabGet } from "../../app/api/integrations/gitlab/oauth/callback/route";
import { GET as genericGet } from "../../app/api/integrations/oauth/callback/route";

const FORBIDDEN_MESSAGE =
	"This connection was started from a different Fabric account. Sign in as the account that started it and try again.";

const routes: Array<{
	name: string;
	mock: ReturnType<typeof vi.fn>;
	render: () => Promise<string>;
	errorType: string;
}> = [
	{
		name: "generic /api/integrations/oauth/callback",
		mock: oauthCallback,
		errorType: "oauth_error",
		render: async () =>
			(
				await genericGet(
					new NextRequest(
						"https://app.example.com/api/integrations/oauth/callback?code=c&state=s",
					),
				)
			).text(),
	},
	{
		name: "dynamic /api/integrations/[provider]/oauth/callback",
		mock: oauthCallback,
		errorType: "slack_oauth_error",
		render: async () =>
			(
				await providerGet(
					new NextRequest(
						"https://app.example.com/api/integrations/slack/oauth/callback?code=c&state=s",
					),
					{ params: Promise.resolve({ provider: "slack" }) },
				)
			).text(),
	},
	{
		name: "/api/integrations/github/oauth/callback",
		mock: githubCallback,
		errorType: "github_oauth_error",
		render: async () =>
			(
				await githubGet(
					new NextRequest(
						"https://app.example.com/api/integrations/github/oauth/callback?code=c&state=s",
					),
				)
			).text(),
	},
	{
		name: "/api/integrations/gitlab/oauth/callback",
		mock: gitlabCallback,
		errorType: "gitlab_oauth_error",
		render: async () =>
			(
				await gitlabGet(
					new NextRequest(
						"https://app.example.com/api/integrations/gitlab/oauth/callback?code=c&state=s",
					),
				)
			).text(),
	},
];

describe.each(routes)("$name", ({ mock, render, errorType }) => {
	beforeEach(() => {
		oauthCallback.mockReset();
		githubCallback.mockReset();
		gitlabCallback.mockReset();
	});

	it("renders the error path with sign-in copy when the callback has no session", async () => {
		mock.mockRejectedValue(new ORPCError("UNAUTHORIZED"));
		const html = await render();

		expect(html).toContain(NOT_SIGNED_IN_MESSAGE);
		expect(html).toContain(errorType);
		expect(html).not.toMatch(/oauth_success/);
		expect(html).toContain("success: false");
		// The non-popup fallback goes to the settings page, never anywhere the
		// state named — the callback did not return a returnUrl.
		expect(html).toContain("/app/settings/integrations");
	});

	it("shows the server's own explanation when the session is a different account", async () => {
		mock.mockRejectedValue(
			new ORPCError("FORBIDDEN", { message: FORBIDDEN_MESSAGE }),
		);
		const html = await render();

		expect(html).toContain(FORBIDDEN_MESSAGE);
		expect(html).toContain(errorType);
		expect(html).not.toMatch(/oauth_success/);
	});
});

describe("oauthCallbackFailureMessage", () => {
	it("maps UNAUTHORIZED to the sign-in copy", () => {
		expect(
			oauthCallbackFailureMessage(new ORPCError("UNAUTHORIZED"), "fb"),
		).toBe(NOT_SIGNED_IN_MESSAGE);
	});

	it("passes a FORBIDDEN message through", () => {
		expect(
			oauthCallbackFailureMessage(
				new ORPCError("FORBIDDEN", { message: "no" }),
				"fb",
			),
		).toBe("no");
	});

	it("keeps the route's fallback for anything else", () => {
		expect(
			oauthCallbackFailureMessage(
				new ORPCError("INTERNAL_SERVER_ERROR", { message: "boom" }),
				"fb",
			),
		).toBe("fb");
		expect(oauthCallbackFailureMessage(new Error("boom"), "fb")).toBe("fb");
		expect(oauthCallbackFailureMessage("string", "fb")).toBe("fb");
	});
});
