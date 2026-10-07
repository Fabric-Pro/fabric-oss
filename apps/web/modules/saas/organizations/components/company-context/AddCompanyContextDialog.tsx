"use client";

import { ContextSourceSubmitFooter } from "@saas/context-sources/components/ContextSourceSubmitFooter";
import { FileSourceTabContent } from "@saas/context-sources/components/FileSourceTabContent";
import { TextSourceTabContent } from "@saas/context-sources/components/TextSourceTabContent";
import { UrlSourceTabContent } from "@saas/context-sources/components/UrlSourceTabContent";
import { useFileSourceForm } from "@saas/context-sources/hooks/use-file-source-form";
import { useTextSourceForm } from "@saas/context-sources/hooks/use-text-source-form";
import { useUrlSourceForm } from "@saas/context-sources/hooks/use-url-source-form";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { cn } from "@ui/lib";
import { FileIcon, LinkIcon, TextIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { type KeyboardEvent, useMemo, useRef, useState } from "react";
import { companyContextSubmitAdapter } from "./company-context-adapter";

const TABS = [
	{ id: "file", icon: FileIcon },
	{ id: "link", icon: LinkIcon },
	{ id: "text", icon: TextIcon },
] as const;

type TabId = (typeof TABS)[number]["id"];

type AddCompanyContextDialogProps = {
	organizationId: string;
	organizationSlug: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
};

/**
 * Add a source to the organization's company context (Fizzy #2719): a
 * file, a website (one URL or a bulk paste, with crawl scope and scheduled
 * refresh) or pasted text. The tab bodies and the footer are the project
 * Context tab's own (`@saas/context-sources`), driven here by the company
 * adapter, so formats, size limits and crawl options behave exactly as they do
 * for a project. Project-only extras — "Tag as Document", the readiness
 * category, the integration tabs — are not offered.
 *
 * Only admins and owners reach this dialog; the server refuses anyone else.
 */
export function AddCompanyContextDialog({
	organizationId,
	organizationSlug,
	open,
	onOpenChange,
}: AddCompanyContextDialogProps) {
	const t = useTranslations("settings.companyContext.addDialog");
	const [activeTab, setActiveTab] = useState<TabId>("file");
	const tabRefs = useRef<Record<TabId, HTMLButtonElement | null>>({
		file: null,
		link: null,
		text: null,
	});

	const adapter = useMemo(
		() => companyContextSubmitAdapter(organizationId),
		[organizationId],
	);

	// A submit that leaves nothing to review closes the dialog and starts the
	// next one from a clean form.
	const closeAndReset = () => {
		onOpenChange(false);
		resetForm();
	};

	const fileForm = useFileSourceForm({ adapter, onComplete: closeAndReset });
	const linkForm = useUrlSourceForm({
		adapter,
		open,
		organizationId,
		organizationSlug,
		// The category only feeds the project readiness checklist.
		requireKnowledgeBaseCategory: false,
		// Nothing re-fetches a company website when a Proposal or Business
		// Case retrieves it, so Live would behave as Once.
		allowLiveRefresh: false,
		onComplete: closeAndReset,
	});
	const textForm = useTextSourceForm({ adapter, onComplete: closeAndReset });

	const resetForm = () => {
		fileForm.reset();
		linkForm.reset();
		textForm.reset();
		setActiveTab("file");
	};

	const isLoading =
		fileForm.isLoading || linkForm.isLoading || textForm.isLoading;

	// Arrow keys move between tabs, as the WAI-ARIA tabs pattern expects.
	const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
		const index = TABS.findIndex((tab) => tab.id === activeTab);
		let next: number | null = null;
		if (event.key === "ArrowRight") {
			next = (index + 1) % TABS.length;
		} else if (event.key === "ArrowLeft") {
			next = (index - 1 + TABS.length) % TABS.length;
		} else if (event.key === "Home") {
			next = 0;
		} else if (event.key === "End") {
			next = TABS.length - 1;
		}
		if (next === null) {
			return;
		}
		event.preventDefault();
		const nextId = TABS[next].id;
		setActiveTab(nextId);
		tabRefs.current[nextId]?.focus();
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				// Escape, the backdrop, and the built-in close button are their
				// own dismissal paths — Cancel being disabled does not cover
				// them. Letting one through mid-submit does not cancel the
				// in-flight upload/crawl/save; it leaves it running to
				// force-close and reset whatever the user reopens next
				// (mirrors CreateDocumentDialog.tsx).
				if (isLoading && !next) {
					return;
				}
				onOpenChange(next);
			}}
		>
			<DialogContent className="grid-cols-[minmax(0,1fr)] max-h-[90vh] max-w-2xl overflow-y-auto">
				<DialogHeader>
					<DialogTitle>{t("title")}</DialogTitle>
					<DialogDescription>{t("description")}</DialogDescription>
				</DialogHeader>

				{/* The shared tab bodies label their panels by these tab ids
				    (`context-tab-{file|link|text}`). */}
				<div
					className="flex items-center gap-1 rounded-xl border border-border bg-card p-1.5"
					role="tablist"
					aria-label={t("tabsLabel")}
				>
					{TABS.map((tab) => {
						const Icon = tab.icon;
						const isActive = activeTab === tab.id;
						return (
							<button
								key={tab.id}
								ref={(node) => {
									tabRefs.current[tab.id] = node;
								}}
								type="button"
								role="tab"
								id={`context-tab-${tab.id}`}
								aria-selected={isActive}
								aria-controls={`context-tabpanel-${tab.id}`}
								tabIndex={isActive ? 0 : -1}
								onClick={() => setActiveTab(tab.id)}
								onKeyDown={handleTabKeyDown}
								disabled={isLoading}
								className={cn(
									"flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2 font-medium text-sm transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring",
									isActive
										? "bg-accent text-foreground"
										: "text-muted-foreground hover:text-foreground",
									isLoading &&
										"cursor-not-allowed opacity-50",
								)}
							>
								<Icon
									className={cn(
										"size-4",
										isActive && "text-primary",
									)}
									aria-hidden="true"
								/>
								<span>{t(`tabs.${tab.id}`)}</span>
							</button>
						);
					})}
				</div>

				<div className="mt-2">
					{activeTab === "file" && (
						<FileSourceTabContent
							form={fileForm}
							isLoading={isLoading}
						/>
					)}
					{activeTab === "link" && (
						<UrlSourceTabContent
							form={linkForm}
							isLoading={isLoading}
						/>
					)}
					{activeTab === "text" && (
						<TextSourceTabContent
							form={textForm}
							isLoading={isLoading}
						/>
					)}
				</div>

				<ContextSourceSubmitFooter
					tab={activeTab}
					file={fileForm}
					link={linkForm}
					text={textForm}
					isLoading={isLoading}
					onCancel={() => onOpenChange(false)}
				/>
			</DialogContent>
		</Dialog>
	);
}
