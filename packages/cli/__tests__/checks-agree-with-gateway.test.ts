/**
 * The CLI and the MCP gateway carry their own copy of the doctor's shared
 * vocabulary and `fabric.environment.json` parser (Fizzy #2653):
 * `packages/cli/src/lib/instructions/checks.ts` and
 * `apps/web/modules/saas/mcp/lib/gateway/instruction-checks.ts`. The CLI is a
 * published npm package and cannot depend on a private workspace package, and
 * the web app does not depend on the SDK, so the two cannot share an import.
 *
 * Two copies drift. This pins them twice over: the source after each file's
 * header comment must be byte-identical, and one fixture corpus — valid,
 * every malformed shape, every limit — must parse and evaluate to deep-equal
 * results through both.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as gateway from "../../../apps/web/modules/saas/mcp/lib/gateway/instruction-checks.js";
import * as cli from "../src/lib/instructions/checks.js";

const CLI_FILE = path.resolve(__dirname, "../src/lib/instructions/checks.ts");
const GATEWAY_FILE = path.resolve(
	__dirname,
	"../../../apps/web/modules/saas/mcp/lib/gateway/instruction-checks.ts",
);

/** Everything after the leading `/** … *\/` block, which names its own twin. */
function bodyAfterHeader(source: string): string {
	const end = source.indexOf("*/");
	if (!source.startsWith("/**") || end === -1) {
		throw new Error("expected the file to open with a header comment");
	}
	return source.slice(end + 2);
}

function repeat<T>(count: number, make: (index: number) => T): T[] {
	return Array.from({ length: count }, (_, index) => make(index));
}

/** Every case the parser distinguishes, by name. */
const CORPUS: Record<string, string> = {
	"valid, full": JSON.stringify({
		version: 1,
		variables: [
			{
				name: "OPENAI_API_KEY",
				description: "Model access for the eval scripts",
				required: true,
			},
			{ name: "SENTRY_DSN", required: false },
			{ name: "lower_case_ok" },
		],
		tools: [
			{ name: "pnpm", version: ">=11", description: "Package manager" },
			{ name: "gh" },
			{ name: "clang++" },
		],
	}),
	"valid, empty lists": JSON.stringify({ version: 1 }),
	"valid, unknown top-level key ignored": JSON.stringify({
		version: 1,
		future: { anything: true },
		variables: [{ name: "A" }],
	}),
	"valid, control characters in a description are replaced": JSON.stringify({
		version: 1,
		variables: [{ name: "A", description: "line\u001b[31m\nnext end" }],
	}),
	"valid, at the variable limit": JSON.stringify({
		version: 1,
		variables: repeat(200, (index) => ({ name: `V_${index}` })),
	}),
	"valid, at the tool limit": JSON.stringify({
		version: 1,
		tools: repeat(100, (index) => ({ name: `tool-${index}` })),
	}),
	"valid, name at 128 characters": JSON.stringify({
		version: 1,
		variables: [{ name: `A${"B".repeat(127)}` }],
	}),
	"valid, description at 200 characters": JSON.stringify({
		version: 1,
		variables: [{ name: "A", description: "d".repeat(200) }],
	}),
	"not JSON": `{"version": 1, "variables": [`,
	"top level is an array": "[1, 2]",
	"top level is null": "null",
	"version missing": JSON.stringify({ variables: [] }),
	"version is a string": JSON.stringify({ version: "1" }),
	"version 2": JSON.stringify({ version: 2 }),
	"variables not an array": JSON.stringify({ version: 1, variables: {} }),
	"variable not an object": JSON.stringify({ version: 1, variables: ["A"] }),
	"variable name missing": JSON.stringify({ version: 1, variables: [{}] }),
	"variable name with a space": JSON.stringify({
		version: 1,
		variables: [{ name: "NOT OK" }],
	}),
	"variable name starting with a digit": JSON.stringify({
		version: 1,
		variables: [{ name: "1A" }],
	}),
	"variable name with an equals sign": JSON.stringify({
		version: 1,
		variables: [{ name: "A=secret" }],
	}),
	"variable name over 128 characters": JSON.stringify({
		version: 1,
		variables: [{ name: `A${"B".repeat(128)}` }],
	}),
	"duplicate variable": JSON.stringify({
		version: 1,
		variables: [{ name: "A" }, { name: "A" }],
	}),
	"required not a boolean": JSON.stringify({
		version: 1,
		variables: [{ name: "A", required: "yes" }],
	}),
	"description not a string": JSON.stringify({
		version: 1,
		variables: [{ name: "A", description: 7 }],
	}),
	"description over 200 characters": JSON.stringify({
		version: 1,
		variables: [{ name: "A", description: "d".repeat(201) }],
	}),
	"over the variable limit": JSON.stringify({
		version: 1,
		variables: repeat(201, (index) => ({ name: `V_${index}` })),
	}),
	"tools not an array": JSON.stringify({ version: 1, tools: "pnpm" }),
	"tool not an object": JSON.stringify({ version: 1, tools: ["pnpm"] }),
	"tool name with a path separator": JSON.stringify({
		version: 1,
		tools: [{ name: "bin/pnpm" }],
	}),
	"tool name with whitespace": JSON.stringify({
		version: 1,
		tools: [{ name: "rm -rf" }],
	}),
	"tool name with a leading dot": JSON.stringify({
		version: 1,
		tools: [{ name: ".hidden" }],
	}),
	"tool name over 64 characters": JSON.stringify({
		version: 1,
		tools: [{ name: `t${"x".repeat(64)}` }],
	}),
	"duplicate tool": JSON.stringify({
		version: 1,
		tools: [{ name: "gh" }, { name: "gh" }],
	}),
	"tool version not a string": JSON.stringify({
		version: 1,
		tools: [{ name: "gh", version: 2 }],
	}),
	"tool version over 64 characters": JSON.stringify({
		version: 1,
		tools: [{ name: "gh", version: "v".repeat(65) }],
	}),
	"over the tool limit": JSON.stringify({
		version: 1,
		tools: repeat(101, (index) => ({ name: `tool-${index}` })),
	}),
	"over the byte limit": JSON.stringify({
		version: 1,
		padding: "x".repeat(65_536),
	}),
};

