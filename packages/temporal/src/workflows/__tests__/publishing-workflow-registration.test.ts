import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as workflows from "../index";

/**
 * Registration guard for every Publishing Suite generation workflow,
 * discovery-based rather than a hand-maintained sibling list.
 *
 * Replaces `publishing-case-study-registration.test.ts` and
 * `publishing-stakeholder-email-registration.test.ts`, whose "pin every
 * sibling by name" lists had already drifted: neither one named
 * `generatePublishingLinkedInPostWorkflow`, live in the barrel since Phase
 * 2A. A hand list added per-type only grows the blind spot with every new
 * content type; a discovery guard covers the next one for free.
 *
 * The worker registers workflows by bundling this barrel, so a workflow
 * missing from `workflows/index.ts` is not registered under any name — and
 * the failure is close to invisible. `workflow.start` still succeeds (the
 * server accepts a type it has never seen and queues a task), so the calling
 * procedure returns cleanly; the row sits GENERATING; the failure marker
 * never runs because it lives INSIDE the workflow that was never scheduled;
 * and the reclaim is a lazy deadline sweep. The first signal anyone gets is a
 * user clicking the button again ten minutes later.
 */

const WORKFLOWS_DIR = join(__dirname, "..");
const CASE_STUDY_TEST_FILE = join(
	__dirname,
	"generate-publishing-case-study.test.ts",
);
const AI_NON_RETRYABLE_TEST_FILE = join(
	__dirname,
	"ai-non-retryable-errors.test.ts",
);

function parse(file: string): ts.SourceFile {
	return ts.createSourceFile(
		file,
		readFileSync(file, "utf8"),
		ts.ScriptTarget.Latest,
		true,
	);
}

/**
 * Every `generate-publishing-*.ts` file directly under `workflows/`, by
 * filename. Filename, and not the workflow's own export name, is the
 * discovery key: it is the form BOTH hand-written registries below already
 * use (`WORKFLOWS` holds the filename verbatim; `AI_WORKFLOWS[].name` holds
 * the filename minus `.ts`), so discovering by filename needs no lossy
 * transform to compare against either one.
 */
function discoverPublishingWorkflowFiles(): string[] {
	return readdirSync(WORKFLOWS_DIR, { withFileTypes: true })
		.filter(
			(entry) =>
				entry.isFile() &&
				/^generate-publishing-.*\.ts$/.test(entry.name),
		)
		.map((entry) => entry.name)
		.sort();
}

/**
 * The name of the exported `*Workflow` function a workflow file defines.
 *
 * Read off the AST rather than transformed from the filename: kebab-to-camel
 * is lossy for this exact family — `generate-publishing-linkedin-post.ts`
 * exports `generatePublishingLinkedInPostWorkflow` (capital "I" in
 * "LinkedIn"), which no mechanical kebab-case rule produces without a
 * special case for that one name.
 */
