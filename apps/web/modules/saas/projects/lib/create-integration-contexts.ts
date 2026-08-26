/**
 * Shared utility for creating integration ProjectContext records after project creation.
 *
 * Used by ProjectCreationWizard to persist Teams, Notion, Slack, Confluence,
 * and Google Docs selections.
 */

import { pmDetectedTypeDisplayName } from "@repo/utils";
import { orpcClient } from "@shared/lib/orpc-client";
import type {
	NotionPageSelection,
	TeamsChatSelection,
} from "../components/wizard/WizardIntegrationsSection";
import { fetchGoogleDriveFileContent } from "./google-drive-content-fetcher";
import type {
	ConfluencePageSelection,
	GoogleDocSelection,
	SlackChannelSelection,
} from "./integration-selection-types";
import { fetchNotionPageContent } from "./notion-content-fetcher";

/**
 * Maps the wizard's lowercase `projectManagementDetectedType` (e.g.
 * `azure-devops`, `jira`, `gitlab`, `fizzy`, `linear`) to the UPPERCASE provider
 * token used in INTEGRATION-context `metadata.provider` (consistent with the
 * existing `SLACK` / `MICROSOFT_TEAMS` entries and the spec §5.1 example
 * `"AZURE_DEVOPS" | "JIRA" | "GITLAB" | "FIZZY" | "LINEAR"`). The provider token
 * keys `ProjectContextsList`'s `integrationProviderConfig` so the backlog card
 * shows a recognizable label/icon.
 *
 * Falls back to a sanitized uppercase of the raw detected type so an
 * unrecognized PM tool still produces a stable, non-empty provider string (the
 * list then renders the generic Integration card with that string as its badge).
 * Returns `"BACKLOG"` only when nothing was detected at all.
 */
