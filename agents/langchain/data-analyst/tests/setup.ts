import { afterEach, vi } from "vitest";

// Keep tests deterministic and avoid accidental reliance on the real environment.
// Use vi.stubEnv for type-safe environment variable stubbing
vi.stubEnv("NODE_ENV", "test");
vi.stubEnv(
	"FABRIC_API_URL",
	process.env.FABRIC_API_URL ?? "http://localhost:3001",
);
vi.stubEnv("AGENT_API_KEY", process.env.AGENT_API_KEY ?? "test-agent-api-key");

afterEach(() => {
	vi.clearAllMocks();
	vi.unstubAllEnvs();
});
