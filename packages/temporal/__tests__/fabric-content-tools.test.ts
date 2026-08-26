import { describe, expect, it } from "vitest";
import {
	buildFabricFramePrompt,
	buildFallbackFrameContent,
	validateFabricCreateFileInput,
	validateFabricCreateFrameInput,
} from "../src/activities/shared/fabric-content-tools";

describe("fabric-content-tools", () => {
	describe("validateFabricCreateFileInput", () => {
		it("accepts the canonical file inputs", () => {
			const result = validateFabricCreateFileInput({
				name: "report.md",
				content: "hello",
				fileType: "DOCUMENT",
			});

			expect(result).toEqual({
				ok: true,
				value: {
					name: "report.md",
					content: "hello",
					fileType: "DOCUMENT",
				},
			});
		});

		it("accepts common alias fields and falls back to DOCUMENT", () => {
			const result = validateFabricCreateFileInput({
				fileName: "notes.txt",
				body: "draft",
				fileType: "NOT_A_REAL_TYPE",
			});

			expect(result).toEqual({
				ok: true,
				value: {
					name: "notes.txt",
					content: "draft",
					fileType: "DOCUMENT",
				},
			});
		});

		it("uses fallback content when content is omitted", () => {
			const result = validateFabricCreateFileInput(
				{ name: "summary.md" },
				{ fallbackContent: "from previous step" },
			);

			expect(result).toEqual({
				ok: true,
				value: {
					name: "summary.md",
					content: "from previous step",
					fileType: "DOCUMENT",
				},
			});
		});

		it("returns a structured error when name is missing", () => {
			expect(validateFabricCreateFileInput({ content: "hello" })).toEqual(
				{
					ok: false,
					error: "File name is required. Provide `name` (for example, 'report.md').",
				},
			);
		});
	});

	describe("validateFabricCreateFrameInput", () => {
		it("accepts canonical frame inputs", () => {
			const result = validateFabricCreateFrameInput({
				title: "Dashboard",
				description: "Simple admin dashboard",
				format: "json",
				components: [{ type: "card", label: "Revenue" }],
			});

			expect(result).toEqual({
				ok: true,
				value: {
					title: "Dashboard",
					description: "Simple admin dashboard",
					format: "json",
					components: [
						{ type: "card", label: "Revenue", position: undefined },
					],
				},
			});
		});

		it("accepts alias fields and normalizes unknown component labels", () => {
			const result = validateFabricCreateFrameInput({
				name: "Mobile app",
				prompt: "Login flow",
				format: "invalid",
				components: [
					{ type: "button", name: "Continue" },
					{ nope: true },
				],
			});

			expect(result).toEqual({
				ok: true,
				value: {
					title: "Mobile app",
					description: "Login flow",
					format: "html",
					components: [
						{
							type: "button",
							label: "Continue",
							position: undefined,
						},
						{
							type: "component",
							label: "component",
							position: undefined,
						},
					],
				},
			});
		});

		it("returns a structured error when title is missing", () => {
			expect(
				validateFabricCreateFrameInput({ description: "x" }),
			).toEqual({
				ok: false,
				error: "Frame title is required. Provide `title` describing the frame to create.",
			});
		});
	});

	describe("frame prompt helpers", () => {
		it("builds a prompt with listed components", () => {
			const prompt = buildFabricFramePrompt({
				title: "Landing Page",
				description: "Marketing site",
				format: "html",
				components: [{ type: "hero", label: "Main hero" }],
			});

			expect(prompt).toContain("Landing Page");
			expect(prompt).toContain("hero: Main hero");
		});

		it("builds deterministic fallback content for mermaid frames", () => {
			const fallback = buildFallbackFrameContent({
				title: "Flow",
				description: "",
				format: "mermaid",
				components: [{ type: "step", label: "Start" }],
			});

			expect(fallback).toContain("graph TD");
			expect(fallback).toContain("Start");
		});
	});
});