export function backlogProviderToken(
	detectedType: string | null | undefined,
): string {
	if (!detectedType) {
		return "BACKLOG";
	}
	return detectedType.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

/**
 * Creates exactly ONE idempotent, tenant-scoped INTEGRATION `ProjectContext`
 * row for a connected backlog (PM tool), so the backlog renders in
 * `ProjectContextsList` in addition to surfacing in `ProjectManagementSettings`
 * (unified-project-setup spec §5.1, D8 / AC#4).
 *
 * Mirrors the `createIntegrationContexts` pattern: reuses `contexts.create`
 * (which already owns realtime/activity events, the `MAX_INTEGRATION_CONTEXTS`
 * cap, and embedding). `content: ""` ⇒ the procedure does NOT auto-embed and
 * does NOT create a `ProjectDocument`; the row exists purely so the backlog
 * shows in the list. Backlog item ingest for RAG remains owned by
 * `existingProjectSetupWorkflow` Phase 1B.
 *
 * Idempotency: before creating, list the project's existing
 * contexts and skip when an INTEGRATION row with `metadata.kind === "backlog"`
 * and a matching `containerId` already exists — so re-activating a DRAFT via
 * `draftKey` or revisiting the wizard never creates a second row. The 30-context
 * cap is the backstop.
 *
 * Errors (including the 30-cap `BAD_REQUEST`) are RE-THROWN so the caller's
 * mutation `onError`/`catch` can surface them as a toast rather than swallowing
 * them (`global/error-handling.md`).
 */
export async function createBacklogIntegrationContext(params: {
	projectId: string;
	organizationId: string | null | undefined;
	detectedType: string | null | undefined;
	mcpConfigId: string | null | undefined;
	mcpServerId: string | null | undefined;
	containerId: string | null | undefined;
	containerName: string | null | undefined;
}): Promise<{ created: boolean }> {
	const {
		projectId,
		organizationId,
		detectedType,
		mcpConfigId,
		mcpServerId,
		containerId,
		containerName,
	} = params;

	// Idempotency guard: skip when a backlog INTEGRATION row for the same
	// container already exists on the project.
	const existing = await orpcClient.projects.contexts.list({
		projectId,
		organizationId: organizationId ?? undefined,
	});
	const alreadyExists = (existing?.contexts ?? []).some((ctx) => {
		if (ctx.type !== "INTEGRATION") {
			return false;
		}
		const meta = (ctx.metadata ?? {}) as Record<string, unknown>;
		return (
			meta.kind === "backlog" &&
			(containerId == null || meta.containerId === containerId)
		);
	});
	if (alreadyExists) {
		return { created: false };
	}

	const provider = backlogProviderToken(detectedType);
	const sourceTitle =
		containerName || pmDetectedTypeDisplayName(detectedType) || "Backlog";

	await orpcClient.projects.contexts.create({
		projectId,
		organizationId: organizationId ?? null,
		type: "INTEGRATION",
		// Empty content ⇒ no auto-embed, no ProjectDocument. The
		// backlog's RAG ingest is owned by existingProjectSetupWorkflow Phase 1B.
		content: "",
		metadata: {
			provider,
			kind: "backlog",
			...(mcpConfigId ? { mcpConfigId } : {}),
			...(mcpServerId ? { mcpServerId } : {}),
			...(containerId ? { containerId } : {}),
			...(containerName ? { containerName } : {}),
			sourceTitle,
		},
	});

	return { created: true };
}

export async function createIntegrationContexts(params: {
	projectId: string;
	organizationId: string | null | undefined;
	selectedTeamsChats: TeamsChatSelection[];
	selectedNotionPages: NotionPageSelection[];
	selectedSlackChannels?: SlackChannelSelection[];
	selectedConfluencePages?: ConfluencePageSelection[];
	selectedGoogleDocs?: GoogleDocSelection[];
}): Promise<{ successCount: number; failCount: number }> {
	const {
		projectId,
		organizationId,
		selectedTeamsChats,
		selectedNotionPages,
		selectedSlackChannels = [],
		selectedConfluencePages = [],
		selectedGoogleDocs = [],
	} = params;

	const totalItems =
		selectedTeamsChats.length +
		selectedNotionPages.length +
		selectedSlackChannels.length +
		selectedConfluencePages.length +
		selectedGoogleDocs.length;

	if (totalItems === 0) {
		return { successCount: 0, failCount: 0 };
	}

	let successCount = 0;
	let failCount = 0;

	// After-loop monitor enablement. `createContextProcedure` links each
	// chat/channel into the project's `ProjectLinkedTeams*Chat` /
	// `ProjectLinkedSlackChannel` row (the monitor's source of truth) at
	// create-time. The enable procedures require ≥ 1 linked row to exist, so
	// we batch the (cancel-and-restart) workflow start to ONE call per
	// monitor family at the end — instead of N restarts inline. Pre-PR these
	// monitors were never enabled by the wizard at all, so the chat messages
	// never actually flowed into the project's RAG store despite the row
	// existing in the project context list.
	let linkedTeamsGroupChats = 0;
	let linkedTeamsChannels = 0;
	let linkedSlackChannels = 0;

	// Teams chats
	for (const chat of selectedTeamsChats) {
		try {
			const metadata: Record<string, unknown> = {
				provider: "MICROSOFT_TEAMS",
				mcpConfigId: chat.mcpConfigId,
			};
			if (chat.selectionType === "channel") {
				metadata.chatType = "channel";
				metadata.teamId = chat.teamId;
				metadata.channelId = chat.channelId;
				metadata.channelName = chat.channelName;
				metadata.teamName = chat.teamName;
				metadata.chatTopic = chat.topic;
			} else {
				metadata.chatType = "group";
				metadata.chatId = chat.chatId;
				metadata.chatTopic = chat.topic;
			}
			await orpcClient.projects.contexts.create({
				projectId,
				organizationId: organizationId ?? null,
				type: "INTEGRATION",
				content: "",
				metadata,
			});
			if (chat.selectionType === "channel") {
				linkedTeamsChannels++;
			} else {
				linkedTeamsGroupChats++;
			}
			successCount++;
		} catch (err) {
			console.error("Failed to create Teams integration context:", err);
			failCount++;
		}
	}

	// Notion pages
	for (const page of selectedNotionPages) {
		try {
			const { content, contentFetchFailed } =
				await fetchNotionPageContent({
					pageId: page.pageId,
					mcpConfigId: page.mcpConfigId,
					organizationId,
					fallbackTitle: page.title,
				});

			await orpcClient.projects.contexts.create({
				projectId,
				organizationId: organizationId ?? null,
				type: "INTEGRATION",
				content,
				metadata: {
					notionPageId: page.pageId,
					mcpConfigId: page.mcpConfigId,
					provider: "notion",
					notionType: "page",
					sourceTitle: page.title,
					sourceUrl: page.url,
					contentFetchFailed,
					...(page.documentTag
						? {
								documentTag: page.documentTag,
								documentTitle: page.title,
							}
						: {}),
				},
			});

			if (contentFetchFailed) {
				console.warn(
					`[NotionSync] Created context for page "${page.title}" but content fetch failed`,
				);
			}
			successCount++;
		} catch (err) {
			console.error(
				`Failed to create Notion context for page ${page.pageId}:`,
				err,
			);
			failCount++;
		}
	}

	// Slack channels — the link happens client-side here (instead of inside
	// `createContextProcedure` like Teams does) because
	// `slackChannelMonitor.linkChannel` resolves `slackTeamId` from
	// Slack's `auth.test` against the wrapper's bot token (the picker
	// doesn't have the workspace id). On link failure we record the
	// context row but log + count as a fail so the wizard surfaces it.
	for (const channel of selectedSlackChannels) {
		try {
			await orpcClient.projects.contexts.create({
				projectId,
				organizationId: organizationId ?? null,
				type: "INTEGRATION",
				content: "",
				metadata: {
					provider: "SLACK",
					mcpConfigId: channel.mcpConfigId,
					channelId: channel.channelId,
					channelName: channel.channelName,
				},
			});
			try {
				await orpcClient.projects.slackChannelMonitor.linkChannel({
					projectId,
					organizationId: organizationId ?? null,
					channelId: channel.channelId,
					channelName: channel.channelName,
					backfillMode: "latest-7-days",
				});
				linkedSlackChannels++;
			} catch (linkErr) {
				console.error(
					"[Wizard] Slack linkChannel failed for channel",
					channel.channelId,
					linkErr,
				);
			}
			successCount++;
		} catch (err) {
			console.error("Failed to create Slack integration context:", err);
			failCount++;
		}
	}

	// Confluence pages
	for (const page of selectedConfluencePages) {
		try {
			await orpcClient.projects.contexts.create({
				projectId,
				organizationId: organizationId ?? null,
				type: "INTEGRATION",
				content: "",
				metadata: {
					provider: "CONFLUENCE",
					mcpConfigId: page.mcpConfigId,
					pageId: page.pageId,
					sourceTitle: page.title,
					spaceKey: page.spaceKey,
					sourceUrl: page.url,
				},
			});
			successCount++;
		} catch (err) {
			console.error(
				"Failed to create Confluence integration context:",
				err,
			);
			failCount++;
		}
	}

	// Google Docs / Drive — fetch content for embedding
	for (const doc of selectedGoogleDocs) {
		try {
			const { content, title, contentFetchFailed } =
				await fetchGoogleDriveFileContent({
					fileId: doc.fileId,
					mcpConfigId: doc.configId,
					organizationId,
					fallbackTitle: doc.name,
					fallbackMimeType: doc.mimeType,
				});

			await orpcClient.projects.contexts.create({
				projectId,
				organizationId: organizationId ?? null,
				type: "INTEGRATION",
				content,
				metadata: {
					provider: "google-drive",
					mcpConfigId: doc.configId,
					fileId: doc.fileId,
					sourceTitle: title,
					...(doc.mimeType != null && { mimeType: doc.mimeType }),
					...(doc.url != null && { sourceUrl: doc.url }),
					contentFetchFailed,
				},
			});

			if (contentFetchFailed) {
				console.warn(
					`[GoogleDriveSync] Created context for "${doc.name}" but content fetch failed`,
				);
			}
			successCount++;
		} catch (err) {
			console.error(
				"Failed to create Google Drive integration context:",
				err,
			);
			failCount++;
		}
	}

	// Enable the relevant monitor workflows once per family — the per-row
	// `linkXxxToProject` happens inside `createContextProcedure`, so by this
	// point each enable call has at least one linked row (the precondition
	// each `enable*Monitor` procedure validates with `linkedCount >= 1`).
	// Best-effort: a monitor that fails to start does not roll back the
	// context rows — the user still sees their selections and can retry the
	// monitor from project settings.
	const orgForEnable = organizationId ?? null;
	if (linkedTeamsGroupChats > 0) {
		try {
			await orpcClient.projects.teamsChatMonitor.enable({
				projectId,
				organizationId: orgForEnable,
			});
		} catch (err) {
			console.error(
				"[Wizard] enableTeamsChatMonitor failed — chats are linked but the monitor workflow did not start. User can enable it from Settings.",
				err,
			);
		}
	}
	if (linkedTeamsChannels > 0) {
		try {
			await orpcClient.projects.teamsChannelMonitor.enable({
				projectId,
				organizationId: orgForEnable,
			});
		} catch (err) {
			console.error(
				"[Wizard] enableTeamsChannelMonitor failed — channels are linked but the monitor workflow did not start. User can enable it from Settings.",
				err,
			);
		}
	}
	if (linkedSlackChannels > 0) {
		try {
			await orpcClient.projects.slackChannelMonitor.enable({
				projectId,
				organizationId: orgForEnable,
			});
		} catch (err) {
			console.error(
				"[Wizard] enableSlackChannelMonitor failed — channels are linked but the monitor workflow did not start. User can enable it from Settings.",
				err,
			);
		}
	}

	return { successCount, failCount };
}
