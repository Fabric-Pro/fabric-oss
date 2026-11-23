import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
	useTranslations: (namespace?: string) => {
		const t = (key: string) => (namespace ? `${namespace}.${key}` : key);
		t.raw = () => ({});
		return t;
	},
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
	useSearchParams: () => new URLSearchParams(),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@tanstack/react-query", () => ({
	useMutation: () => ({ mutate: vi.fn(), isPending: false }),
	useQueryClient: () => ({
		invalidateQueries: vi.fn(),
		fetchQuery: vi.fn(),
	}),
}));

vi.mock("@shared/lib/orpc-client", () => ({ orpcClient: {} }));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			get: {
				queryKey: () => ["projects", "get"],
				queryOptions: () => ({ queryKey: ["projects", "get"] }),
			},
		},
	},
}));

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

vi.mock("@saas/time-tracking/components/ProjectTimeTrackingSettings", () => ({
	ProjectTimeTrackingSettings: () => null,
}));

vi.mock("../ProjectManagementSettings", () => ({
	ProjectManagementSettings: () => (
		<div data-testid="project-management-settings" />
	),
}));

vi.mock("../field-mapping/FieldMappingPanel", () => ({
	FieldMappingPanel: () => <div data-testid="field-mapping-panel" />,
}));

vi.mock("../ProjectTabVisibilitySettings", () => ({
	ProjectTabVisibilitySettings: () => (
		<div data-testid="project-tab-visibility-settings" />
	),
}));

vi.mock("../ActionItemRoutingSettings", () => ({
	ActionItemRoutingSettings: () => null,
}));
vi.mock("../GoogleDocsSelectorDialog", () => ({
	GoogleDocsSelectorDialog: () => null,
}));
vi.mock("../MeetingTranscriptSyncSettings", () => ({
	MeetingTranscriptSyncSettings: () => null,
}));
vi.mock("../PrdSourceSettings", () => ({ PrdSourceSettings: () => null }));
vi.mock("../ProjectAiAssistantTab", () => ({
	ProjectAiAssistantTab: () => null,
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
vi.mock("../ProjectMembersSettings", () => ({
	ProjectMembersSettings: () => null,
}));
vi.mock("../ProjectNewsletterSettings", () => ({
	ProjectNewsletterSettings: () => null,
}));
vi.mock("../ProjectRepositoryIntegrationSettings", () => ({
	ProjectRepositoryIntegrationSettings: () => null,
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
vi.mock("../SlackChannelMonitorSettings", () => ({
	SlackChannelMonitorSettings: () => null,
}));
vi.mock("../TeamsChannelMonitorSettings", () => ({
	TeamsChannelMonitorSettings: () => null,
}));
vi.mock("../TeamsChatMonitorSettings", () => ({
	TeamsChatMonitorSettings: () => null,
}));
vi.mock("../coding-runs/LaunchFabricDesktopBar", () => ({
	LaunchFabricDesktopBar: () => null,
}));
vi.mock(
	"@saas/projects/components/capability-gates/CapabilityGateBanner",
	() => ({
		CapabilityGateBanner: () => null,
	}),
);

import { ProjectSettings } from "../ProjectSettings";

type ProjectProp = Parameters<typeof ProjectSettings>[0]["project"];

function makeProject(overrides: Partial<ProjectProp> = {}): ProjectProp {
	return {
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
		pmFieldMappingEnabled: false,
		canEditSettings: true,
		canUpdateProject: true,
		...overrides,
	};
}

function renderSettings(
	overrides: Partial<ProjectProp> = {},
	initialTab?: string,
) {
	if (initialTab) {
		sessionStorage.setItem(
			"fabric-project-settings-tab-project_example",
			initialTab,
		);
	}
	return render(
		<ProjectSettings
			project={makeProject(overrides)}
			currentUserId="user_example"
			tabMeta={[]}
		/>,
	);
}

beforeEach(() => {
	sessionStorage.clear();
});

describe("ProjectSettings — Project Management tab", () => {
	it('shows "Project Management" in the nav even when pmFieldMappingEnabled is false', () => {
		renderSettings({ pmFieldMappingEnabled: false });

		expect(
			screen.getByRole("button", { name: /Project Management/i }),
		).toBeInTheDocument();
	});

	it('renders "Feature stages", "Work item types", and the PM connection card on the Project Management tab', () => {
		renderSettings({ pmFieldMappingEnabled: false });

		fireEvent.click(
			screen.getByRole("button", { name: /Project Management/i }),
		);

		expect(
			screen.getByRole("heading", { name: "Feature stages" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("heading", { name: "Work item types" }),
		).toBeInTheDocument();
		expect(
			screen.getByTestId("project-management-settings"),
		).toBeInTheDocument();
	});

	it("hides FieldMappingPanel when pmFieldMappingEnabled is false and renders it when true", () => {
		const { unmount } = renderSettings(
			{ pmFieldMappingEnabled: false },
			"project-management",
		);
		expect(
			screen.queryByTestId("field-mapping-panel"),
		).not.toBeInTheDocument();
		unmount();

		renderSettings({ pmFieldMappingEnabled: true }, "project-management");
		expect(screen.getByTestId("field-mapping-panel")).toBeInTheDocument();
	});

	it('no longer renders "Feature stages" or "Work item types" on the Navigation tab', () => {
		renderSettings({ pmFieldMappingEnabled: false }, "navigation");

		expect(
			screen.getByTestId("project-tab-visibility-settings"),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("heading", { name: "Feature stages" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("heading", { name: "Work item types" }),
		).not.toBeInTheDocument();
	});

	it("allows an editor to edit feature stages but not Initiatives", () => {
		renderSettings(
			{
				userRole: "editor",
				canUpdateProject: true,
				canEditSettings: false,
			},
			"project-management",
		);

		const stageSwitches = screen.getAllByRole("switch", {
			name: /^Toggle visibility for .+ stage$/,
		});
		expect(stageSwitches.length).toBeGreaterThan(0);
		for (const sw of stageSwitches) {
			expect(sw).toBeEnabled();
		}

		const initiativesSwitch = screen.getByRole("switch", {
			name: "Initiatives",
		});
		expect(initiativesSwitch).toHaveAttribute("aria-disabled", "true");
	});

	it("prevents a viewer from editing either feature stages or Initiatives", () => {
		renderSettings(
			{
				userRole: "viewer",
				canUpdateProject: false,
				canEditSettings: false,
			},
			"project-management",
		);

		const stageSwitches = screen.getAllByRole("switch", {
			name: /^Toggle visibility for .+ stage$/,
		});
		expect(stageSwitches.length).toBeGreaterThan(0);
		for (const sw of stageSwitches) {
			expect(sw).toBeDisabled();
		}

		const initiativesSwitch = screen.getByRole("switch", {
			name: "Initiatives",
		});
		expect(initiativesSwitch).toHaveAttribute("aria-disabled", "true");
	});
});
