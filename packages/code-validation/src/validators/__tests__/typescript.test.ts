import { describe, expect, it } from "vitest";
import { validateTypeScriptSyntax } from "../typescript";

describe("validateTypeScriptSyntax", () => {
	it("should validate valid TSX code", () => {
		const code = `
			const Component = () => {
				return <div className="text-red-500">Hello</div>;
			};
		`;
		const result = validateTypeScriptSyntax(code);
		expect(result.valid).toBe(true);
		expect(result.errors).toHaveLength(0);
	});

	it("should detect syntax errors", () => {
		const code = `
			const Component = () => {
				return <div className="text-red-500">Hello
			};
		`;
		const result = validateTypeScriptSyntax(code);
		expect(result.valid).toBe(false);
		expect(result.errors.length).toBeGreaterThan(0);
	});

	it("should detect unclosed JSX tags", () => {
		const code = `
			const Component = () => {
				return <div><span>Hello</div>;
			};
		`;
		const result = validateTypeScriptSyntax(code);
		expect(result.valid).toBe(false);
	});

	it("should validate TypeScript-specific syntax", () => {
		const code = `
			interface Props {
				name: string;
			}
			const Component = ({ name }: Props) => {
				return <div>{name}</div>;
			};
		`;
		const result = validateTypeScriptSyntax(code);
		expect(result.valid).toBe(true);
	});

	it("should validate optional chaining", () => {
		const code = `
			const obj = { a: { b: 1 } };
			const value = obj?.a?.b;
		`;
		const result = validateTypeScriptSyntax(code);
		expect(result.valid).toBe(true);
	});
});
