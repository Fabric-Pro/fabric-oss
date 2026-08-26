import { describe, expect, it } from "vitest";
import { isProbeableAgent } from "../agent-probeable";

describe("isProbeableAgent", () => {
	it("excludes in-process FABRIC_NATIVE agents", () => {
		expect(
			isProbeableAgent({
				framework: "FABRIC_NATIVE",
				deploymentUrl: "http://localhost:3001/app/agents/fabric-ai",
			}),
		).toBe(false);
	});

	it("excludes inline agents with an empty deployment URL", () => {
		expect(
			isProbeableAgent({ framework: "AI_SDK", deploymentUrl: "" }),
		).toBe(false);
	});

	it("excludes agents with a whitespace-only deployment URL", () => {
		expect(
			isProbeableAgent({ framework: "AI_SDK", deploymentUrl: "   " }),
		).toBe(false);
	});

	it("excludes agents with a null deployment URL", () => {
		expect(
			isProbeableAgent({ framework: "LANGGRAPH", deploymentUrl: null }),
		).toBe(false);
	});

	it("includes external agents with a real deployment URL", () => {
		expect(
			isProbeableAgent({
				framework: "LANGGRAPH",
				deploymentUrl: "http://localhost:8124",
			}),
		).toBe(true);
	});
});
