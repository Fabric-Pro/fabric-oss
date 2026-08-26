import { describe, expect, it } from "vitest";
import {
	buildCiConfigTemplate,
	CI_CONFIG_PROVIDERS,
} from "../ci-config-templates";

/**
 * These templates only earn their place if they produce config Fabric can
 * actually ingest — each provider has one rule that silently yields nothing when
 * missed, and those rules are what these tests pin.
 */
describe("buildCiConfigTemplate", () => {
	it("names the GitHub artifact so the fetcher's heuristic finds it", () => {
		// github-actions-fetcher matches /junit|test|report|result/i on the
		// artifact NAME. An artifact called "coverage" is invisible whatever it
		// contains, so this is the difference between working and silent.
		const t = buildCiConfigTemplate({ provider: "GITHUB" });
		// The ARTIFACT name, not the workflow name — take the one inside the
		// upload-artifact step's `with:` block.
		const artifactName =
			/upload-artifact[\s\S]*?name: (.+)/.exec(t.content)?.[1] ?? "";
		expect(artifactName).toMatch(/junit|test|report|result/i);
		expect(t.path).toBe(".github/workflows/fabric-qa.yml");
	});

	it("uploads GitHub results even when the suite fails", () => {
		// A red run is precisely the one worth ingesting.
		const t = buildCiConfigTemplate({ provider: "GITHUB" });
		expect(t.content).toContain("if: always()");
		expect(t.content).toContain("continue-on-error: true");
	});

	it("declares GitLab JUnit under reports, not paths", () => {
		// `artifacts:paths` stores the file and produces NO test report — the
		// single most common GitLab misconfiguration for this.
		const t = buildCiConfigTemplate({ provider: "GITLAB" });
		expect(t.content).toContain("reports:");
		expect(t.content).toContain("junit:");
		expect(t.content).toContain("when: always");
		expect(t.content).not.toContain("paths:");
	});

	it("publishes ADO results through PublishTestResults", () => {
		// Writing the XML without this task creates no Test Run to pull.
		const t = buildCiConfigTemplate({ provider: "AZURE_DEVOPS" });
		expect(t.content).toContain("PublishTestResults@2");
		expect(t.content).toContain("testResultsFormat: 'JUnit'");
		expect(t.content).toContain("condition: always()");
	});

	it("warns about the scope each provider actually needs", () => {
		expect(
			buildCiConfigTemplate({ provider: "GITHUB" }).notes.join(" "),
		).toContain("Actions: read");
		expect(
			buildCiConfigTemplate({ provider: "AZURE_DEVOPS" }).notes.join(" "),
		).toContain("Test Management: Read");
	});

	it("honours the branch, command and JUnit path when given", () => {
		const t = buildCiConfigTemplate({
			provider: "GITHUB",
			branch: "qa-demo",
			testCommand: "pnpm test:ci",
			junitPath: "out/results.xml",
		});
		expect(t.content).toContain("'qa-demo'");
		expect(t.content).toContain("'pnpm test:ci'");
		expect(t.content).toContain("'out/results.xml'");
	});

	it("keeps a hostile branch name as data, not YAML structure", () => {
		const t = buildCiConfigTemplate({
			provider: "GITLAB",
			branch: "release/'; rm -rf /",
		});
		// Single quotes are doubled, so the value cannot terminate its scalar.
		expect(t.content).toContain("'release/''; rm -rf /'");
	});

	it("produces a non-empty template with notes for every provider", () => {
		for (const provider of CI_CONFIG_PROVIDERS) {
			const t = buildCiConfigTemplate({ provider });
			expect(t.path.length).toBeGreaterThan(0);
			expect(t.content).toContain("junit");
			expect(t.notes.length).toBeGreaterThan(0);
		}
	});
});
