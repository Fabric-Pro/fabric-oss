/**
 * Unit tests for Reflection Module
 */
import { describe, expect, it } from "vitest";
import type { DimensionEvaluation, ReflectionConfig } from "../src/reflection";
import {
	calculateOverallScore,
	DEFAULT_REFLECTION_CONFIG,
	getCorrectionPrompt,
	getReflectionSystemPrompt,
	getReflectionUserPrompt,
	parseReflectionResponse,
} from "../src/reflection";

describe("Reflection Module", () => {
	describe("DEFAULT_REFLECTION_CONFIG", () => {
		it("should have sensible defaults", () => {
			expect(DEFAULT_REFLECTION_CONFIG.passThreshold).toBe(70);
			expect(DEFAULT_REFLECTION_CONFIG.maxIterations).toBe(3);
			expect(DEFAULT_REFLECTION_CONFIG.temperature).toBe(0.1);
			expect(DEFAULT_REFLECTION_CONFIG.dimensions).toContain("accuracy");
			expect(DEFAULT_REFLECTION_CONFIG.dimensions).toContain(
				"completeness",
			);
		});
	});

	describe("calculateOverallScore", () => {
		it("should calculate average of dimension scores", () => {
			const evaluations: DimensionEvaluation[] = [
				{
					dimension: "accuracy",
					score: 80,
					feedback: "",
					suggestions: [],
				},
				{
					dimension: "completeness",
					score: 90,
					feedback: "",
					suggestions: [],
				},
				{
					dimension: "relevance",
					score: 70,
					feedback: "",
					suggestions: [],
				},
			];

			const score = calculateOverallScore(evaluations);
			expect(score).toBe(80); // (80 + 90 + 70) / 3 = 80
		});

		it("should return 0 for empty evaluations", () => {
			expect(calculateOverallScore([])).toBe(0);
		});

		it("should round to nearest integer", () => {
			const evaluations: DimensionEvaluation[] = [
				{
					dimension: "accuracy",
					score: 85,
					feedback: "",
					suggestions: [],
				},
				{
					dimension: "completeness",
					score: 86,
					feedback: "",
					suggestions: [],
				},
			];

			const score = calculateOverallScore(evaluations);
			expect(score).toBe(86); // (85 + 86) / 2 = 85.5 -> 86
		});
	});

	describe("parseReflectionResponse", () => {
		it("should parse valid JSON response", () => {
			const response = JSON.stringify({
				evaluations: [
					{
						dimension: "accuracy",
						score: 85,
						feedback: "Good",
						suggestions: ["Add more detail"],
					},
				],
				overallScore: 85,
				issues: ["Minor issue"],
				improvements: ["Add examples"],
				passed: true,
			});

			const result = parseReflectionResponse(
				response,
				DEFAULT_REFLECTION_CONFIG,
			);

			expect(result.passed).toBe(true);
			expect(result.overallScore).toBe(85);
			expect(result.evaluations).toHaveLength(1);
			expect(result.issues).toContain("Minor issue");
		});

		it("should extract JSON from mixed content", () => {
			const response = `Here is my evaluation:
			
{
  "evaluations": [{"dimension": "accuracy", "score": 75, "feedback": "OK", "suggestions": []}],
  "overallScore": 75,
  "issues": [],
  "improvements": [],
  "passed": true
}

That's my assessment.`;

			const result = parseReflectionResponse(
				response,
				DEFAULT_REFLECTION_CONFIG,
			);
			expect(result.overallScore).toBe(75);
		});

		it("should handle missing JSON gracefully", () => {
			const response = "This is not JSON at all";
			const result = parseReflectionResponse(
				response,
				DEFAULT_REFLECTION_CONFIG,
			);

			expect(result.passed).toBe(false);
			expect(result.overallScore).toBe(0);
			expect(result.issues).toHaveLength(1);
		});

		it("should determine passed based on threshold", () => {
			const config = { ...DEFAULT_REFLECTION_CONFIG, passThreshold: 80 };
			const response = JSON.stringify({
				evaluations: [
					{
						dimension: "accuracy",
						score: 75,
						feedback: "",
						suggestions: [],
					},
				],
				overallScore: 75,
				issues: [],
				improvements: [],
			});

			const result = parseReflectionResponse(response, config);
			expect(result.passed).toBe(false);
		});
	});

	describe("getReflectionSystemPrompt", () => {
		it("should include all configured dimensions", () => {
			const config: ReflectionConfig = {
				dimensions: ["accuracy", "safety", "format"],
			};

			const prompt = getReflectionSystemPrompt(config);

			expect(prompt).toContain("Accuracy");
			expect(prompt).toContain("Safety");
			expect(prompt).toContain("Format");
			expect(prompt).not.toContain("Completeness");
		});

		it("should include custom criteria when provided", () => {
			const config: ReflectionConfig = {
				customCriteria: "Must include code examples",
			};

			const prompt = getReflectionSystemPrompt(config);
			expect(prompt).toContain("Must include code examples");
		});
	});

	describe("getReflectionUserPrompt", () => {
		it("should include output and input", () => {
			const prompt = getReflectionUserPrompt(
				"Generated output here",
				"Original input here",
			);

			expect(prompt).toContain("Generated output here");
			expect(prompt).toContain("Original input here");
		});

		it("should include optional context and format", () => {
			const prompt = getReflectionUserPrompt(
				"Output",
				"Input",
				"Additional context",
				"Expected JSON format",
			);

			expect(prompt).toContain("Additional context");
			expect(prompt).toContain("Expected JSON format");
		});
	});

	describe("getCorrectionPrompt", () => {
		it("should include issues and improvements", () => {
			const prompt = getCorrectionPrompt(
				"Current output",
				"Original input",
				["Issue 1", "Issue 2"],
				["Improvement 1"],
			);

			expect(prompt).toContain("Issue 1");
			expect(prompt).toContain("Issue 2");
			expect(prompt).toContain("Improvement 1");
		});
	});
});
