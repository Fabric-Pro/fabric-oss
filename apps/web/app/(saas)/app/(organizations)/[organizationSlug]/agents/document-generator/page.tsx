"use client";

/**
 * Document Generator Page
 *
 * Fullscreen dedicated page for the document generator agent.
 *
 * Moved here from `/app/agents/document-generator` when the personal route
 * trees were retired (Fizzy #1875, R1). It was the one agent surface with no
 * organization counterpart to redirect to, so it was moved rather than
 * replaced — deleting it would have taken a live feature with it.
 *
 * Features:
 * - Breadcrumb navigation back to agents list
 * - AI loading indicator in header
 * - Full-screen layout
 * - Consistent diff highlighting and streaming behavior
 */

import "@copilotkit/react-ui/styles.css";
import "./style.css";
import "@saas/projects/components/DocumentEditor.css";

import { CopilotKit, useCopilotChat } from "@copilotkit/react-core";
import { AgentErrorBoundary } from "@saas/agents/components/AgentErrorBoundary";
import { DocumentGeneratorEditor } from "@saas/agents/components/DocumentGeneratorEditor";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { AiGeneratingIndicator } from "@saas/shared/components/AiGeneratingIndicator";
import {
	AI_SIDEBAR_CONTENT_SHIFT_CLASS,
	useAiSidebarExpanded,
} from "@saas/shared/components/copilot/ai-sidebar-layout";
import { CopilotChatSessionProvider } from "@saas/shared/components/copilot/CopilotChatSessionProvider";
import { useCopilotErrorHandler } from "@saas/shared/components/copilot/use-copilot-error-handler";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { useFullscreen } from "@saas/shared/contexts/FullscreenContext";
import { useCallback, useEffect, useState } from "react";

// Inner component that syncs CopilotKit loading state to parent via callback
function AiLoadingSync({
	children,
	onLoadingChange,
}: {
	children: React.ReactNode;
	onLoadingChange: (loading: boolean) => void;
}) {
	const { isLoading } = useCopilotChat();

	useEffect(() => {
		onLoadingChange(isLoading);
	}, [isLoading, onLoadingChange]);

	return <>{children}</>;
}

export default function DocumentGeneratorPage() {
	const { organizationId, organizationName, basePath } =
		useOrganizationContext();
	const { setIsFullscreen } = useFullscreen();
	const onError = useCopilotErrorHandler();
	// Always organization-scoped now that this page only exists under a slug.
	const runtimeUrl = `/api/copilotkit?organizationId=${organizationId}`;

	// AI loading state - shared with CopilotKit child via callback
	const [isAiLoading, setIsAiLoading] = useState(false);

	// Memoize the callback to prevent unnecessary re-renders
	const handleAiLoadingChange = useCallback((loading: boolean) => {
		setIsAiLoading(loading);
	}, []);

	// Track whether the CopilotKit chat sidebar is expanded so the whole page
	// chrome (breadcrumb + editor) shifts to make room for it — otherwise the
	// full-width editor renders under the fixed panel and the sticky toolbar
	// (z-40) bleeds through its top. Seeded `true` because the editor below
	// mounts with `defaultOpen`, so the chat is expanded from the first paint
	// (seeding `false` would flash the un-shifted layout for one frame).
	const isAiSidebarExpanded = useAiSidebarExpanded(true);

	// Set fullscreen mode on mount, reset on unmount
	useEffect(() => {
		setIsFullscreen(true);
		return () => {
			setIsFullscreen(false);
		};
	}, [setIsFullscreen]);

	const breadcrumbItems = [
		{ label: organizationName ?? "Organization", href: basePath },
		{ label: "Agents", href: `${basePath}/agents` },
		{ label: "Document Generator" },
	];

	return (
		<div
			className={`fixed inset-y-0 left-0 right-0 md:left-[72px] bg-background transition-[right] duration-300 ${
				isAiSidebarExpanded ? AI_SIDEBAR_CONTENT_SHIFT_CLASS : ""
			}`}
		>
			{/* Breadcrumbs - Compact header with AI indicator */}
			<div className="flex items-center justify-between px-6 py-2.5 border-b bg-background">
				<PageBreadcrumbs items={breadcrumbItems} />
				{/* AI Loading Indicator */}
				{isAiLoading && <AiGeneratingIndicator />}
			</div>

			{/* Content - Full height */}
			<div className="h-[calc(100vh-53px)]">
				<AgentErrorBoundary>
					<CopilotKit
						runtimeUrl={runtimeUrl}
						useSingleEndpoint
						showDevConsole={false}
						agent="document_generator"
						onError={onError}
					>
						<CopilotChatSessionProvider>
							<AiLoadingSync
								onLoadingChange={handleAiLoadingChange}
							>
								<DocumentGeneratorEditor
									agentId="document_generator"
									title="AI Assistant"
									initialMessage="Hi! I can help you write and edit documents. Try asking me to:\n\n• Write a story or document\n• Expand a specific section\n• Add more details\n• Refine the language"
									suggestions={[
										{
											title: "Write a pirate story",
											message:
												"Please write a story about a pirate named Candy Beard.",
										},
										{
											title: "Write a mermaid story",
											message:
												"Please write a story about a mermaid named Luna.",
										},
										{
											title: "Add character",
											message:
												"Please add a character named Courage.",
										},
									]}
								/>
							</AiLoadingSync>
						</CopilotChatSessionProvider>
					</CopilotKit>
				</AgentErrorBoundary>
			</div>
		</div>
	);
}
