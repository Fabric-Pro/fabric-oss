/**
 * The stage-transition dialog's prompt picker has to know which project it is
 * in. Without the project the picker cannot offer the PROJECT tier when binding
 * a default, and it ranks the list without the project default the enhance run
 * will actually use.
 */

import { FeatureTransitionDialog } from "@saas/projects/components/stories/FeatureTransitionDialog";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { promptSelectorProps } = vi.hoisted(() => ({
	promptSelectorProps: vi.fn(),
}));

vi.mock("@saas/prompts/components/PromptSelector", () => ({
	PromptSelector: (props: Record<string, unknown>) => {
		promptSelectorProps(props);
		return null;
	},
}));

vi.mock("@saas/projects/components/stories/useStoryReadiness", () => ({
	useStoryReadiness: () => ({ data: undefined, isPending: false }),
}));

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => key,
}));

function renderDialog(props: Record<string, unknown> = {}) {
	return render(
		<FeatureTransitionDialog
			open
			onOpenChange={() => {}}
			currentStage="PASSIVE_ANALYSIS"
			targetStage="ACTIVE_ANALYSIS"
			storyKind="FEATURE"
			featureIdentifier="F-001"
			featureTitle="Saved searches"
			onEnhance={() => {}}
			{...props}
		/>,
	);
}

describe("FeatureTransitionDialog — prompt picker project scope", () => {
	beforeEach(() => {
		promptSelectorProps.mockReset();
	});

	it("passes the work item's project to the prompt picker", () => {
		renderDialog({ projectId: "project-1", storyId: "story-1" });

		expect(promptSelectorProps).toHaveBeenCalledWith(
			expect.objectContaining({
				agentName: "project_document_generator",
				documentType: "ACTIVE_ANALYSIS",
				storyKind: "FEATURE",
				projectId: "project-1",
			}),
		);
	});
});
