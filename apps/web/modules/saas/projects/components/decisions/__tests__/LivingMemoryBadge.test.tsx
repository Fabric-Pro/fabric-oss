/**
 * The "From Living Memory" marker: a labelled pill in the list, an icon in the
 * dense table, and the detail sheet's provenance line with the source file and
 * a link to the work item the decision came from.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
	LivingMemoryBadge,
	LivingMemorySourceNote,
} from "../LivingMemoryBadge";

describe("LivingMemoryBadge", () => {
	it("shows a labelled pill by default", () => {
		render(<LivingMemoryBadge />);
		expect(screen.getByText("badge")).toBeInTheDocument();
	});

	it("names the icon variant for assistive technology", () => {
		render(<LivingMemoryBadge variant="icon" />);
		expect(screen.getByLabelText("badge")).toBeInTheDocument();
	});
});

describe("LivingMemorySourceNote", () => {
	it("shows the file the decision was found in", () => {
		render(
			<LivingMemorySourceNote
				sourceMetadata={{
					contextId: "ctx-1",
					sourcePath: "docs/architecture/storage.md",
				}}
			/>,
		);
		expect(screen.getByText("sourceNote")).toBeInTheDocument();
		expect(
			screen.getByText("docs/architecture/storage.md"),
		).toBeInTheDocument();
	});

	it("still marks the source when the metadata has no readable path", () => {
		render(<LivingMemorySourceNote sourceMetadata={{ sourcePath: 42 }} />);
		expect(screen.getByText("sourceNote")).toBeInTheDocument();
		expect(screen.queryByText("42")).not.toBeInTheDocument();
	});

	it("links the work item the decision came from", () => {
		render(
			<LivingMemorySourceNote
				sourceMetadata={{
					sourcePath: "specs/storage.md",
					workItem: { id: "story-12", identifier: "F-012" },
				}}
			/>,
		);
		const link = screen.getByRole("link", { name: "workItemLink" });
		expect(link).toHaveTextContent("F-012");
		expect(link.getAttribute("href")).toMatch(/\/stories\/story-12$/);
	});

	it.each([
		["no work item", { sourcePath: "specs/storage.md" }],
		["a malformed one", { workItem: { id: 12, identifier: "F-012" } }],
		["one without an identifier", { workItem: { id: "story-12" } }],
	])("shows no link for %s", (_label, sourceMetadata) => {
		render(<LivingMemorySourceNote sourceMetadata={sourceMetadata} />);
		expect(screen.queryByRole("link")).not.toBeInTheDocument();
	});
});