/** Name sets to evaluate each valid declaration against. */
const PRESENT: ReadonlyArray<{ names: string[]; ignoreCase?: boolean }> = [
	{ names: [] },
	{ names: ["OPENAI_API_KEY", "A", "V_0", "V_199"] },
	{ names: ["openai_api_key", "sentry_dsn", "a"], ignoreCase: true },
	{ names: ["openai_api_key", "sentry_dsn", "a"] },
];

describe("checks.ts and its gateway twin", () => {
	it("are byte-identical after their header comments", async () => {
		const [cliSource, gatewaySource] = await Promise.all([
			readFile(CLI_FILE, "utf8"),
			readFile(GATEWAY_FILE, "utf8"),
		]);

		expect(bodyAfterHeader(gatewaySource)).toBe(bodyAfterHeader(cliSource));
	});

	it("export the same names and the same constants", () => {
		expect(Object.keys(gateway).sort()).toEqual(Object.keys(cli).sort());
		expect(gateway.CHECK_IDS).toEqual(cli.CHECK_IDS);
		expect(gateway.CHECK_TITLES).toEqual(cli.CHECK_TITLES);
		expect(gateway.INSTRUCTION_ENVIRONMENT_FILE).toBe(
			cli.INSTRUCTION_ENVIRONMENT_FILE,
		);
		expect(gateway.INSTRUCTION_ENVIRONMENT_MAX_BYTES).toBe(
			cli.INSTRUCTION_ENVIRONMENT_MAX_BYTES,
		);
		expect(gateway.ENVIRONMENT_VARIABLE_NAME.source).toBe(
			cli.ENVIRONMENT_VARIABLE_NAME.source,
		);
		expect(gateway.TOOL_NAME.source).toBe(cli.TOOL_NAME.source);
	});

	describe.each(Object.entries(CORPUS))("%s", (_label, text) => {
		it("parses identically", () => {
			expect(gateway.parseInstructionEnvironment(text)).toEqual(
				cli.parseInstructionEnvironment(text),
			);
		});

		it("evaluates identically", () => {
			const parsed = cli.parseInstructionEnvironment(text);
			if (!parsed.ok) {
				return;
			}
			for (const present of PRESENT) {
				const options = { ignoreCase: present.ignoreCase };
				expect(
					gateway.evaluateDeclaredVariables(
						parsed.declaration,
						present.names,
						options,
					),
				).toEqual(
					cli.evaluateDeclaredVariables(
						parsed.declaration,
						present.names,
						options,
					),
				);
			}
		});
	});

	it("covers both outcomes, so an always-failing parser cannot pass as agreement", () => {
		const outcomes = Object.values(CORPUS).map(
			(text) => cli.parseInstructionEnvironment(text).ok,
		);
		expect(outcomes.filter(Boolean).length).toBe(8);
		expect(outcomes.filter((ok) => !ok).length).toBe(
			Object.keys(CORPUS).length - 8,
		);
	});

	it("never quotes the offending value in a failure reason", () => {
		for (const text of Object.values(CORPUS)) {
			const parsed = cli.parseInstructionEnvironment(text);
			if (!parsed.ok) {
				expect(parsed.reason).not.toContain("secret");
				expect(parsed.reason).not.toContain("NOT OK");
				expect(parsed.reason).not.toContain("rm -rf");
			}
		}
	});

	it("build the same report from the same checks", () => {
		const checks = [
			{
				id: "tools" as const,
				title: cli.CHECK_TITLES.tools,
				status: "fail" as const,
				evidence: "machine" as const,
				detail: "x",
			},
			{
				id: "auth" as const,
				title: cli.CHECK_TITLES.auth,
				status: "pass" as const,
				evidence: "server" as const,
				detail: "y",
			},
		];
		expect(gateway.buildChecksReport("project-1", "mcp", checks)).toEqual(
			cli.buildChecksReport("project-1", "mcp", checks),
		);
		expect(
			cli
				.buildChecksReport("project-1", "mcp", checks)
				.checks.map((check) => check.id),
		).toEqual(["auth", "tools"]);
	});
});
