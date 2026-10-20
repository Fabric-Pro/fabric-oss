import { render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Response } from "../../../components/ai-elements/response";

const workspaceUrl = "/app/example-org/workspaces/frame-1";
const artifactsUrl = "/app/example-org/projects/project-1?tab=artifacts#saved";
const markdown = [
	`[Open Workspace](${workspaceUrl})`,
	`[Project artifacts](${artifactsUrl})`,
	"[External documentation](https://example.com/docs)",
].join("\n\n");

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("Response links", () => {
	it.each([true, false])(
		"renders saved page links with normalizeMarkdown=%s",
		(normalizeMarkdown) => {
			render(
				<Response normalizeMarkdown={normalizeMarkdown}>
					{markdown}
				</Response>,
			);

			expect(
				screen.getByRole("link", { name: "Open Workspace" }),
			).toHaveAttribute("href", workspaceUrl);
			expect(
				screen.getByRole("link", { name: "Project artifacts" }),
			).toHaveAttribute("href", artifactsUrl);
			expect(
				screen.getByRole("link", { name: "External documentation" }),
			).toHaveAttribute("href", "https://example.com/docs");
			expect(screen.queryByText(/\[blocked\]/)).not.toBeInTheDocument();
		},
	);

	it("keeps unsafe link protocols blocked", () => {
		render(
			<Response>
				{
					"[Script](javascript:alert(1))\n\n[Data](data:text/html,unsafe)"
				}
			</Response>,
		);

		expect(screen.queryByRole("link")).not.toBeInTheDocument();
		expect(screen.getByText("Script [blocked]")).toBeInTheDocument();
		expect(screen.getByText("Data [blocked]")).toBeInTheDocument();
	});

	it("preserves relative image proxy rendering", () => {
		render(
			<Response>{"![Chart](/api/storage/image?key=example)"}</Response>,
		);

		expect(screen.getByRole("img", { name: "Chart" })).toHaveAttribute(
			"src",
			"/api/storage/image?key=example",
		);
	});

	it("renders relative links on the server using the configured site origin", () => {
		vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://staging.example.com");
		vi.stubGlobal("window", undefined);
		let html: string;
		try {
			html = renderToString(<Response>{markdown}</Response>);
		} finally {
			vi.unstubAllGlobals();
		}

		const container = document.createElement("div");
		container.innerHTML = html;
		expect(
			container.querySelector(`a[href="${workspaceUrl}"]`),
		).not.toBeNull();
		expect(
			container.querySelector(`a[href="${artifactsUrl}"]`),
		).not.toBeNull();
		expect(container.textContent).not.toContain("[blocked]");
	});
});
