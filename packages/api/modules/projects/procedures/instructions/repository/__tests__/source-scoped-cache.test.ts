import { describe, expect, it } from "vitest";
import { TtlCache } from "../../../../../../lib/ttl-cache";
import { SourceScopedCache } from "../direct-cache";
import type { DirectRepositorySource } from "../direct-source";

function source(
	overrides: {
		organizationId?: string;
		integrationId?: string;
		owner?: string;
		repo?: string;
		azureOrganization?: string | null;
		ref?: string;
	} = {},
): DirectRepositorySource {
	return {
		organizationId: overrides.organizationId ?? "org-1",
		integrationId: overrides.integrationId ?? "integration-1",
		generation: 1,
		ref: overrides.ref ?? "main",
		rootPath: "",
		ignoreGlobs: null,
		refreshFault: null,
		repository: {
			provider: "GITHUB",
			repositoryUrl: "https://github.com/example-org/instructions",
			owner: overrides.owner ?? "example-org",
			repo: overrides.repo ?? "instructions",
			azureOrganization: overrides.azureOrganization ?? null,
			token: "token-for-source-scoped-cache-test",
		},
	};
}

const cache = () =>
	new SourceScopedCache<string>(
		new TtlCache({ ttlMs: 60_000, maxEntries: 50 }),
	);

describe("SourceScopedCache", () => {
	it("shares an answer between callers of the same repository", () => {
		const c = cache();
		c.set(source(), ["sha", 1, "AGENTS.md"], "answer");
		expect(c.get(source(), ["sha", 1, "AGENTS.md"])).toBe("answer");
	});

	it.each([
		["organization", { organizationId: "org-2" }],
		["integration", { integrationId: "integration-2" }],
		["owner", { owner: "other-org" }],
		["repository", { repo: "other" }],
		["Azure organization", { azureOrganization: "other" }],
	])("never answers another %s", (_name, other) => {
		const c = cache();
		c.set(source(), ["sha"], "answer");
		expect(c.get(source(other), ["sha"])).toBeUndefined();
	});

	it("keeps answers for different parts apart, in order", () => {
		const c = cache();
		c.set(source(), ["a", "b"], "ab");
		expect(c.get(source(), ["b", "a"])).toBeUndefined();
		expect(c.get(source(), ["a"])).toBeUndefined();
		expect(c.get(source(), ["a", "b"])).toBe("ab");
	});

	it("clears every answer", () => {
		const c = cache();
		c.set(source(), ["sha"], "answer");
		c.clear();
		expect(c.get(source(), ["sha"])).toBeUndefined();
	});
});
