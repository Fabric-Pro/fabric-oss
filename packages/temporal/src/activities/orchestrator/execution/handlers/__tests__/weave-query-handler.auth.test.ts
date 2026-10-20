import { afterEach, expect, it, vi } from "vitest";
import { WeaveQueryHandler } from "../weave-query-handler";
import { buildContext, buildInput } from "./integration-handler-fixtures";

const { sendMessageSecure } = vi.hoisted(() => ({
	sendMessageSecure: vi.fn(),
}));

vi.mock("@repo/agent-core", () => ({
	SecureA2AClient: class {
		sendMessageSecure = sendMessageSecure;
	},
}));
vi.mock("@repo/database", () => ({
	db: { project: { findUnique: vi.fn(async () => null) } },
}));

afterEach(() => {
	vi.unstubAllEnvs();
	vi.clearAllMocks();
});

it("opts the environment-configured Weave reader into service authentication", async () => {
	vi.stubEnv("WEAVE_READERS_URL", "https://readers.example.com");
	sendMessageSecure.mockResolvedValue({ text: '{"entities":[]}' });
	const input = buildInput("weave", { inputs: { query: "Example query" } });
	input.projectId = "example-project";
	input.step.app = "weave_query";

	const result = await new WeaveQueryHandler().execute(buildContext(input));

	expect(result.handled).toBe(true);
	expect(sendMessageSecure).toHaveBeenCalledExactlyOnceWith(
		"https://readers.example.com/thread",
		expect.objectContaining({ role: "user" }),
		{ userId: input.userId, organizationId: input.organizationId },
		expect.objectContaining({ trustedDestination: true }),
	);
});
