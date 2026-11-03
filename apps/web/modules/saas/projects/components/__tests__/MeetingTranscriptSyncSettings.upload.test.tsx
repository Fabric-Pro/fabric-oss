/**
 * @vitest-environment jsdom
 *
 * The upload section has to be reachable with no Microsoft account connected,
 * since that is who it is for, and the setup wizard reaches it only through this
 * component (Fizzy #1877).
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@saas/projects/components/TranscriptFileUpload", () => ({
	TranscriptFileUpload: (props: {
		projectId: string;
		organizationId: string | null;
		canEdit: boolean;
	}) => (
		<div
			data-testid="transcript-upload"
			data-project={props.projectId}
			data-organization={props.organizationId ?? ""}
			data-can-edit={String(props.canEdit)}
		/>
	),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({ user: { id: "user-1" } }),
}));

vi.mock("@saas/shared/components/ConfirmationAlertProvider", () => ({
	useConfirmationAlert: () => ({ confirm: vi.fn() }),
}));

vi.mock("next-intl", () => {
	const t = (key: string) => key;
	t.raw = (key: string) => ({ label: key, warning: key });
	return {
		useTranslations: () => t,
		useLocale: () => "en",
		NextIntlClientProvider: ({ children }: { children: ReactNode }) =>
			children,
	};
});

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			meetingTranscriptSync: {
				listLinkedMeetings: vi.fn().mockResolvedValue([]),
				listDeletedMeetings: vi.fn().mockResolvedValue([]),
				listTranscripts: vi.fn().mockResolvedValue([]),
			},
		},
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			get: { queryKey: () => ["project"] },
			meetingDigest: { key: () => ["digest"] },
		},
	},
}));

import { MeetingTranscriptSyncSettings } from "../MeetingTranscriptSyncSettings";

function renderSettings(canEdit?: boolean) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={client}>
			<MeetingTranscriptSyncSettings
				projectId="project-1"
				organizationId="org-1"
				canEdit={canEdit}
				project={{ meetingTranscriptSyncEnabled: false }}
			/>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	cleanup();
});

describe("MeetingTranscriptSyncSettings upload section", () => {
	it("is there with the sync off and no meeting linked", () => {
		renderSettings();

		const section = screen.getByTestId("transcript-upload");
		expect(section.dataset.project).toBe("project-1");
		expect(section.dataset.organization).toBe("org-1");
	});

	it("follows the wizard's default of being allowed to edit", () => {
		renderSettings();

		expect(screen.getByTestId("transcript-upload").dataset.canEdit).toBe(
			"true",
		);
	});

	it("does not let someone without settings access upload", () => {
		renderSettings(false);

		expect(screen.getByTestId("transcript-upload").dataset.canEdit).toBe(
			"false",
		);
	});
});
