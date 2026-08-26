/**
 * CI configuration Fabric can hand a team so its pipeline reports back (card
 * 1688, "Configure a CI/CD pipeline to run tests and send reports back").
 *
 * Fabric READS results; it cannot read what a pipeline never publishes. The
 * ingestion side is provider-specific in ways teams routinely get wrong:
 *
 *  - **GitHub Actions** has no per-test API. Results only reach Fabric if the
 *    run uploads a JUnit XML artifact, and the fetcher finds it by NAME —
 *    `/junit|test|report|result/i` (`github-actions-fetcher.ts`). An artifact
 *    called `coverage` is invisible no matter what it contains.
 *  - **GitLab CI** parses JUnit server-side, but ONLY when declared under
 *    `artifacts:reports:junit`. Listing the same file under `artifacts:paths`
 *    stores it and populates no test report.
 *  - **Azure DevOps** surfaces results through Test Runs, which requires a
 *    `PublishTestResults` task; a script that merely writes the XML produces no
 *    Test Run for Fabric to pull.
 *
 * These templates encode those three rules. They are returned as text for a
 * human to commit — Fabric does not write into a customer's repository, and
 * this module deliberately has no git access.
 */

export const CI_CONFIG_PROVIDERS = [
	"GITHUB",
	"GITLAB",
	"AZURE_DEVOPS",
] as const;
type CiConfigProvider = (typeof CI_CONFIG_PROVIDERS)[number];

export interface CiConfigTemplate {
	/** Where the file belongs in the repository. */
	path: string;
	/** The file's contents. */
	content: string;
	/** What the team still has to do themselves. */
	notes: string[];
}

export interface CiConfigInput {
	provider: CiConfigProvider;
	/** Branch the QA sync watches; defaults to the repo's default branch. */
	branch?: string | null;
	/** The command that runs the suite and writes JUnit XML. */
	testCommand?: string | null;
	/** Where the suite writes its JUnit XML, relative to the repo root. */
	junitPath?: string | null;
}

const DEFAULT_TEST_COMMAND = "npm test -- --reporter=junit";
const DEFAULT_JUNIT_PATH = "reports/junit.xml";

/** Keep a branch/command safe to interpolate into YAML as a bare scalar. */
function yamlScalar(value: string): string {
	// Single-quote and escape embedded quotes: a branch called `release/'; rm`
	// must stay data, never structure.
	return `'${value.replace(/'/g, "''")}'`;
}

export function buildCiConfigTemplate(input: CiConfigInput): CiConfigTemplate {
	const branch = input.branch?.trim() || "main";
	const testCommand = input.testCommand?.trim() || DEFAULT_TEST_COMMAND;
	const junitPath = input.junitPath?.trim() || DEFAULT_JUNIT_PATH;

	switch (input.provider) {
		case "GITHUB":
			return {
				path: ".github/workflows/fabric-qa.yml",
				content: [
					"# Publishes JUnit results for Fabric's QA tab to ingest.",
					"# The artifact NAME matters: Fabric matches /junit|test|report|result/i.",
					"name: Fabric QA",
					"",
					"on:",
					"  push:",
					"    branches: [" + yamlScalar(branch) + "]",
					"  workflow_dispatch:",
					"",
					"jobs:",
					"  test:",
					"    runs-on: ubuntu-latest",
					"    steps:",
					"      - uses: actions/checkout@v4",
					"      - uses: actions/setup-node@v4",
					"        with:",
					"          node-version: '22'",
					"      - run: npm ci",
					"      - run: " + yamlScalar(testCommand),
					"        # Publish results even when the suite fails — a red run is",
					"        # exactly the one Fabric needs to ingest.",
					"        continue-on-error: true",
					"      - uses: actions/upload-artifact@v4",
					"        if: always()",
					"        with:",
					"          name: junit-test-results",
					"          path: " + yamlScalar(junitPath),
					"",
				].join("\n"),
				notes: [
					"Connect this repository under Project Settings ▸ Development, then open the QA tab and press Sync now.",
					"The token Fabric uses needs the Actions: read scope — a Contents-only token lists no workflow runs.",
					"Rename the artifact only to something still matching junit|test|report|result, or Fabric will not find it.",
				],
			};

		case "GITLAB":
			return {
				path: ".gitlab-ci.yml",
				content: [
					"# Publishes JUnit results for Fabric's QA tab to ingest.",
					"# `artifacts:reports:junit` is required — `artifacts:paths` alone",
					"# stores the file and produces no test report to read.",
					"fabric-qa:",
					"  stage: test",
					"  script:",
					"    - " + yamlScalar(testCommand),
					"  rules:",
					"    - if: $CI_COMMIT_BRANCH == " + yamlScalar(branch),
					"    - when: manual",
					"  artifacts:",
					"    when: always",
					"    reports:",
					"      junit: " + yamlScalar(junitPath),
					"",
				].join("\n"),
				notes: [
					"Connect this repository under Project Settings ▸ Development, then open the QA tab and press Sync now.",
					"`when: always` matters — without it a failing job uploads nothing and the failure never reaches Fabric.",
				],
			};

		case "AZURE_DEVOPS":
			return {
				path: "azure-pipelines.yml",
				content: [
					"# Publishes JUnit results for Fabric's QA tab to ingest.",
					"# PublishTestResults is what creates the ADO Test Run that Fabric",
					"# pulls; writing the XML without this task produces nothing to read.",
					"trigger:",
					"  branches:",
					"    include:",
					"      - " + yamlScalar(branch),
					"",
					"pool:",
					"  vmImage: ubuntu-latest",
					"",
					"steps:",
					"  - task: NodeTool@0",
					"    inputs:",
					"      versionSpec: '22.x'",
					"  - script: npm ci",
					"    displayName: Install",
					"  - script: " + yamlScalar(testCommand),
					"    displayName: Test",
					"    continueOnError: true",
					"  - task: PublishTestResults@2",
					"    condition: always()",
					"    inputs:",
					"      testResultsFormat: 'JUnit'",
					"      testResultsFiles: " + yamlScalar(junitPath),
					"",
				].join("\n"),
				notes: [
					"Connect this repository under Project Settings ▸ Development with a PAT, then open the QA tab and press Sync now.",
					"The PAT needs Test Management: Read — a Code: Read token cannot list Test Runs, which is the most common reason an ADO sync returns nothing.",
				],
			};

		default: {
			// Exhaustiveness: a new provider must not silently fall through to a
			// template that publishes nothing.
			const unreachable: never = input.provider;
			throw new Error(`Unsupported CI provider: ${String(unreachable)}`);
		}
	}
}
