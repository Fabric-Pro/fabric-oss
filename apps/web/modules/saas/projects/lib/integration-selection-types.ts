/**
 * Shared selection types for integration context pickers (Slack, Confluence,
 * Google Docs).
 *
 * Relocated here from the now-removed `existing-project-onboarding-state.ts`
 * (unified-project-setup spec §10 / Task 5.1) so the surviving consumers —
 * `create-integration-contexts.ts`, `wizard/BasicInfoStep.tsx`, and
 * `ProjectCreationWizard.tsx` — keep compiling after the Existing-flow state
 * module is deleted. These are the runtime-agnostic shapes the Add Context
 * dialog and the integration-context creator pass between each other.
 */

export interface SlackChannelSelection {
	channelId: string;
	channelName: string;
	mcpConfigId: string;
}

export interface ConfluencePageSelection {
	pageId: string;
	title: string;
	spaceKey?: string;
	url?: string;
	mcpConfigId: string;
}

export interface GoogleDocSelection {
	fileId: string;
	name: string;
	mimeType?: string;
	url?: string;
	configId: string;
}
