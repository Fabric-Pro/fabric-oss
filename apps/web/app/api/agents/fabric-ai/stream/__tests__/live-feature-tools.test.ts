import { describe, expect, it } from "vitest";
import {
	bindsLiveFeatureTools,
	projectContextGroundingLine,
} from "../live-feature-tools";

describe("bindsLiveFeatureTools", () => {
	it("binds on the default bundle (no explicit list)", () => {
		expect(bindsLiveFeatureTools(undefined)).toBe(true);
		expect(bindsLiveFeatureTools(null)).toBe(true);
	});

	// The full-page chat sends its Fabric tool toggles, which never name the
	// project tools; the reads still ride along (Fizzy #2309).
	it("binds on a non-empty explicit list that does not name them", () => {
		expect(bindsLiveFeatureTools(["fabric_web_search"])).toBe(true);
	});

	it("does not bind when every Fabric tool is explicitly disabled", () => {
		expect(bindsLiveFeatureTools([])).toBe(false);
	});
});

describe("projectContextGroundingLine", () => {
	it("points the model at the live reads when they are bound", () => {
		const line = projectContextGroundingLine(true);
		expect(line).toContain("fabric_list_project_features");
		expect(line).toContain("fabric_get_project_feature");
		expect(line).toContain("snapshot");
	});

	// Fizzy #2578: a documents question went to semantic search, which
	// returned a guessed, mixed list.
	it("points the model at the live document and source listings", () => {
		const line = projectContextGroundingLine(true);
		expect(line).toContain("fabric_list_project_documents");
		expect(line).toContain("fabric_list_project_sources");
	});

	it("never advertises tools the turn does not have", () => {
		const line = projectContextGroundingLine(false);
		expect(line).not.toContain("fabric_list_project_features");
		expect(line).not.toContain("fabric_list_project_documents");
		expect(line).toContain("say what else you need");
	});
});
