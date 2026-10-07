/**
 * The Workflow Template, CUGA and Agent Builder Sidekick chat boxes grow with
 * their text up to their max height and only scroll past it. Before this they
 * kept their starting height, so a long prompt scrolled inside a sliver.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { AgentBuilderSidekick } from "../../sidekick/AgentBuilderSidekick";
import { CugaAuthenticatedChat } from "../cuga/CugaAuthenticatedChat";
import { WorkflowTemplateChat } from "../WorkflowTemplateChat/WorkflowTemplateChat";

vi.mock("../../hooks/useWorkflowTemplateStream", () => ({
	useWorkflowTemplateStream: () => ({
		state: { status: "idle", result: null },
		query: "",
		isLoading: false,
		isRunning: false,
		isComplete: false,
		hasResults: false,
		progress: null,
		sendQuery: vi.fn(),
		sendClarificationResponse: vi.fn(),
		cancel: vi.fn(),
		reset: vi.fn(),
	}),
}));

// Fetches the pinned agent version; the composer does not depend on it.
vi.mock("../FabricChat/shared/AgentVersionIdentity", () => ({
	AgentVersionIdentity: () => null,
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({ organizationId: "org-1" }),
}));

vi.mock("@ai-sdk/react", () => ({
	useChat: () => ({ messages: [], status: "ready", sendMessage: vi.fn() }),
}));
vi.mock("@saas/ai/hooks/useLimitToast", () => ({
	useLimitToast: () => vi.fn(),
}));
vi.mock("@saas/payments/lib/ai-usage-limit-toast", () => ({
	isAiUsageLimitExceededPayload: () => false,
	useShowAiUsageLimitToast: () => vi.fn(),
}));
vi.mock("../../sidekick/SidekickFormContext", () => ({
	useSidekickForm: () => ({ getSnapshot: () => ({}) }),
}));

// jsdom does no layout, so scrollHeight is always 0. Model it the way a
// browser does once height is "auto": one line height per line of text.
const LINE_HEIGHT = 24;
Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", {
	configurable: true,
	get(this: HTMLTextAreaElement) {
		return this.value.split("\n").length * LINE_HEIGHT;
	},
});
// jsdom has neither; CugaAuthenticatedChat and AgentBuilderSidekick scroll
// their message lists on mount.
Element.prototype.scrollIntoView = vi.fn();
Element.prototype.scrollTo = vi.fn();

const LONG_TEXT = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");

const composers: Array<[string, () => ReactElement, number]> = [
	[
		"WorkflowTemplateChat",
		() => (
			<WorkflowTemplateChat
				templateSlug="research"
				instanceId="instance-1"
				instanceName="Research"
				suggestions={[]}
			/>
		),
		200,
	],
	["CugaAuthenticatedChat", () => <CugaAuthenticatedChat />, 200],
	["AgentBuilderSidekick", () => <AgentBuilderSidekick />, 192],
];

describe.each(composers)("%s chat box auto-size", (_name, ui, maxHeight) => {
	it("grows to fit its text without scrolling", () => {
		render(ui());
		const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;

		fireEvent.change(textarea, { target: { value: "one\ntwo\nthree" } });

		expect(textarea.style.height).toBe(`${3 * LINE_HEIGHT}px`);
		expect(textarea.style.overflowY).toBe("hidden");
	});

	it("caps the height at its max and scrolls beyond it", () => {
		render(ui());
		const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;

		fireEvent.change(textarea, { target: { value: LONG_TEXT } });

		expect(textarea.style.height).toBe(`${maxHeight}px`);
		expect(textarea.style.overflowY).toBe("auto");
	});
});
