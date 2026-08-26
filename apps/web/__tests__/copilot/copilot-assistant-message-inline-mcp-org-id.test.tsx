/**
 * `InlineMcpFrameSlot` — the inline `<McpAppFrame>` mount inside the
 * assistant chat bubble — must pass the ACTIVE organization id, not a
 * hardcoded `null`.
 *
 * Bug context: with `organizationId={null}`, `<ExcalidrawPreview>`'s
 * `read_checkpoint` revalidation (`/api/mcp-app/call-tool`) ran its
 * tenant-scoped config lookup in personal context for org users and
 * 404'd — surfacing "Couldn't display this diagram / Failed to load
 * diagram (404)" on perfectly good diagrams.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { organizationIdMock, frameProps } = vi.hoisted(() => ({
	organizationIdMock: vi.fn<() => string | null>(() => null),
	frameProps: [] as Array<Record<string, unknown>>,
}));

// The component under test only needs these two seams; the rest of the
// module's imports are heavy chat plumbing that must not execute here.
vi.mock("@/components/ai-elements/McpAppFrame", () => ({
	McpAppFrame: (props: Record<string, unknown>) => {
		frameProps.push(props);
		return <div data-testid="mcp-frame" />;
	},
}));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationId: () => organizationIdMock(),
}));
vi.mock("@copilotkit/react-core", () => ({
	useCoAgent: vi.fn(() => ({ state: {} })),
	useCopilotChat: vi.fn(() => ({ visibleMessages: [] })),
}));
vi.mock("@copilotkit/react-ui", () => ({
	Markdown: () => null,
	useChatContext: vi.fn(() => ({})),
}));
vi.mock("next/navigation", () => ({
	useParams: () => ({}),
}));
vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => key,
}));
vi.mock(
	"@saas/projects/components/copilot/DocumentAssistantOutcomesProvider",
	() => ({
		useDocumentAssistantOutcomes: vi.fn(() => null),
	}),
);
vi.mock("@saas/projects/components/copilot/DiffOutcomeChip", () => ({
	DiffOutcomeChip: () => null,
}));
vi.mock(
	"@saas/projects/components/excalidraw-auto-insert/ChatMessageInsertDiagramButton",
	() => ({
		ChatMessageInsertDiagramButton: () => null,
	}),
);
vi.mock(
	"@saas/projects/components/excalidraw-auto-insert/deriveDiagramTitle",
	() => ({
		deriveDiagramTitle: vi.fn(() => "diagram"),
	}),
);
vi.mock(
	"@saas/projects/components/excalidraw-auto-insert/useActiveTipTapEditor",
	() => ({
		useActiveTipTapEditor: vi.fn(() => null),
	}),
);
vi.mock(
	"@saas/projects/components/excalidraw-auto-insert/useChatScopedProject",
	() => ({
		useChatScopedProjectFromCopilotChat: vi.fn(() => ({
			projectId: null,
			organizationId: null,
			lastUserPromptForMessage: () => null,
		})),
	}),
);
vi.mock(
	"./../../modules/saas/shared/components/copilot/ReasoningCollapsible",
	() => ({
		ReasoningCollapsible: () => null,
	}),
);

import { InlineMcpFrameSlot } from "@saas/shared/components/copilot/CopilotAssistantMessage";

const ENVELOPE = {
	resourceUri: "ui://excalidraw/view",
	configId: "cfg-1",
	checkpointId: "cp-1",
	toolArgs: { elements: "[]" },
};

describe("InlineMcpFrameSlot", () => {
	it("passes the active organization id to McpAppFrame", () => {
		frameProps.length = 0;
		organizationIdMock.mockReturnValue("org-42");
		render(<InlineMcpFrameSlot envelope={ENVELOPE} />);
		expect(screen.getByTestId("mcp-frame")).toBeInTheDocument();
		expect(frameProps[0]).toMatchObject({
			resourceUri: "ui://excalidraw/view",
			configId: "cfg-1",
			organizationId: "org-42",
		});
		// The checkpoint id still travels as the stringified tool result —
		// `extractCheckpointId` parses that shape.
		expect(frameProps[0].toolResult).toBe(
			JSON.stringify({ checkpointId: "cp-1" }),
		);
	});

	it("passes null in personal context", () => {
		frameProps.length = 0;
		organizationIdMock.mockReturnValue(null);
		render(<InlineMcpFrameSlot envelope={ENVELOPE} />);
		expect(frameProps[0]).toMatchObject({ organizationId: null });
	});
});
