import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ParlumeRequestItem } from "../ParlumeRequestItem";
import { PROJECT_BASE_PATH, request } from "./fixtures";

afterEach(cleanup);

const ANSWER = [
	"**Status:** on track for Thursday.",
	"",
	"---",
	"",
	"- Export is in review",
	"- [The plan](https://example.com/plan) is current",
	"",
	"<img src=x onerror=alert(1)> done",
].join("\n");

function showItem(responseText: string | null) {
	return render(
		<ul>
			<ParlumeRequestItem
				request={request({ responseText })}
				projectBasePath={PROJECT_BASE_PATH}
			/>
		</ul>,
	);
}

describe("ParlumeRequestItem answer", () => {
	it("renders the answer's Markdown instead of showing its syntax", () => {
		const { container } = showItem(ANSWER);

		expect(screen.getByText("Status:").tagName).toBe("STRONG");
		expect(container.querySelector("hr")).not.toBeNull();
		expect(screen.getByText("Export is in review").tagName).toBe("LI");
		expect(screen.getByRole("link", { name: "The plan" })).toHaveAttribute(
			"href",
			"https://example.com/plan",
		);
		expect(container.textContent).not.toContain("**");
		expect(container.textContent).not.toContain("---");
	});

	it("keeps raw HTML in an answer inert", () => {
		const { container } = showItem(ANSWER);

		// The only image is the answer's own Fabric mark.
		const images = [...container.querySelectorAll("img")];
		expect(images.map((image) => image.alt)).toEqual(["Fabric AI"]);
		expect(container.querySelector("[onerror]")).toBeNull();
	});

	it("shows no answer block for a request without an answer", () => {
		showItem(null);

		expect(screen.queryByText("On track.")).toBeNull();
		expect(screen.getByText("What is the status?")).toBeInTheDocument();
	});
});
