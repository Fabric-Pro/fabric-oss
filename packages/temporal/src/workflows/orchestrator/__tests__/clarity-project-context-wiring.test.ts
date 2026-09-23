/**
 * The clarity gate knows the attached project (Fizzy #2040, F41).
 *
 * The up-front and per-step clarity checks were called without the attached
 * project, so "… for this project" drew "which project?" although one was
 * attached. Initialization now summarises the project and both calls pass it —
 * behind `orchestrator-clarity-project-context-v1`, with the unpatched call
 * keeping the exact input it always sent (no `projectContext` key at all).
 *
 * The wiring half is read as source, as `mcp-tool-ceiling-wiring.test.ts` does:
 * importing a workflow module pulls in the Temporal sandbox machinery.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	attachedProjectReferenceLine,
	buildClarityProjectContext,
} from "../phases/attached-project-context";

const read = (file: string) =>
	readFileSync(
		join(process.cwd(), "src/workflows/orchestrator", file),
		"utf-8",
	);

const workflow = read("index.ts");
const initialization = read("phases/initialization.ts");

describe("clarity project context — summary", () => {
	it("names the project and keeps a bounded description", () => {
		const summary = buildClarityProjectContext({
			name: "Example Portal",
			description: `  ${"x".repeat(900)}  `,
		});
		const [first, second] = summary.split("\n");
		expect(first).toBe("Attached project: Example Portal");
		expect(second).toBe(`Description: ${"x".repeat(500)}`);
	});

	it("omits an empty description", () => {
		expect(
			buildClarityProjectContext({
				name: "Example Portal",
				description: " ",
			}),
		).toBe("Attached project: Example Portal");
		expect(
			buildClarityProjectContext({
				name: "Example Portal",
				description: null,
			}),
		).toBe("Attached project: Example Portal");
	});

	it("tells the agent loop 'this project' is the attached one", () => {
		const line = attachedProjectReferenceLine("Example Portal");
		expect(line).toContain('"Example Portal"');
		expect(line).toMatch(/without asking which project/);
	});
});

describe("clarity project context — workflow wiring", () => {
	const gated =
		/const (clarityProjectContext|stepProjectContext) = patched\(\s*"orchestrator-clarity-project-context-v1",?\s*\)\s*\?\s*attachedProjectContext\s*:\s*undefined;/g;

	it("gates both clarity calls on the marker", () => {
		expect(workflow.match(gated)).toHaveLength(2);
	});

	it("adds projectContext only when patched (unpatched input has no such key)", () => {
		expect(workflow).toMatch(
			/\.\.\.\(clarityProjectContext\s*\?\s*\{ projectContext: clarityProjectContext \}\s*:\s*\{\}\)/,
		);
		expect(workflow).toMatch(
			/\.\.\.\(stepProjectContext\s*\?\s*\{ projectContext: stepProjectContext \}\s*:\s*\{\}\)/,
		);
		// A bare `projectContext:` property would change the recorded input.
		expect(workflow).not.toMatch(
			/^\s*projectContext: attachedProjectContext/m,
		);
	});

	it("takes the summary from initialization", () => {
		expect(workflow).toMatch(
			/attachedProjectContext = initResult\.data\?\.clarityProjectContext;/,
		);
		expect(initialization).toMatch(
			/clarityProjectContext =\s*buildClarityProjectContext\(projectMetadata\);/,
		);
	});

	it("gates the <project_context> reference line on the same marker", () => {
		expect(initialization).toMatch(
			/patched\("orchestrator-clarity-project-context-v1"\)\s*\?\s*attachedProjectReferenceLine\(projectMetadata\.name\)\s*:\s*null,/,
		);
	});
});
