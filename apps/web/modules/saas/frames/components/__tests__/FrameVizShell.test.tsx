import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { FrameDocumentView } from "../FrameRenderer";
import { FrameVizShell } from "../FrameVizShell";

vi.mock("../../hooks/use-frame-runtime-bridge", () => ({
	useFrameRuntimeBridge: () => ({
		pendingCall: null,
		answerConfirmation: vi.fn(),
	}),
}));

vi.mock("../FrameShellHeader", () => ({
	FrameShellHeader: () => null,
}));

vi.mock("../FrameRenderer", () => ({
	FrameRenderer: ({ frame }: { frame: FrameDocumentView }) => (
		<div data-testid="inline-frame">{frame.blocks[0]?.content}</div>
	),
}));

const EMBED_URL = "/app/example-org/frames/frame-1/embed";

const frameDocument: FrameDocumentView = {
	version: 1,
	kind: "frame",
	title: "Sprint review",
	blocks: [{ id: "main", type: "html", content: "Report body" }],
};

function embedIframes(container: HTMLElement) {
	return [...container.querySelectorAll("iframe")].filter(
		(iframe) => iframe.getAttribute("src") === EMBED_URL,
	);
}

describe("FrameVizShell", () => {
	it("draws a static page from its document without loading the embed route", async () => {
		const { container } = render(
			<FrameVizShell
				title="Sprint review"
				kind="frame"
				embedUrl={EMBED_URL}
				frameDocument={frameDocument}
				interactive={false}
			/>,
		);

		expect(await screen.findByTestId("inline-frame")).toHaveTextContent(
			"Report body",
		);
		expect(embedIframes(container)).toHaveLength(0);
	});

	it("loads an interactive page through the embed route behind a visible loading state", () => {
		const { container } = render(
			<FrameVizShell
				title="Sprint review"
				kind="frame"
				embedUrl={EMBED_URL}
				frameDocument={frameDocument}
				surface="artifact"
			/>,
		);

		expect(embedIframes(container)).toHaveLength(1);
		expect(screen.getByRole("status")).toHaveTextContent(
			"Loading artifact…",
		);
		expect(screen.queryByTestId("inline-frame")).toBeNull();
	});
});
