import { render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it } from "vitest";
import { SearchInput } from "../search-input";

describe("SearchInput", () => {
	it("defaults to a non-credential search field (type=search, autocomplete=off)", () => {
		render(<SearchInput aria-label="Search things" />);
		const input = screen.getByLabelText("Search things");
		expect(input).toHaveAttribute("type", "search");
		expect(input).toHaveAttribute("autocomplete", "off");
	});

	it("forwards value, onChange, placeholder, and className unchanged", () => {
		render(
			<SearchInput
				aria-label="Search things"
				placeholder="Search things..."
				value="hello"
				onChange={() => {}}
				className="pl-9"
			/>,
		);
		const input = screen.getByLabelText("Search things");
		expect(input).toHaveValue("hello");
		expect(input).toHaveAttribute("placeholder", "Search things...");
		expect(input).toHaveClass("pl-9");
	});

	it("allows the defaults to be overridden explicitly", () => {
		render(
			<SearchInput
				aria-label="Search things"
				type="text"
				autoComplete="on"
			/>,
		);
		const input = screen.getByLabelText("Search things");
		expect(input).toHaveAttribute("type", "text");
		expect(input).toHaveAttribute("autocomplete", "on");
	});

	it("forwards a ref to the underlying input element", () => {
		const ref = createRef<HTMLInputElement>();
		render(<SearchInput aria-label="Search things" ref={ref} />);
		expect(ref.current).toBeInstanceOf(HTMLInputElement);
	});
});
