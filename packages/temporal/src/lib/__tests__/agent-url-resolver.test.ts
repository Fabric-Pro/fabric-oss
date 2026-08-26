import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAgentUrl } from "../agent-url-resolver";

describe("resolveAgentUrl", () => {
	const ORIGINAL = { ...process.env };
	beforeEach(() => {
		process.env.DOCKER_CONTAINER = "false";
		delete process.env.DOCUMENT_GENERATOR_URL;
	});
	afterEach(() => {
		process.env = { ...ORIGINAL };
	});

	it("prefers the env-var override when set", () => {
		process.env.DOCUMENT_GENERATOR_URL = "https://doc-gen.prod.svc";
		expect(
			resolveAgentUrl("document_generator", "http://localhost:8124"),
		).toBe("https://doc-gen.prod.svc");
	});

	it("rewrites a known docker hostname to localhost when not in docker", () => {
		expect(
			resolveAgentUrl(
				"document_generator",
				"http://document-generator:8124",
			),
		).toBe("http://localhost:8124");
	});

	it("resolves backlog_updater via its env-var override", () => {
		process.env.BACKLOG_UPDATER_URL = "https://backlog-updater.prod.svc";
		expect(
			resolveAgentUrl("backlog_updater", "http://localhost:8135"),
		).toBe("https://backlog-updater.prod.svc");
	});

	it("returns the database URL unchanged for an unknown agent", () => {
		expect(
			resolveAgentUrl(
				"some-external-agent",
				"https://external.example.com",
			),
		).toBe("https://external.example.com");
	});
});
