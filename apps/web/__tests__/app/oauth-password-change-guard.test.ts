import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSession, redirect } = vi.hoisted(() => ({
	getSession: vi.fn(),
	redirect: vi.fn(),
}));

vi.mock("@saas/auth/lib/server", () => ({
	getSession: () => getSession(),
}));

vi.mock("next/navigation", () => ({
	redirect: (target: string) => {
		redirect(target);
		throw new Error(`REDIRECT:${target}`);
	},
}));

vi.mock("@saas/oauth/components/OAuthConsent", () => ({
	OAuthConsent: () => null,
}));

vi.mock("@saas/oauth/components/OAuthOrganizationPicker", () => ({
	OAuthOrganizationPicker: () => null,
}));

vi.mock("next-intl/server", () => ({
	getTranslations: vi.fn(),
}));

async function renderConsentPage() {
	const { default: Page } = await import("../../app/auth/oauth/consent/page");
	return await Page();
}

async function renderOrganizationPage() {
	const { default: Page } = await import(
		"../../app/auth/oauth/organization/page"
	);
	return await Page();
}

async function requestResume() {
	const { GET } = await import("../../app/auth/oauth/resume/route");
	return await GET({
		nextUrl: new URL("https://example.com/auth/oauth/resume"),
	} as NextRequest);
}

describe("OAuth password-change guard", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		getSession.mockResolvedValue({
			user: { id: "user-1", mustChangePassword: true },
		});
	});

	it.each([
		["consent", renderConsentPage],
		["organization selection", renderOrganizationPage],
	])("redirects before rendering the %s page", async (_name, renderPage) => {
		await expect(renderPage()).rejects.toThrow("REDIRECT:/change-password");
		expect(redirect).toHaveBeenCalledWith("/change-password");
	});

	it("redirects the resume route before continuing authorization", async () => {
		const response = await requestResume();

		expect(response.headers.get("location")).toBe(
			"https://example.com/change-password",
		);
	});

	it("leaves OAuth pages reachable after password rotation", async () => {
		getSession.mockResolvedValue({
			user: { id: "user-1", mustChangePassword: false },
		});

		await expect(renderConsentPage()).resolves.toBeTruthy();
		expect(redirect).not.toHaveBeenCalled();
	});
});
