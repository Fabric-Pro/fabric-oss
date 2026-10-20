import { afterEach, expect, it, vi } from "vitest";
import { delegateToPatternPlanner } from "../delegate-to-weave-agent";

const { sendMessageSecure } = vi.hoisted(() => ({
	sendMessageSecure: vi.fn(),
}));

vi.mock("@repo/agent-core", () => ({
	SecureA2AClient: class {
		sendMessageSecure = sendMessageSecure;
	},
}));
vi.mock("@repo/database", () => ({ db: {}, hasProjectAccess: vi.fn() }));
vi.mock("@repo/ai-token", () => ({
	issueAIToken: vi.fn(async () => "example-ai-token"),
}));
vi.mock("@temporalio/activity", async (importOriginal) => ({
	...(await importOriginal<typeof import("@temporalio/activity")>()),
	Context: { current: () => ({ heartbeat: vi.fn() }) },
}));

afterEach(() => {
	vi.unstubAllEnvs();
	vi.clearAllMocks();
});

it("opts the environment-configured Pattern planner into service authentication", async () => {
	vi.stubEnv("WEAVE_PLANNERS_URL", "https://planners.example.com");
	sendMessageSecure.mockResolvedValue({
		planId: "example-plan",
		checkboxes: [],
	});

	const result = await delegateToPatternPlanner({
		message: "Plan an example feature",
		userId: "example-user",
		organizationId: "example-org",
		projectId: "example-project",
		projectName: "Example project",
	});

	expect(result.planId).toBe("example-plan");
	expect(sendMessageSecure).toHaveBeenCalledExactlyOnceWith(
		"https://planners.example.com",
		expect.objectContaining({ role: "user" }),
		{ userId: "example-user", organizationId: "example-org" },
		expect.objectContaining({ trustedDestination: true }),
	);
});
