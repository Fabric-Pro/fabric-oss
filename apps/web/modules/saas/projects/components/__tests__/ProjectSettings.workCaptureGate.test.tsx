/**
 * Settings → Knowledge renders the Work Capture gate once, above the chat
 * monitor cards (Fizzy #1930). Work Capture needs a conversation linked in any
 * of the three cards, so the warning belongs to the group, not to one card.
 *
 * Every card is stubbed: this pins where the banner sits, not what the cards
 * do. The banner renders through its real component from a driven selection,
 * the way the other capability-gate mount suites do it.
 */
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
	useTranslations: (namespace?: string) => {
		const t = (key: string) => (namespace ? `${namespace}.${key}` : key);
		t.raw = () => ({});
		return t;
	},
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn() }),
	useSearchParams: () => new URLSearchParams(),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@tanstack/react-query", () => ({
	useMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@shared/lib/orpc-client", () => ({ orpcClient: {} }));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({ basePath: "/app/example-org" }),
}));

vi.mock("@saas/shared/components/ConfirmationAlertProvider", () => ({
	useConfirmationAlert: () => ({ confirm: vi.fn() }),
}));

vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => false,
}));

vi.mock("@saas/shared/lib/feature-flags", () => ({
	isMonitoringFeatureEnabled: () => false,
}));

vi.mock("@saas/get-started/components/PageTourButton", () => ({
	PageTourButton: () => null,
}));

vi.mock("../../lib/project-tab-preferences", () => ({
	useProjectTabCustomization: () => ({
		config: null,
		saveConfig: { mutate: vi.fn(), isPending: false },
	}),
}));

vi.mock("../ProjectSettingsNav", () => ({ ProjectSettingsNav: () => null }));

// The three cards the banner sits above, named so the test can find them.
function stub(name: string) {
	return () => <div data-testid={name} />;
}
vi.mock("../TeamsChannelMonitorSettings", () => ({
	TeamsChannelMonitorSettings: stub("teams-channels"),
}));
vi.mock("../TeamsChatMonitorSettings", () => ({
	TeamsChatMonitorSettings: stub("teams-chats"),
}));
vi.mock("../SlackChannelMonitorSettings", () => ({
	SlackChannelMonitorSettings: stub("slack-channels"),
}));

// Everything else on the page, rendered as nothing.
vi.mock("../ActionItemRoutingSettings", () => ({
	ActionItemRoutingSettings: () => null,
}));
vi.mock("../field-mapping/FieldMappingPanel", () => ({
	FieldMappingPanel: () => null,
}));
vi.mock("../GoogleDocsSelectorDialog", () => ({
	GoogleDocsSelectorDialog: () => null,
}));
vi.mock("../MeetingTranscriptSyncSettings", () => ({
	MeetingTranscriptSyncSettings: () => null,
}));
vi.mock("../PrdSourceSettings", () => ({ PrdSourceSettings: () => null }));
vi.mock("../ProjectAiAssistantSettings", () => ({
	ProjectAiAssistantSettings: () => null,
}));
vi.mock("../ProjectDatabricksKnowledgeSettings", () => ({
	ProjectDatabricksKnowledgeSettings: () => null,
}));
vi.mock("../ProjectEngagementSettings", () => ({
	ProjectEngagementSettings: () => null,
}));
vi.mock("../ProjectGeneralSettings", () => ({
	ProjectGeneralSettings: () => null,
}));
vi.mock("../ProjectImplementationDefaultsSettings", () => ({
	ProjectImplementationDefaultsSettings: () => null,
}));
vi.mock("../ProjectManagementSettings", () => ({
	ProjectManagementSettings: () => null,
}));
vi.mock("../ProjectMembersSettings", () => ({
	ProjectMembersSettings: () => null,
}));
vi.mock("../ProjectNewsletterSettings", () => ({
	ProjectNewsletterSettings: () => null,
}));
vi.mock("../ProjectPromptDefaultsSettings", () => ({
	ProjectPromptDefaultsSettings: () => null,
}));
vi.mock("../ProjectReadOnlyModeSettings", () => ({
	ProjectReadOnlyModeSettings: () => null,
}));
vi.mock("../ProjectRepositoryIntegrationSettings", () => ({
	ProjectRepositoryIntegrationSettings: () => null,
}));
vi.mock("../ProjectStageVisibilitySettings", () => ({
	ProjectStageVisibilitySettings: () => null,
}));
vi.mock("../ProjectTabVisibilitySettings", () => ({
	ProjectTabVisibilitySettings: () => null,
}));
vi.mock("../PublishingSuiteSettings", () => ({
	PublishingSuiteSettings: () => null,
}));
vi.mock("../qa-settings/ProjectEnvironmentsSettings", () => ({
	ProjectEnvironmentsSettings: () => null,
}));
vi.mock("../qa-settings/TestingSettingsPanel", () => ({
	TestingSettingsPanel: () => null,
}));
vi.mock("../RagSettingsForm", () => ({ RagSettingsForm: () => null }));

