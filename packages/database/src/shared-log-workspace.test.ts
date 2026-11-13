import { afterEach, describe, expect, it, vi } from "vitest";
import {
	namesSharedLogWorkspace,
	sharedLogWorkspaceId,
} from "./shared-log-workspace";

const SHARED = "7c2e9a41-5b3d-4f6e-8a1c-2d9b0e4f7a63";

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("namesSharedLogWorkspace", () => {
	it("matches the deployment's workspace whatever the case or padding", () => {
		vi.stubEnv("FABRIC_BUG_ANALYSIS_LOG_WORKSPACE_ID", ` ${SHARED} `);

		expect(sharedLogWorkspaceId()).toBe(SHARED);
		expect(namesSharedLogWorkspace(SHARED.toUpperCase())).toBe(true);
		expect(namesSharedLogWorkspace(` ${SHARED}`)).toBe(true);
		expect(
			namesSharedLogWorkspace("0b6f3c1e-2d4a-4e8b-9c7d-5a1f2e3d4c5b"),
		).toBe(false);
	});

	it("matches nothing when the deployment names no shared workspace", () => {
		vi.stubEnv("FABRIC_BUG_ANALYSIS_LOG_WORKSPACE_ID", "  ");

		expect(sharedLogWorkspaceId()).toBeUndefined();
		expect(namesSharedLogWorkspace(SHARED)).toBe(false);
	});
});
