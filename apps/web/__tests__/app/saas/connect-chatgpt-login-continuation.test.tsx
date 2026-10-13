/**
 * Fizzy #3036: `fabric connect chatgpt` opens `/connect/chatgpt?port&state`
 * (plus `shared=1&org=<slug>` for a shared account). A visitor without a
 * Fabric session was sent to a bare `/auth/login` by both the SaaS layout and
 * the page, so the CLI's port and state were gone after signing in and the CLI
 * timed out. Both must send the visitor back to the exact link, and only ever
 * to an internal path.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetSession, mockRedirect, mockHeaderValue } = vi.hoisted(() => ({
	mockGetSession: vi.fn(),
	mockRedirect: vi.fn(),
	mockHeaderValue: vi.fn<() => string | null>(),
}));

vi.mock("@saas/auth/lib/server", () => ({
	getSession: () => mockGetSession(),
	getOrganizationList: vi.fn(),
}));

vi.mock("next/navigation", () => ({
	redirect: (target: string) => {
		mockRedirect(target);
		throw new Error(`__REDIRECT__:${target}`);
	},
}));

vi.mock("next/headers", () => ({
	headers: async () => ({
		get: (name: string) =>
			name === "x-fabric-return-to" ? mockHeaderValue() : null,
	}),
}));

vi.mock("next-intl/server", () => ({
	getLocale: async () => "en",
	getMessages: async () => ({}),
	getTranslations: async () => (key: string) => key,
}));

vi.mock("next-intl", () => ({
	NextIntlClientProvider: () => null,
	useTranslations: () => (key: string) => key,
}));

// The layout's providers never render here: the redirect comes first.
vi.mock("@saas/auth/components/SessionProvider", () => ({
	SessionProvider: () => null,
}));
vi.mock("@saas/organizations/components/ActiveOrganizationProvider", () => ({
	ActiveOrganizationProvider: () => null,
}));
vi.mock("@saas/organizations/lib/api", () => ({
	organizationListQueryKey: ["organizations"],
}));
vi.mock("@saas/payments/lib/ai-usage-limit-query-error-listener", () => ({
	AiUsageLimitQueryErrorListener: () => null,
}));
vi.mock("@saas/shared/components/ConfirmationAlertProvider", () => ({
	ConfirmationAlertProvider: () => null,
}));
vi.mock("@saas/shared/components/copilot/CopilotFetchErrorInterceptor", () => ({
	CopilotFetchErrorInterceptor: () => null,
}));
vi.mock("@shared/lib/orpc-query-utils", () => ({ orpc: {} }));
vi.mock("@shared/lib/server", () => ({ getServerQueryClient: vi.fn() }));
vi.mock(
	"@saas/settings/components/chatgpt-plan/ConnectChatgptPlanForm",
	() => ({
		ConnectChatgptPlanForm: () => null,
		ConnectSharedChatgptPlanForm: () => null,
	}),
);
vi.mock("@saas/shared/components/AuthWrapper", () => ({
	AuthWrapper: () => null,
}));

vi.mock("@repo/database", () => ({
	findChatGptPlanPoolAdminOrganization: vi.fn(),
	getChatGptPlanOrgModelChoices: vi.fn(),
	listChatGptPlanOrganizations: vi.fn(),
}));

import ConnectChatgptPlanPage from "../../../app/(saas)/connect/chatgpt/page";
import SaaSLayout from "../../../app/(saas)/layout";
import { loginPathReturningTo } from "../../../modules/saas/auth/lib/login-redirect";

const PERSONAL = "/connect/chatgpt?port=54321&state=state-example";
const SHARED =
	"/connect/chatgpt?port=54321&state=state-example&shared=1&org=example-org";

function returnTo(target: string): string | null {
	const url = new URL(target, "https://app.example.com");
	expect(url.pathname).toBe("/auth/login");
	return url.searchParams.get("redirectTo");
}

async function redirectOf(render: () => Promise<unknown>): Promise<string> {
	await expect(render()).rejects.toThrow("__REDIRECT__");
	return String(mockRedirect.mock.calls.at(-1)?.[0]);
}

beforeEach(() => {
	vi.clearAllMocks();
	mockGetSession.mockResolvedValue(null);
	mockHeaderValue.mockReturnValue(null);
});

describe("signed-out visit to the ChatGPT connect link (Fizzy #3036)", () => {
	it.each([
		["a personal connection", PERSONAL],
		["a shared connection", SHARED],
	])(
		"the page sends %s back to the exact link after login",
		async (_label, link) => {
			const searchParams = Object.fromEntries(
				new URL(link, "https://app.example.com").searchParams,
			);
			const target = await redirectOf(() =>
				ConnectChatgptPlanPage({
					searchParams: Promise.resolve(searchParams),
				}),
			);
			expect(returnTo(target)).toBe(link);
		},
	);

	it.each([
		["a personal connection", PERSONAL],
		["a shared connection", SHARED],
	])(
		"the SaaS layout sends %s back to the exact link after login",
		async (_label, link) => {
			mockHeaderValue.mockReturnValue(link);
			const target = await redirectOf(() =>
				SaaSLayout({ children: null }),
			);
			expect(returnTo(target)).toBe(link);
		},
	);

	it.each([
		"//evil.example/connect/chatgpt",
		"/\\evil.example",
		"/\t/evil.example",
		"https://evil.example/connect/chatgpt",
	])(
		"the layout drops a return path that leaves the site: %j",
		async (value) => {
			mockHeaderValue.mockReturnValue(value);
			expect(await redirectOf(() => SaaSLayout({ children: null }))).toBe(
				"/auth/login",
			);
		},
	);

	it("the layout falls back to the bare login page without a return path", async () => {
		expect(await redirectOf(() => SaaSLayout({ children: null }))).toBe(
			"/auth/login",
		);
	});
});

describe("loginPathReturningTo", () => {
	it("encodes the return path as one parameter, query and all", () => {
		const target = loginPathReturningTo(SHARED);
		expect([
			...new URL(target, "https://a.example").searchParams.keys(),
		]).toEqual(["redirectTo"]);
		expect(returnTo(target)).toBe(SHARED);
	});
});
