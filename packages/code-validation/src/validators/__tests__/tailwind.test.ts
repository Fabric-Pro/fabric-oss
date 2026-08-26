import { describe, expect, it } from "vitest";
import { validateTailwindClasses } from "../tailwind";

describe("validateTailwindClasses", () => {
	it("should validate valid Tailwind classes", () => {
		const code = `
			const Component = () => {
				return <div className="flex items-center justify-center p-4 bg-blue-500">Hello</div>;
			};
		`;
		const result = validateTailwindClasses(code);
		expect(result.valid).toBe(true);
		expect(result.warnings).toHaveLength(0);
	});

	it("should warn about unknown classes", () => {
		const code = `
			const Component = () => {
				return <div className="flex unknown-class another-invalid">Hello</div>;
			};
		`;
		const result = validateTailwindClasses(code);
		expect(result.valid).toBe(false);
		expect(result.warnings.length).toBeGreaterThan(0);
	});

	it("should validate hover and focus states", () => {
		const code = `
			const Component = () => {
				return <div className="hover:bg-blue-600 focus:ring-2">Hello</div>;
			};
		`;
		const result = validateTailwindClasses(code);
		expect(result.valid).toBe(true);
	});

	it("should validate responsive prefixes", () => {
		const code = `
			const Component = () => {
				return <div className="sm:flex md:grid lg:block">Hello</div>;
			};
		`;
		const result = validateTailwindClasses(code);
		expect(result.valid).toBe(true);
	});

	it("should validate arbitrary values", () => {
		const code = `
			const Component = () => {
				return <div className="w-[100px] h-[50px] bg-[#ff0000]">Hello</div>;
			};
		`;
		const result = validateTailwindClasses(code);
		expect(result.valid).toBe(true);
	});
});
