/**
 * The two generic OAuth callback routes render a page whose non-popup
 * fallback navigates to the `returnUrl` carried in the HMAC-signed OAuth
 * state. That value is chosen by the caller at `start` time and only signed,
 * never validated, so the routes must constrain it to a same-origin path
 * before it reaches `window.location.href` (open redirect, Fizzy #2370).
 */

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const callback = vi.fn();

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		integrations: {
			oauth: {
				callback: (...args: unknown[]) => callback(...args),
			},
		},
	},
}));

import { GET as providerGet } from "../../app/api/integrations/[provider]/oauth/callback/route";
import { GET as genericGet } from "../../app/api/integrations/oauth/callback/route";

const FALLBACK = "/app/settings/integrations";

async function renderGeneric(): Promise<string> {
	const res = await genericGet(
		new NextRequest(
			"https://app.example.com/api/integrations/oauth/callback?code=c&state=s",
		),
	);
	return res.text();
}

async function renderProvider(): Promise<string> {
	const res = await providerGet(
		new NextRequest(
			"https://app.example.com/api/integrations/slack/oauth/callback?code=c&state=s",
		),
		{ params: Promise.resolve({ provider: "slack" }) },
	);
	return res.text();
}

describe.each([
	["generic /api/integrations/oauth/callback", renderGeneric],
	["dynamic /api/integrations/[provider]/oauth/callback", renderProvider],
])("%s", (_name, render) => {
	beforeEach(() => {
		callback.mockReset();
	});

	it("keeps a same-origin relative returnUrl", async () => {
		callback.mockResolvedValue({
			success: true,
			message: "Connected",
			provider: "SLACK",
			returnUrl: "/app/projects/1?tab=integrations#repos",
		});
		const html = await render();
		// The OAuth result parameters go before the fragment, where the landing
		// page's return banner reads them.
		// (The provider label differs between the two routes, so match the shape.)
		expect(html).toMatch(
			/window\.location\.href = "\/app\/projects\/1\?tab=integrations&oauth=success&provider=[A-Za-z]+#repos"/,
		);
	});

	it.each([
		"https://evil.example/phish",
		"//evil.example",
		"/\\evil.example",
		"/\t/evil.example",
		"https://app.example.com/app/projects/1",
	])("falls back to the settings page for %j", async (returnUrl) => {
		callback.mockResolvedValue({
			success: true,
			message: "Connected",
			provider: "SLACK",
			returnUrl,
		});
		const html = await render();
		expect(html).not.toContain("evil.example");
		expect(html).toContain(
			`window.location.href = "${FALLBACK}?oauth=success`,
		);
	});

	it("falls back when the state carried no returnUrl", async () => {
		callback.mockResolvedValue({
			success: false,
			message: "denied",
			provider: "SLACK",
		});
		const html = await render();
		expect(html).toContain(
			`window.location.href = "${FALLBACK}?oauth=error`,
		);
	});
});
