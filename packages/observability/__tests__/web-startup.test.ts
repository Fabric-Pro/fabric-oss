import { describe, expect, it } from "vitest";
import "../lib/web-startup";
import { getRegistration } from "../lib/integration-registry";
import { listPlatformComponents } from "../lib/platform-components";

describe("web startup", () => {
	it("registers providers and platform components without the package barrel", () => {
		expect(getRegistration("openai")?.key).toBe("openai");
		expect(
			listPlatformComponents().some(({ key }) => key === "core-api"),
		).toBe(true);
	});
});
