import { describe, expect, it } from "vitest";
import {
	type GitLabIntegrationSettings,
	readUseOfficialMcp,
} from "../../src/gitlab/integration-settings";

describe("readUseOfficialMcp", () => {
	it("returns true when settings.useOfficialMcp === true", () => {
		const s: GitLabIntegrationSettings = {
			useOfficialMcp: true,
			mcpProbe: null,
		} as GitLabIntegrationSettings;
		expect(readUseOfficialMcp(s)).toBe(true);
	});

	it("returns false when settings.useOfficialMcp === false", () => {
		const s = {
			useOfficialMcp: false,
			mcpProbe: null,
		} as GitLabIntegrationSettings;
		expect(readUseOfficialMcp(s)).toBe(false);
	});

	it("returns 'legacy' when useOfficialMcp is undefined (grandfathered)", () => {
		expect(readUseOfficialMcp({})).toBe("legacy");
		expect(readUseOfficialMcp(null)).toBe("legacy");
		expect(readUseOfficialMcp(undefined)).toBe("legacy");
	});
});