function exportedWorkflowFunctionName(file: string): string {
	const source = parse(file);
	for (const statement of source.statements) {
		if (
			ts.isFunctionDeclaration(statement) &&
			statement.name &&
			/Workflow$/.test(statement.name.text) &&
			ts.canHaveModifiers(statement) &&
			ts
				.getModifiers(statement)
				?.some(
					(modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
				)
		) {
			return statement.name.text;
		}
	}
	throw new Error(`${file}: no exported top-level *Workflow function found`);
}

/**
 * String-literal elements of every `const <name> = [...]` array in the file,
 * read off the AST WITHOUT importing it. Walks the whole tree (`ts.forEachChild`
 * from the source root), so a match at any scope depth is found — this file's
 * only target, `WORKFLOWS` in `generate-publishing-case-study.test.ts`, sits one
 * level inside a `describe` callback, not at module scope. If a second array
 * with the same name existed at another depth, its elements would be collected
 * too — there is exactly one `WORKFLOWS` today, so that case does not arise.
 *
 * Both sibling registries live in `.test.ts` files that call `vi.mock` and
 * `describe`/`it` at module scope, so importing either one from here would
 * re-run its whole suite as a side effect of loading this one. Reading the
 * literal off the parsed source avoids that entirely — and both arrays are
 * plain data (string or object literals), so nothing here needs evaluation.
 */
function stringArrayConst(file: string, constName: string): string[] {
	const source = parse(file);
	const found: string[] = [];
	const visit = (node: ts.Node): void => {
		if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.name.text === constName &&
			node.initializer &&
			ts.isArrayLiteralExpression(node.initializer)
		) {
			for (const element of node.initializer.elements) {
				if (ts.isStringLiteral(element)) {
					found.push(element.text);
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return found;
}

/**
 * The `name` property of each object-literal element of a `const <name> =
 * [...]` array anywhere in the file, at any scope depth — same walk as
 * `stringArrayConst` above. Its only target, `AI_WORKFLOWS` in
 * `ai-non-retryable-errors.test.ts`, happens to sit at module scope, but
 * nothing here requires that.
 */
function objectArrayNameField(file: string, constName: string): string[] {
	const source = parse(file);
	const found: string[] = [];
	const visit = (node: ts.Node): void => {
		if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.name.text === constName &&
			node.initializer &&
			ts.isArrayLiteralExpression(node.initializer)
		) {
			for (const element of node.initializer.elements) {
				if (!ts.isObjectLiteralExpression(element)) {
					continue;
				}
				for (const property of element.properties) {
					if (
						ts.isPropertyAssignment(property) &&
						ts.isIdentifier(property.name) &&
						property.name.text === "name" &&
						ts.isStringLiteral(property.initializer)
					) {
						found.push(property.initializer.text);
					}
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return found;
}

describe("discovery preconditions — the guard cannot pass vacuously (workflow registration)", () => {
	// Each of these checks a discovery step in ISOLATION from the assertion it
	// feeds, so a walker that silently returns [] fails here instead of making
	// every "for each discovered X" loop below pass over nothing.
	it("finds the publishing workflow files it is supposed to find", () => {
		// Named by files that predate this task, deliberately — this precondition
		// must stay green whether or not the webinar-script slice has landed yet,
		// so a failure here always means the WALKER broke, never that a content
		// type is still in progress.
		const files = discoverPublishingWorkflowFiles();
		expect(files).toContain("generate-publishing-case-study.ts");
		expect(files).toContain("generate-publishing-linkedin-post.ts");
		expect(files.length).toBeGreaterThanOrEqual(6);
	});

	it("reads a plausible AI_WORKFLOWS off ai-non-retryable-errors.test.ts", () => {
		// That file's own array also covers non-publishing workflows, so this
		// floor is well above the 7 publishing entries alone — a regression in
		// the reader that only found the publishing subset would still be
		// caught here.
		const names = objectArrayNameField(
			AI_NON_RETRYABLE_TEST_FILE,
			"AI_WORKFLOWS",
		);
		expect(names).toContain("generate-publishing-case-study");
		expect(names.length).toBeGreaterThan(10);
	});

	it("reads a plausible WORKFLOWS off generate-publishing-case-study.test.ts", () => {
		const files = stringArrayConst(CASE_STUDY_TEST_FILE, "WORKFLOWS");
		expect(files).toContain("generate-publishing-case-study.ts");
		expect(files.length).toBeGreaterThanOrEqual(6);
	});
});

describe("publishing workflow registration", () => {
	it("every publishing workflow is a runtime export of the barrel", () => {
		// A missed workflows-barrel export is worse than a missed activities
		// one: workflow.start succeeds, the row sits GENERATING, and the
		// failure marker never runs because it lives INSIDE the workflow that
		// was never scheduled, so the 10-minute execution timeout does not
		// save it.
		const files = discoverPublishingWorkflowFiles();
		expect(files.length).toBeGreaterThanOrEqual(6);

		for (const file of files) {
			const exportName = exportedWorkflowFunctionName(
				join(WORKFLOWS_DIR, file),
			);
			expect(
				typeof (workflows as Record<string, unknown>)[exportName],
			).toBe("function");
		}
	});

	it("every publishing workflow is checked by both hand-written registries", () => {
		// Both registries independently gate a real consequence — a proxy
		// missing `AI_NON_RETRYABLE_ERROR_TYPES` retries a dead configuration
		// error for minutes, and a workflow missing from the case-study test's
		// list can silently stop routing failures through the authored
		// mapping — so a new content type must land in both, not just the
		// barrel.
		const files = discoverPublishingWorkflowFiles();
		expect(files).toContain("generate-publishing-webinar-script.ts");
		expect(files).toContain("generate-publishing-linkedin-post.ts");
		expect(files.length).toBeGreaterThanOrEqual(7);

		const aiWorkflowNames = objectArrayNameField(
			AI_NON_RETRYABLE_TEST_FILE,
			"AI_WORKFLOWS",
		);
		const failureDetailWorkflows = stringArrayConst(
			CASE_STUDY_TEST_FILE,
			"WORKFLOWS",
		);

		for (const file of files) {
			const kebabName = file.replace(/\.ts$/, "");
			expect(aiWorkflowNames).toContain(kebabName);
			expect(failureDetailWorkflows).toContain(file);
		}
	});
});
