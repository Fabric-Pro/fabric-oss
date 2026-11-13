import { describe, expect, it } from "vitest";
import { reviewFocusFallback } from "../newsletter-review-focus";

/** One highlight row's focus targets, built by hand: no React, no dialog. */
function row(
	index: number,
	options: { addImage?: "enabled" | "disabled"; include?: boolean } = {},
): HTMLElement {
	const li = document.createElement("li");
	if (options.include ?? true) {
		const include = document.createElement("button");
		include.setAttribute("role", "checkbox");
		include.setAttribute("data-review-include", String(index));
		li.append(include);
	}
	if (options.addImage) {
		const addImage = document.createElement("button");
		addImage.setAttribute("data-review-add-image", String(index));
		addImage.disabled = options.addImage === "disabled";
		li.append(addImage);
	}
	return li;
}

function container(...rows: HTMLElement[]): HTMLElement {
	const ul = document.createElement("ul");
	ul.append(...rows);
	return ul;
}

describe("reviewFocusFallback", () => {
	it("picks the highlight's Add image button when it is enabled", () => {
		const root = container(row(0, { addImage: "enabled" }));

		expect(reviewFocusFallback(root, 0)).toBe(
			root.querySelector('[data-review-add-image="0"]'),
		);
	});

	it("falls back to the include control when Add image is disabled", () => {
		const root = container(row(0, { addImage: "disabled" }));

		expect(reviewFocusFallback(root, 0)).toBe(
			root.querySelector('[data-review-include="0"]'),
		);
	});

	it("falls back to the include control when there is no Add image", () => {
		const root = container(row(0));

		expect(reviewFocusFallback(root, 0)).toBe(
			root.querySelector('[data-review-include="0"]'),
		);
	});

	it("returns null when the highlight has neither control", () => {
		const root = container(row(0, { include: false }));

		expect(reviewFocusFallback(root, 0)).toBeNull();
	});

	it("returns null without a container", () => {
		expect(reviewFocusFallback(null, 0)).toBeNull();
	});

	it("picks the controls of the requested highlight among several", () => {
		const root = container(
			row(0, { addImage: "enabled" }),
			row(1, { addImage: "enabled" }),
			row(2),
		);

		expect(reviewFocusFallback(root, 1)).toBe(
			root.querySelector('[data-review-add-image="1"]'),
		);
		expect(reviewFocusFallback(root, 2)).toBe(
			root.querySelector('[data-review-include="2"]'),
		);
	});

	it("does not take index 1's control for index 10", () => {
		const root = container(row(1, { addImage: "enabled" }));

		expect(reviewFocusFallback(root, 10)).toBeNull();
	});
});
