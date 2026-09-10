import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ApplicationFailure } from "@temporalio/common";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { draftGenerationFolders } from "../../activities/publishing-shared/__tests__/_ast-guards";
import {
	AUTHORED_FAILURE_CLASSES,
	publishingFailureDetail,
} from "../publishing-failure-message";

/**
 * What a failed publishing run is allowed to SAY, and to whom.
 *
 * The stored message reaches everyone who can see the tab; the detail reaches an
 * operator. The interesting property is the fail-closed one: a failure type this
 * table does not know must not get its own words, because the words might not be
 * ours.
 */

describe("publishingFailureDetail", () => {
	it("gives an authorization refusal its own words", () => {
		const detail = publishingFailureDetail(
			ApplicationFailure.nonRetryable(
				"The account that started this draft is no longer authorized to generate on this project",
				"PUBLISHING_ACTOR_INVALID",
			),
		);

		expect(detail.message).toBe(
			"The account that started this draft is no longer authorized to generate on this project",
		);
		expect(detail.errorClass).toBe("PUBLISHING_ACTOR_INVALID");
	});

	it("replaces a validation report rather than rendering it", () => {
		// The activity appends the validator's output, which quotes what the
		// model produced. Useful to an operator, not something to paste onto a
		// shared row.
		const detail = publishingFailureDetail(
			ApplicationFailure.nonRetryable(
				'Case study failed schema validation: [{"path":["body"],"received":"..."}]',
				"PUBLISHING_CASE_STUDY_SCHEMA_VALIDATION_FAILED",
			),
		);

		expect(detail.message).toBe(
			"The model returned a draft that did not match the expected shape. Generating again usually clears it.",
		);
		expect(detail.message).not.toContain("received");
		expect(detail.detail).toContain("received");
	});

	it("gives an unknown failure the neutral message, and keeps its text for the log", () => {
		// Fail-closed, and the direction that matters: a failure class nobody
		// thought about must not start rendering third-party text by being
		// forgotten.
		const detail = publishingFailureDetail(
			new Error("connect ECONNREFUSED 10.0.0.5:5432"),
		);

		expect(detail.message).toBe(
			"Generation failed. The reason is recorded in the run log for this project.",
		);
		expect(detail.message).not.toContain("ECONNREFUSED");
		expect(detail.detail).toContain("ECONNREFUSED");
		expect(detail.errorClass).toBe("Error");
	});

	it("gives a non-Error throw the neutral message too", () => {
		expect(publishingFailureDetail("a string").message).toBe(
			"Generation failed. The reason is recorded in the run log for this project.",
		);
		expect(publishingFailureDetail(null).message).toBe(
			"Generation failed. The reason is recorded in the run log for this project.",
		);
	});

	it("agrees, byte for byte, with the strings the activity actually raises", () => {
		// The two authorization messages are written in two files that run in two
		// different sandboxes: the activity raises them, this table re-states
		// them. Nothing at runtime would notice them drifting — the mapping would
		// simply stop matching and every refusal would quietly fall through to
		// the neutral message, which is the failure mode that looks like nothing
		// happening.
		const activitySource = readFileSync(
			join(
				__dirname,
				"..",
				"..",
				"activities",
				"publishing-shared",
				"assert-generation-actor.ts",
			),
			"utf8",
		);

		for (const [type, message] of [
			[
				"PUBLISHING_TENANT_MISMATCH",
				"This project moved to a different organization after the draft was started",
			],
			[
				"PUBLISHING_ACTOR_INVALID",
				"The account that started this draft is no longer authorized to generate on this project",
			],
		] as const) {
			expect(
				publishingFailureDetail(
					ApplicationFailure.nonRetryable(message, type),
				).message,
			).toBe(message);
			expect(activitySource).toContain(message);
		}
	});
});

/**
 * Spec §11.3's discovery guard: every schema-validation failure class a
 * publishing draft-generation activity actually throws must have an authored
 * entry, so a forgotten one cannot fall through to the neutral message in
 * silence.
 *
 * An earlier draft of the plan named this requirement in the spec but gave it
 * no task, so `AUTHORED_MESSAGE` grew by hand at each content type's own task
 * and this guard did not exist yet to enforce it.
 */
const ACTIVITIES_DIR = join(__dirname, "..", "..", "activities");

/**
 * Every `generate-*.ts` file inside a draft-generation activity folder — the
 * folder rule itself (`draftGenerationFolders()`, shared with
 * `draft-refusal.test.ts` in `_ast-guards.ts`) is what excludes
 * `publishing-shared` and `publishing-suggestion` without naming either one.
 *
 * That exclusion is correct, not an omission: neither one calls
 * `publishingFailureDetail`. `daily-brief-generation-workflow.ts` persists its
 * caught error's raw `.message` directly, with no authored table to check a
 * class against, and `publishing-suggestion-generation-workflow.ts` does the
 * same for `PUBLISHING_SCHEMA_VALIDATION_FAILED`. Neither is "out of scope
 * because it has its own table" — neither has one.
 */
function draftGenerationGenerateFiles(): string[] {
	return draftGenerationFolders().flatMap((folder) => {
		const dir = join(ACTIVITIES_DIR, folder);
		return readdirSync(dir)
			.filter((f) => /^generate-.*\.ts$/.test(f))
			.map((f) => join(dir, f));
	});
}

/**
 * Every `_SCHEMA_VALIDATION_FAILED` class a file throws via
 * `ApplicationFailure.nonRetryable(message, "CLASS")` — read off the AST so a
 * class name that only appears in a comment or a string built for something
 * else is never mistaken for one actually thrown.
 */
function schemaValidationClassesThrownIn(file: string): string[] {
	const source = ts.createSourceFile(
		file,
		readFileSync(file, "utf8"),
		ts.ScriptTarget.Latest,
		true,
	);
	const found: string[] = [];
	const visit = (node: ts.Node): void => {
		if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			ts.isIdentifier(node.expression.expression) &&
			node.expression.expression.text === "ApplicationFailure" &&
			node.expression.name.text === "nonRetryable"
		) {
			const [, classArg] = node.arguments;
			if (
				classArg &&
				ts.isStringLiteral(classArg) &&
				/_SCHEMA_VALIDATION_FAILED$/.test(classArg.text)
			) {
				found.push(classArg.text);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return found;
}

function discoverSchemaValidationClasses(): string[] {
	return [
		...new Set(
			draftGenerationGenerateFiles().flatMap(
				schemaValidationClassesThrownIn,
			),
		),
	].sort();
}

describe("discovery preconditions — the guard cannot pass vacuously (schema-validation messages)", () => {
	it("finds the draft-generation activity files it is supposed to find", () => {
		const files = draftGenerationGenerateFiles();
		expect(files.some((f) => f.endsWith("generate-case-study.ts"))).toBe(
			true,
		);
		expect(files.some((f) => f.endsWith("generate-linkedin-post.ts"))).toBe(
			true,
		);
		expect(files.length).toBeGreaterThanOrEqual(7);
	});
});

describe("every schema-validation class thrown in the tree has an authored message", () => {
	it("every schema-validation class thrown in the tree has an authored message", () => {
		const thrown = discoverSchemaValidationClasses();
		expect(thrown).toContain(
			"PUBLISHING_WEBINAR_SCRIPT_SCHEMA_VALIDATION_FAILED",
		);
		expect(thrown.length).toBeGreaterThanOrEqual(7);

		for (const cls of thrown) {
			expect(AUTHORED_FAILURE_CLASSES.has(cls)).toBe(true);
		}
	});
});