// The gate this page reads, driven per test and keyed so a banner for any
// other capability on the page stays empty.
const gates = new Map<string, CapabilityGateSelection>();
vi.mock(
	"@saas/projects/components/capability-gates/useCapabilityGates",
	() => ({
		useCapabilityGate: (key: string) =>
			gates.get(key) ?? { gate: null, view: null, blocked: false },
		useCapabilityGates: () => ({
			projectId: "project_example",
			suppress: vi.fn(),
			linkFor: () => null,
			codebaseRetryFor: () => undefined,
			codebaseRetrying: false,
		}),
		SNOOZE_DURATIONS: ["session", "1d", "7d", "30d", "forever"] as const,
	}),
);

import type { CapabilityGateSelection } from "@saas/projects/components/capability-gates/useCapabilityGates";
import { CHAT_MONITORS_SECTION_ID } from "../ConnectChatChannelButton";
import { ProjectSettings } from "../ProjectSettings";

const NO_CHANNEL: CapabilityGateSelection = {
	gate: null,
	view: {
		capabilityKey: "settings.work-capture",
		state: "WARNING",
		reasonKey: "settings.no-linked-channel",
		tone: "warning",
		title: "reason.settings.no-linked-channel.title",
		body: "reason.settings.no-linked-channel.body",
		params: { dependency: "a linked Slack or Teams conversation" },
		ctaLabel: null,
		ctaKind: "none",
		ctaTarget: null,
		blocksAction: false,
		dismissible: true,
		retry: {
			supported: false,
			permitted: false,
			available: false,
			targetId: null,
		},
	},
	blocked: false,
};

function renderKnowledgeTab() {
	sessionStorage.setItem(
		"fabric-project-settings-tab-project_example",
		"knowledge",
	);
	const project = {
		id: "project_example",
		name: "Example project",
		description: null,
		status: "ACTIVE",
		projectTypes: [],
		icon: null,
		color: null,
		tags: null,
		techStack: null,
		features: null,
		goals: null,
		createdAt: "2026-09-01T00:00:00.000Z",
		updatedAt: "2026-09-01T00:00:00.000Z",
		organizationId: "org_example",
		userId: "user_example",
		canEditSettings: true,
	};
	render(
		<ProjectSettings
			project={
				project as Parameters<typeof ProjectSettings>[0]["project"]
			}
			currentUserId="user_example"
		/>,
	);
}

beforeEach(() => {
	gates.clear();
	sessionStorage.clear();
});

describe("ProjectSettings — the Work Capture gate", () => {
	it("warns once, inside the chat monitors group and above its cards", () => {
		gates.set("settings.work-capture", NO_CHANNEL);
		renderKnowledgeTab();

		const banners = screen.getAllByRole("status");
		expect(banners).toHaveLength(1);
		const [banner] = banners;
		expect(banner).toHaveTextContent(
			"projects.capabilityGates.reason.settings.no-linked-channel.title",
		);

		const group = document.getElementById(CHAT_MONITORS_SECTION_ID);
		expect(group).not.toBeNull();
		expect(group).toContainElement(banner);
		// First in the group: the warning reads before the cards that fix it.
		expect(group?.firstElementChild).toBe(banner);
		expect(
			within(group as HTMLElement).getByTestId("teams-channels"),
		).toBeInTheDocument();
	});

	it("offers dismissal and no remedy button — the link controls are right below", () => {
		gates.set("settings.work-capture", NO_CHANNEL);
		renderKnowledgeTab();

		const banner = screen.getByRole("status");
		const buttons = within(banner).getAllByRole("button");
		expect(buttons).toHaveLength(1);
		expect(buttons[0]).toHaveAccessibleName(
			"projects.capabilityGates.dismiss.action",
		);
	});

	it("renders nothing when a conversation is linked", () => {
		renderKnowledgeTab();

		expect(screen.queryByRole("status")).not.toBeInTheDocument();
		expect(screen.getByTestId("slack-channels")).toBeInTheDocument();
	});
});
