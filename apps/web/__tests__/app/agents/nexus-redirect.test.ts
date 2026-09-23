/**
 * The retired org Nexus route (Fizzy #2040, FR8). With UNIFIED_AGENT_INTERFACE
 * on it redirects to the unified chat; a saved agent link (`?agent=`) must
 * arrive as that agent's chat rather than a contextless page, and `?c=` —
 * an `AiChat` id on Nexus, meaningless on the unified page — is dropped.
 *
 * The page is a React Server Component, invoked directly with mocked
 * server imports, as in the new-project page guard tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetActiveOrganization, mockRedirect, mockIsFeatureEnabled } =
	vi.hoisted(() => ({
		mockGetActiveOrganization: vi.fn(),
		mockRedirect: vi.fn(),
		mockIsFeatureEnabled: vi.fn(),
	}));

vi.mock("@saas/auth/lib/server", () => ({
	getSession: vi.fn(async () => ({ user: { id: "user-1" } })),
	getActiveOrganization: (slug: string) => mockGetActiveOrganization(slug),
}));

vi.mock("next/navigation", () => ({
	redirect: (target: string) => {
		mockRedirect(target);
		throw new Error(`__REDIRECT__:${target}`);
	},
}));

vi.mock("@repo/database", () => ({
	isFeatureEnabled: (...args: unknown[]) => mockIsFeatureEnabled(...args),
}));

vi.mock(
	"@repo/api/modules/users/procedures/chat-agent-selection/server-fetch",
	() => ({ fetchChatAgentSelectionForUser: vi.fn(async () => null) }),
);

vi.mock("@saas/ai/components/CopilotPage", () => ({
	CopilotPage: () => null,
}));

const ORG_SLUG = "example-org";

beforeEach(() => {
	vi.clearAllMocks();
	mockGetActiveOrganization.mockResolvedValue({ id: "org-A" });
	mockIsFeatureEnabled.mockResolvedValue(true);
});

afterEach(() => {
	vi.resetModules();
});

async function callPage(searchParams: Record<string, string>) {
	const mod = await import(
		"../../../app/(saas)/app/(organizations)/[organizationSlug]/nexus/page"
	);
	return (
		mod.default as (args: {
			params: Promise<{ organizationSlug: string }>;
			searchParams: Promise<Record<string, string>>;
		}) => Promise<unknown>
	)({
		params: Promise.resolve({ organizationSlug: ORG_SLUG }),
		searchParams: Promise.resolve(searchParams),
	});
}

function agentParam(agentId: string) {
	return JSON.stringify({ agentId, name: "Release notes", description: "" });
}

describe("org Nexus redirect (#2040)", () => {
	it("opens a saved agent link as that agent's chat", async () => {
		await expect(
			callPage({ agent: agentParam("template-instance:inst_1") }),
		).rejects.toThrow("__REDIRECT__");

		expect(mockRedirect).toHaveBeenCalledWith(
			"/app/example-org/agents/fabric-ai?mode=agent&instanceId=inst_1",
		);
	});

	it("drops a Nexus conversation id, which names a different table", async () => {
		await expect(
			callPage({
				agent: agentParam("template-instance:inst_1"),
				c: "aichat_1",
			}),
		).rejects.toThrow("__REDIRECT__");

		expect(mockRedirect).toHaveBeenCalledWith(
			"/app/example-org/agents/fabric-ai?mode=agent&instanceId=inst_1",
		);
	});

	it("lands on the plain chat for anything that is not an agent instance", async () => {
		await expect(
			callPage({ agent: agentParam("model:gpt") }),
		).rejects.toThrow("__REDIRECT__");
		await expect(callPage({ agent: "{not json" })).rejects.toThrow(
			"__REDIRECT__",
		);

		expect(mockRedirect).toHaveBeenNthCalledWith(
			1,
			"/app/example-org/agents/fabric-ai",
		);
		expect(mockRedirect).toHaveBeenNthCalledWith(
			2,
			"/app/example-org/agents/fabric-ai",
		);
	});

	it("keeps serving Nexus when the flag is off (rollback lever)", async () => {
		mockIsFeatureEnabled.mockResolvedValue(false);

		await expect(
			callPage({ agent: agentParam("template-instance:inst_1") }),
		).resolves.toBeTruthy();
		expect(mockRedirect).not.toHaveBeenCalled();
	});
});
