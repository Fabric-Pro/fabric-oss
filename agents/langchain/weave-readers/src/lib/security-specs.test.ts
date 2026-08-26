import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	findRelevantSpecs,
	formatSpecCitation,
	formatSpecCitations,
	RFC_CITATIONS,
	type SecuritySpec,
} from "./security-specs.js";

describe("security-specs", () => {
	describe("RFC_CITATIONS", () => {
		it("should contain at least 12 specs", () => {
			assert.ok(RFC_CITATIONS.length >= 12);
		});

		it("should have valid structure for each spec", () => {
			for (const spec of RFC_CITATIONS) {
				assert.ok(spec.id, "spec should have id");
				assert.ok(spec.name, "spec should have name");
				assert.ok(
					spec.url.startsWith("https://"),
					"spec url should start with https://",
				);
				assert.ok(
					Array.isArray(spec.keywords),
					"keywords should be array",
				);
				assert.ok(
					spec.keywords.length > 0,
					"keywords should not be empty",
				);
				assert.ok(spec.description, "spec should have description");
			}
		});

		it("should have unique IDs", () => {
			const ids = RFC_CITATIONS.map((s) => s.id);
			const uniqueIds = new Set(ids);
			assert.equal(uniqueIds.size, ids.length, "IDs should be unique");
		});

		it("should contain OAuth 2.0 spec", () => {
			const oauth = RFC_CITATIONS.find((s) => s.id === "RFC6749");
			assert.ok(oauth, "OAuth spec should exist");
			assert.ok(
				oauth.keywords.includes("oauth"),
				"should have oauth keyword",
			);
		});

		it("should contain PKCE spec", () => {
			const pkce = RFC_CITATIONS.find((s) => s.id === "RFC7636");
			assert.ok(pkce, "PKCE spec should exist");
			assert.ok(
				pkce.keywords.includes("pkce"),
				"should have pkce keyword",
			);
		});

		it("should contain JWT spec", () => {
			const jwt = RFC_CITATIONS.find((s) => s.id === "RFC7519");
			assert.ok(jwt, "JWT spec should exist");
			assert.ok(jwt.keywords.includes("jwt"), "should have jwt keyword");
		});

		it("should contain CORS spec", () => {
			const cors = RFC_CITATIONS.find((s) => s.id === "CORS");
			assert.ok(cors, "CORS spec should exist");
			assert.ok(
				cors.keywords.includes("cors"),
				"should have cors keyword",
			);
		});

		it("should contain CSP spec", () => {
			const csp = RFC_CITATIONS.find((s) => s.id === "CSP-L3");
			assert.ok(csp, "CSP spec should exist");
			assert.ok(csp.keywords.includes("csp"), "should have csp keyword");
		});
	});

	describe("findRelevantSpecs", () => {
		it("should return empty array for empty input", () => {
			const result = findRelevantSpecs("");
			assert.deepEqual(result, []);
		});

		it("should find OAuth when oauth keyword is in code", () => {
			const code =
				"function getOAuthToken() { return oauth.authorize(); }";
			const result = findRelevantSpecs(code);
			const oauthSpec = result.find((s) => s.id === "RFC6749");
			assert.ok(oauthSpec, "should find OAuth spec");
		});

		it("should find JWT when jwt keyword is in code", () => {
			const code = "const token = jwt.sign({ userId: 123 });";
			const result = findRelevantSpecs(code);
			const jwtSpec = result.find((s) => s.id === "RFC7519");
			assert.ok(jwtSpec, "should find JWT spec");
		});

		it("should find multiple relevant specs", () => {
			const code = `
				const oauthToken = await getOAuthToken();
				const jwtToken = jwt.sign({ sub: user.id });
				verifyCORS(request);
			`;
			const result = findRelevantSpecs(code);
			assert.ok(result.length >= 2, "should find multiple specs");
		});

		it("should find specs for code with special characters", () => {
			const code = `const token = "Bearer eyJhbGciOiJIUzI1NiJ9...";`;
			const result = findRelevantSpecs(code);
			assert.ok(Array.isArray(result), "should return array");
		});
	});

	describe("formatSpecCitation", () => {
		it("should format a spec correctly", () => {
			const spec: SecuritySpec = {
				id: "TEST001",
				name: "Test Spec",
				url: "https://example.com/spec",
				keywords: ["test", "example"],
				description: "A test specification",
			};
			const result = formatSpecCitation(spec);
			assert.ok(result.includes("**Test Spec**"));
			assert.ok(result.includes("A test specification"));
			assert.ok(result.includes("https://example.com/spec"));
			assert.ok(result.includes("test, example"));
		});
	});

	describe("formatSpecCitations", () => {
		it("should return empty string for empty array", () => {
			const result = formatSpecCitations([]);
			assert.equal(result, "");
		});

		it("should format multiple specs with separator", () => {
			const specs: SecuritySpec[] = [
				{
					id: "TEST001",
					name: "Test Spec 1",
					url: "https://example.com/1",
					keywords: ["test1"],
					description: "First test spec",
				},
				{
					id: "TEST002",
					name: "Test Spec 2",
					url: "https://example.com/2",
					keywords: ["test2"],
					description: "Second test spec",
				},
			];
			const result = formatSpecCitations(specs);
			assert.ok(result.includes("Test Spec 1"));
			assert.ok(result.includes("Test Spec 2"));
			assert.ok(result.includes("---\n\n"));
		});
	});
});
