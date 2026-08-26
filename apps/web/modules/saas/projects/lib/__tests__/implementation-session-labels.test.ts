import { describe, expect, it } from "vitest";
import { getImplementationRecommendation } from "../implementation-session-labels";

describe("implementation-session recommendation helper", () => {
	it("defaults to background agents even when repository context exists", () => {
		const recommendation = getImplementationRecommendation({
			hasRepositoryContext: true,
			openTaskCount: 3,
			focusedTaskId: "task_1",
			implementationDefaultChannel: "WORKSPACE_AGENTS",
			implementationDefaultProvider: "VIBE_WORKSPACE",
		});

		expect(recommendation.channel).toBe("BACKGROUND_AGENTS");
		expect(recommendation.provider).toBe("BACKGROUND_AGENTS");
		expect(recommendation.reason).toContain(
			"recommended remote path for direct implementation",
		);
	});

	it("falls back to background agents when repo context is missing", () => {
		const recommendation = getImplementationRecommendation({
			hasRepositoryContext: false,
			openTaskCount: 2,
		});

		expect(recommendation.channel).toBe("BACKGROUND_AGENTS");
		expect(recommendation.provider).toBe("BACKGROUND_AGENTS");
		expect(recommendation.reason).toContain(
			"Direct implementation needs a connected repository",
		);
	});
});
