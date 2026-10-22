import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import {
	isStrictJsonSchemaCompatible,
	toStrictJsonSchema,
} from "@repo/ai/lib/strict-json-schema-middleware";
import { PublishingNewsletterBlurbSchema } from "@repo/utils/publishing-newsletter-blurb-body";
import { PublishingWebinarScriptSchema } from "@repo/utils/publishing-webinar-script-body";
import { WORKING_DRAFT_BODY_MAX } from "@repo/utils/publishing-working-draft-limits";
import { asSchema, type FlexibleSchema } from "ai";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	backlogChangeItemSchema,
	ChangeProposalSchema,
} from "../src/activities/backlog-context/analyze-context";
import { AgendaSchema } from "../src/activities/meeting-agenda/build-agenda-prompt";
import { PublishingBlogPostSchema } from "../src/activities/publishing-blog-post/build-blog-post-prompt";
import { PublishingCaseStudySchema } from "../src/activities/publishing-case-study/build-case-study-prompt";
import { PublishingLinkedInPostSchema } from "../src/activities/publishing-linkedin-post/build-linkedin-post-prompt";
import { PublishingPlanningAnalysisSchema } from "../src/activities/publishing-planning/build-planning-analysis-prompt";
import { refinementSchemaFor } from "../src/activities/publishing-refine/build-refine-prompt";
import { PublishingShortPostSchema } from "../src/activities/publishing-short-post/build-short-post-prompt";
import { PublishingStakeholderEmailSchema } from "../src/activities/publishing-stakeholder-email/build-stakeholder-email-prompt";
import {
	ActDecisionSchema,
	AssessDecisionSchema,
} from "../src/activities/qa-agentic-run/operation-decision";

vi.mock("@qdrant/js-client-rest", () => ({ QdrantClient: class {} }));

/** Evaluate private schema initializers verbatim, without loading their activity/procedure side effects. */
function privateSchema(
	file: string,
	name: string,
	bindings: Record<string, unknown> = {},
): z.ZodType {
	const source = ts.createSourceFile(
		file,
		readFileSync(new URL(file, import.meta.url), "utf8"),
		ts.ScriptTarget.Latest,
		true,
	);
	for (const statement of source.statements) {
		if (!ts.isVariableStatement(statement)) {
			continue;
		}
		for (const declaration of statement.declarationList.declarations) {
			if (
				declaration.name.getText(source) !== name ||
				!declaration.initializer
			) {
				continue;
			}
			const code = ts.transpileModule(
				`const result = ${declaration.initializer.getText(source)}; result;`,
				{ compilerOptions: { target: ts.ScriptTarget.ES2022 } },
			).outputText;
			return runInNewContext(
				code,
				{ z, ...bindings },
				{ timeout: 1000 },
			) as z.ZodType;
		}
	}
	throw new Error(`Schema declaration not found: ${name}`);
}

const metricsFile = "../src/activities/document-eval/mastra-llm-metrics.ts";
const flexibleStringArray = privateSchema(metricsFile, "flexibleStringArray");

// One entry per concrete schema used by the 16 call sites, including dynamic
// refinement and QA branches. Entries use production exports or their source
// initializers, so value-constraint changes remain part of this regression.
const schemas: [string, FlexibleSchema<unknown>][] = [
	[
		"context-summarization/SummarySchema",
		privateSchema(
			"../../ai/lib/context-summarization/summarize-project-context.ts",
			"SummarySchema",
		),
	],
	[
		"maturation/AiReadinessLlmSchema",
		privateSchema(
			"../../api/modules/projects/procedures/stories/maturation/evaluate-ai-readiness.ts",
			"AiReadinessLlmSchema",
		),
	],
	["backlog-context/ChangeProposalSchema (AI Update)", ChangeProposalSchema],
	["backlog-context/backlogChangeItemSchema", backlogChangeItemSchema],
	[
		"decision-precheck/DecisionJudgeOutputSchema",
		privateSchema(
			"../src/lib/decision-precheck/judge.ts",
			"DecisionJudgeOutputSchema",
		),
	],
	...["qualitySchema", "coherenceSchema", "alignmentSchema"].map(
		(name): [string, FlexibleSchema<unknown>] => [
			`document-eval/${name}`,
			privateSchema(metricsFile, name, { flexibleStringArray }),
		],
	),
	["meeting-agenda/AgendaSchema", AgendaSchema],
	["publishing-blog-post/PublishingBlogPostSchema", PublishingBlogPostSchema],
	[
		"publishing-case-study/PublishingCaseStudySchema",
		PublishingCaseStudySchema,
	],
	[
		"publishing-linkedin-post/PublishingLinkedInPostSchema",
		PublishingLinkedInPostSchema,
	],
	[
		"publishing-newsletter-blurb/PublishingNewsletterBlurbSchema",
		PublishingNewsletterBlurbSchema,
	],
	[
		"publishing-planning/PublishingPlanningAnalysisSchema",
		PublishingPlanningAnalysisSchema,
	],
	[
		"publishing-short-post/PublishingShortPostSchema",
		PublishingShortPostSchema,
	],
	[
		"publishing-stakeholder-email/PublishingStakeholderEmailSchema",
		PublishingStakeholderEmailSchema,
	],
	[
		"publishing-webinar-script/PublishingWebinarScriptSchema",
		PublishingWebinarScriptSchema,
	],
	...Object.keys(WORKING_DRAFT_BODY_MAX).map(
		(kind): [string, FlexibleSchema<unknown>] => [
			`publishing-refine/refinementSchemaFor(${kind})`,
			refinementSchemaFor(kind as keyof typeof WORKING_DRAFT_BODY_MAX),
		],
	),
	["qa-agentic-run/ActDecisionSchema", ActDecisionSchema],
	["qa-agentic-run/AssessDecisionSchema", AssessDecisionSchema],
];

describe("real call-site schema structural enforcement", () => {
	it.each(schemas)("%s conversion decision", async (name, schema) => {
		const original = await asSchema(schema).jsonSchema;
		const converted = toStrictJsonSchema(original);
		if (schema === PublishingPlanningAnalysisSchema) {
			expect(original).toHaveProperty(
				"properties.recommendedQuestions.items.properties.recommendedAnswers.items",
				{},
			);
			expect(converted).toBeUndefined();
			console.info(
				`STRUCTURED_OUTPUT_COVERAGE ${name}: fallback - recommendedAnswers.items is unconstrained z.unknown()`,
			);
		} else {
			expect(converted).toBeDefined();
			expect(isStrictJsonSchemaCompatible(converted)).toBe(true);
			console.info(`STRUCTURED_OUTPUT_COVERAGE ${name}: strict`);
		}
	});
});
