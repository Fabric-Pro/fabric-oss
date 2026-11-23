/**
 * A research step's model is resolved in the run's scope, its project
 * included, so the project's usage limits apply to the call and count it.
 */
import { describe, expect, it, vi } from "vitest";

const getAiModel = vi.hoisted(() => vi.fn(async () => ({ id: "model" })));

vi.mock("../../orchestrator/utils/model-selector", () => ({ getAiModel }));

import { researchModel } from "../research-model";

describe("researchModel", () => {
	it("resolves the model without tools, with the run's project", async () => {
		await researchModel({
			userId: "user-1",
			organizationId: "org-1",
			projectId: "project-1",
		});

		expect(getAiModel).toHaveBeenCalledWith(
			"user-1",
			"org-1",
			false,
			undefined,
			undefined,
			{ projectId: "project-1" },
		);
	});
});
