"use client";

/**
 * `ChatMessageInsertDiagramButton` -- the per-chat-message control row
 * rendered adjacent to each `<McpAppFrame>` Excalidraw canvas across the
 * four chat surfaces.
 *
 * Spec sections:
 *   - § 8     UI components + render contract
 *   - § 8.2   Button state machine
 *   - § 8.5   Sonner success toast
 *   - § 11    Error matrix
 *   - § 12    Telemetry events
 *   - § 14.1  Accessibility -- button label, focus ring, motion-safe
 *   - § 14.2  Copy embed code button -- aria-label, checkmark fade
 *   - § 14.5  Inline banner (delegated to ChatMessageDiagramErrorBanner)
 *   - § 14.6  Theme parity (no hardcoded hex)
 *   - § 14.7  i18n keys
 *   - § 15    Performance -- memo on chatMessageId + checkpointId + configId
 *   - § FR-1, FR-4, FR-6, FR-8, FR-9, FR-10, FR-11, FR-13, FR-14
 *
 * Render decision matrix:
 *   - personal scope                 -> render nothing (FR-13)
 *   - checkpointId / configId absent -> render nothing (matrix row 7)
 *   - cross-project mismatch         -> disabled + tooltip (FR-6)
 *   - no edit permission on target   -> disabled + tooltip + "Save to Diagrams"
 *                                       secondary (FR-8)
 *   - all clear                      -> active button + Copy embed code
 *
 * Telemetry contract -- the BLOCKED telemetry events fire once per
 * render path so the staged-rollout dashboards can size
 * demand for the picker + permission-fallback paths.
 *
 * Design tokens only -- no hardcoded hex, no glassmorphism, no
 * `transition-all`, no `group-hover:scale-110`. The active "Inserting…"
 * spinner is wrapped in `motion-safe:` Tailwind variants so it respects
 * `prefers-reduced-motion`. All strings flow through next-intl from
 * the namespaces declared in D5.
 */

import { useAnalytics } from "@analytics";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { Button } from "@ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { CheckIcon, ClipboardIcon, ExternalLinkIcon } from "lucide-react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatMessageDiagramErrorBanner } from "./ChatMessageDiagramErrorBanner";
import type { PickerPick } from "./InsertDiagramPickerDialog";
import { writePickerIntent } from "./pickerHandoff";
import type { BlockedReason, ChatSurface, ResolverTarget } from "./types";
import type { UseActiveTipTapEditorOptions } from "./useActiveTipTapEditor";
import type { ChatScope } from "./useChatScopedProject";
import type { InsertDiagramToolResult } from "./useInsertDiagramAction";
import { useInsertDiagramAction } from "./useInsertDiagramAction";

/**
 * Lazy-load the picker dialog. Without `next/dynamic`, the
 * shadcn Dialog + Tabs + ScrollArea bundle ships with every chat-message
 * render -- a real perf bug because most chat messages never open the
 * picker. `ssr: false` because the dialog is client-only (sessionStorage,
 * focus management, etc.).
 */
const InsertDiagramPickerDialog = dynamic(
	() =>
		import("./InsertDiagramPickerDialog").then(
			(m) => m.InsertDiagramPickerDialog,
		),
	{ ssr: false, loading: () => null },
);

/**
 * Public props for the chat-message button row. The four chat-surface
 * wirings (F1-F4) feed these from their own context adapters.
 */
export interface ChatMessageInsertDiagramButtonProps {
	/** Chat surface that owns this message. Used for telemetry. */
	surface: ChatSurface;
	/** Stable message id (idempotency key, memo key, telemetry sourceMessageId). */
	chatMessageId: string;
	/** Raw envelope from the MCP `create_view` tool result. */
	toolResult: InsertDiagramToolResult;
	/**
	 * @deprecated The env-var feature flag was removed before merge; the
	 * feature ships globally on. This prop is retained for backwards
	 * compatibility with the per-surface wirings (F1-F4) so removing the
	 * gate doesn't churn four call sites. Safe to drop in a follow-up.
	 */
	organizationSlug?: string | null;
	/**
	 * Project name of the chat scope -- used inside the cross-project
	 * tooltip per spec FR-6 ("Chat is scoped to {projectName}; ..."). The
	 * caller resolves it from `projects.get` and passes it down so this
	 * component remains free of additional oRPC queries.
	 */
	chatScopeProjectName?: string | null;
	/** The chat scope derived from the per-surface adapter (C1). */
	chatScope: ChatScope;
	/** The resolver inputs -- passed through to the resolver hook (C2). */
	resolverOptions: UseActiveTipTapEditorOptions;
	/** Result of running the resolver on the surface (C2). */
	resolverTarget: ResolverTarget | null;
	/** Derived diagram title (FR-3) -- per-message + per-chat. */
	title: string;
	/** Whether the active editor's project allows the current user to edit. */
	canEditTargetProject?: boolean;
	/** Whether the chat-scoped project allows the current user to create diagrams. */
	canCreateDiagramsInChatScope?: boolean;
	/**
	 * Optional override for the picker-open handler. When the resolver
	 * returns null AND the chat is in org scope, clicking the button
	 * should open the picker dialog (E1/E2). The button delegates the
	 * concrete open mechanism to the parent so this component stays
	 * decoupled from `next/router` and the dialog implementation.
	 */
	onOpenPicker?: () => void;
	/**
	 * Optional handler for the "Save to Diagrams" secondary action
	 * (FR-8). When provided, the disabled-no-edit-permission row
	 * surfaces this fallback. When omitted, the secondary action is
	 * not rendered.
	 */
	onSaveToDiagrams?: () => void;
}

// ---------------------------------------------------------------------------
// Implementation (unmemoised). Wrap-with-memo happens at the export.
// ---------------------------------------------------------------------------

function ChatMessageInsertDiagramButtonImpl(
	props: ChatMessageInsertDiagramButtonProps,
): JSX.Element | null {
	const {
		surface,
		chatMessageId,
		toolResult,
		chatScopeProjectName,
		chatScope,
		resolverTarget,
		title,
		canEditTargetProject = true,
		canCreateDiagramsInChatScope = true,
		onOpenPicker,
		onSaveToDiagrams,
	} = props;

	const t = useTranslations("diagrams.autoInsert");
	const tTip = useTranslations("tooltips.diagrams");
	const { trackEvent } = useAnalytics();

	// ----- Render-decision branches per spec § 8 / matrix § 11 ------------
	// 1. Hide entirely under personal scope (FR-13).
	// 2. Hide when the tool result is still streaming partials (matrix row 7).
	const isPersonalScope = !chatScope.organizationId;
	const missingMcpHandles =
		!toolResult.checkpointId || !toolResult.mcpConfigId;

	// 3. Render only in the in-editor AI Assistant surfaces (in-document /
	//    in-feature). The standalone `nexus` / `loom` chats are not
	//    project-scoped by default, so the "Open a document to insert" picker
	//    can't resolve a target (`chatScope.projectId` is null) and the button
	//    becomes a dead-end. Product decision: keep the insert affordance only
	//    in the AI Assistant, where the chat is project-scoped and a target
	//    editor resolves.
	const isEditorAssistantSurface =
		surface === "in-document" || surface === "in-feature";

	// Determine blocking reason (cross_project / no_edit_permission)
	// for disabled-state branches when the resolver did find a target.
	// Computed BEFORE the conditional return so the effect below sees a
	// stable dep list regardless of whether the early return fires.
	const computedBlockedReason: BlockedReason | undefined = useMemo(() => {
		if (
			resolverTarget &&
			chatScope.projectId &&
			resolverTarget.projectId !== chatScope.projectId
		) {
			return "cross_project";
		}
		if (resolverTarget && !canEditTargetProject) {
			return "no_edit_permission";
		}
		return undefined;
	}, [resolverTarget, chatScope.projectId, canEditTargetProject]);

	// Single blocked-telemetry effect for the three remaining blocked reasons
	// (personal_scope + cross_project + no_edit_permission). Fires once per
	// session per reason. We use a ref so the debounce survives re-renders
	// without exposing global state. The `flag_off` reason was removed when
	// the env-var feature flag was dropped before merge — the feature ships
	// globally on.
	const blockedReportedRef = useRef<Set<BlockedReason>>(new Set());
	useEffect(() => {
		const reasons: BlockedReason[] = [];
		if (isPersonalScope) {
			reasons.push("personal_scope");
		}
		if (computedBlockedReason) {
			reasons.push(computedBlockedReason);
		}
		for (const reason of reasons) {
			if (blockedReportedRef.current.has(reason)) {
				continue;
			}
			blockedReportedRef.current.add(reason);
			trackEvent("diagram_auto_insert_blocked", {
				surface,
				reason,
			});
		}
	}, [isPersonalScope, computedBlockedReason, surface, trackEvent]);

	// Render-decision short-circuits AFTER hooks have run.
	if (isPersonalScope || missingMcpHandles || !isEditorAssistantSurface) {
		return null;
	}

	return (
		<ChatMessageInsertDiagramButtonBody
			t={t}
			tTip={tTip}
			surface={surface}
			chatMessageId={chatMessageId}
			toolResult={toolResult}
			chatScope={chatScope}
			chatScopeProjectName={chatScopeProjectName}
			resolverTarget={resolverTarget}
			title={title}
			canCreateDiagramsInChatScope={canCreateDiagramsInChatScope}
			computedBlockedReason={computedBlockedReason}
			onOpenPicker={onOpenPicker}
			onSaveToDiagrams={onSaveToDiagrams}
		/>
	);
}

// ---------------------------------------------------------------------------
// The body component -- separates the render-decision branches above
// from the active-button paths so the hooks below only mount when the
// feature is actually live.
// ---------------------------------------------------------------------------

interface BodyProps {
	t: ReturnType<typeof useTranslations>;
	tTip: ReturnType<typeof useTranslations>;
	surface: ChatSurface;
	chatMessageId: string;
	toolResult: InsertDiagramToolResult;
	chatScope: ChatScope;
	chatScopeProjectName?: string | null;
	resolverTarget: ResolverTarget | null;
	title: string;
	canCreateDiagramsInChatScope: boolean;
	computedBlockedReason?: BlockedReason;
	onOpenPicker?: () => void;
	onSaveToDiagrams?: () => void;
}

function ChatMessageInsertDiagramButtonBody({
	t,
	tTip,
	surface,
	chatMessageId,
	toolResult,
	chatScope,
	chatScopeProjectName,
	resolverTarget,
	title,
	canCreateDiagramsInChatScope,
	computedBlockedReason,
	onOpenPicker,
	onSaveToDiagrams,
}: BodyProps): JSX.Element {
	const action = useInsertDiagramAction({
		surface,
		chatMessageId,
		projectId: chatScope.projectId,
		organizationId: chatScope.organizationId,
		title,
		resolverTarget,
		toolResult,
		blockedReason: computedBlockedReason,
	});

	const [showCopyConfirm, setShowCopyConfirm] = useState<boolean>(false);
	const copyConfirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
		null,
	);
	useEffect(() => {
		return () => {
			if (copyConfirmTimerRef.current) {
				clearTimeout(copyConfirmTimerRef.current);
			}
		};
	}, []);

	// ----- Picker state (E2) --------------------------------------------
	// When the resolver returns null AND the chat is in org scope, the
	// button label flips to "Open a document to insert" and clicking
	// opens the lazy-loaded picker dialog. The parent can override the
	// open mechanism by passing `onOpenPicker`; otherwise we manage the
	// dialog state here.
	const [pickerOpen, setPickerOpen] = useState<boolean>(false);
	const router = useRouter();
	const { basePath, organizationSlug: activeOrgSlug } =
		useOrganizationContext();

	const handleOpenPicker = useCallback(() => {
		if (onOpenPicker) {
			onOpenPicker();
			return;
		}
		setPickerOpen(true);
	}, [onOpenPicker]);

	const handlePickerPick = useCallback(
		(pick: PickerPick) => {
			// Spec § 10.4 -- sessionStorage handoff. Generate the request id
			// here so we can include it in BOTH the persisted intent AND
			// the destination route (defensive against router races).
			const projectId = chatScope.projectId;
			const organizationId = chatScope.organizationId;
			if (!projectId || !organizationId) {
				return;
			}

			const diagramRequestId =
				typeof crypto !== "undefined" &&
				typeof crypto.randomUUID === "function"
					? crypto.randomUUID()
					: `diagram_intent_${Date.now()}_${Math.random().toString(36).slice(2)}`;

			writePickerIntent({
				diagramRequestId,
				surface,
				projectId,
				organizationId,
				elements: toolResult.elements,
				appState: toolResult.appState,
				checkpointId: toolResult.checkpointId,
				mcpConfigId: toolResult.mcpConfigId,
				title,
				targetKind: pick.kind === "feature" ? "story" : "document",
				targetId: pick.id,
				createdAt: Date.now(),
			});

			// Build the destination route. `basePath` is `/app/<slug>` for
			// org scope (always set here because we early-return above on
			// `organizationId === null`). Mirrors the canonical pattern
			// from `StoriesRoadmap.tsx:1065` + `ProjectPipeline.tsx:843`.
			const slug = activeOrgSlug ?? "";
			const routeBase = slug ? `/app/${slug}` : basePath;
			const route =
				pick.kind === "document"
					? `${routeBase}/projects/${projectId}/documents/${pick.id}`
					: `${routeBase}/projects/${projectId}/stories/${pick.id}`;
			router.push(route);
		},
		[
			activeOrgSlug,
			basePath,
			chatScope.organizationId,
			chatScope.projectId,
			router,
			surface,
			title,
			toolResult.appState,
			toolResult.checkpointId,
			toolResult.elements,
			toolResult.mcpConfigId,
		],
	);
	const handleCopyClick = async () => {
		await action.copyEmbedCode();
		// On success path, swap to the checkmark for 2 seconds with a
		// motion-safe fade. On failure the hook surfaces
		// its own toast -- the icon stays at the clipboard glyph so the
		// user doesn't perceive a false confirmation.
		setShowCopyConfirm(true);
		if (copyConfirmTimerRef.current) {
			clearTimeout(copyConfirmTimerRef.current);
		}
		copyConfirmTimerRef.current = setTimeout(() => {
			setShowCopyConfirm(false);
		}, 2000);
	};

	// Cannot create diagrams at all -> both actions disabled with the
	// FR-8 fallback tooltip ("You can't create diagrams in this project").
	if (!canCreateDiagramsInChatScope) {
		return (
			<div
				className="flex items-center gap-2"
				data-slot="excalidraw-auto-insert-row"
			>
				<DisabledButtonWithTooltip
					label={t("insertButton", {
						docName: resolverTarget?.documentLabel ?? "",
					})}
					tooltip={tTip("insertNoCreatePermission")}
				/>
			</div>
		);
	}

	// Cross-project mismatch (FR-6) -- disabled with informational tooltip
	// scoped to the chat project name.
	if (computedBlockedReason === "cross_project") {
		const docName = resolverTarget?.documentLabel ?? "";
		return (
			<div
				className="flex items-center gap-2"
				data-slot="excalidraw-auto-insert-row"
			>
				<DisabledButtonWithTooltip
					label={t("insertButton", { docName })}
					tooltip={tTip("insertCrossProject", {
						projectName:
							chatScopeProjectName ??
							chatScope.projectId ??
							"this chat's project",
					})}
				/>
				<CopyEmbedCodeButton
					t={t}
					tTip={tTip}
					showConfirm={showCopyConfirm}
					onClick={handleCopyClick}
				/>
			</div>
		);
	}

	// No edit permission on the target editor's project (FR-8) -- disabled
	// + visible Save-to-Diagrams secondary action.
	if (computedBlockedReason === "no_edit_permission") {
		const docName = resolverTarget?.documentLabel ?? "";
		return (
			<div
				className="flex items-center gap-2"
				data-slot="excalidraw-auto-insert-row"
			>
				<DisabledButtonWithTooltip
					label={t("insertButton", { docName })}
					tooltip={tTip("insertNoPermission", { docName })}
				/>
				{onSaveToDiagrams ? (
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={onSaveToDiagrams}
					>
						{t("saveToDiagramsButton")}
					</Button>
				) : null}
				<CopyEmbedCodeButton
					t={t}
					tTip={tTip}
					showConfirm={showCopyConfirm}
					onClick={handleCopyClick}
				/>
			</div>
		);
	}

	// Error-state branch -- the Diagram row exists, the editor leg failed.
	// Render the banner instead of the button so the user sees the FR-10
	// message + Retry inline. The Copy embed code button stays available
	// as the universal fallback.
	if (action.status === "error") {
		return (
			<div
				className="flex flex-col gap-2"
				data-slot="excalidraw-auto-insert-row"
			>
				<ChatMessageDiagramErrorBanner
					docName={resolverTarget?.documentLabel ?? ""}
					projectName={
						chatScopeProjectName ?? chatScope.projectId ?? ""
					}
					onRetry={() => {
						void action.retry();
					}}
				/>
				<CopyEmbedCodeButton
					t={t}
					tTip={tTip}
					showConfirm={showCopyConfirm}
					onClick={handleCopyClick}
				/>
			</div>
		);
	}

	// Active "Insert" / "Open a document to insert" branch.
	// Picker path: no resolver target AND we have an org-scoped chat
	// (already guaranteed by isPersonalScope guard above).
	const hasResolverTarget = !!resolverTarget;
	const docName = resolverTarget?.documentLabel ?? "";

	if (!hasResolverTarget) {
		return (
			<>
				<div
					className="flex items-center gap-2"
					data-slot="excalidraw-auto-insert-row"
				>
					<Button
						type="button"
						variant="default"
						size="sm"
						onClick={handleOpenPicker}
						aria-label={t("openPickerButton")}
					>
						{t("openPickerButton")}
					</Button>
					<CopyEmbedCodeButton
						t={t}
						tTip={tTip}
						showConfirm={showCopyConfirm}
						onClick={handleCopyClick}
					/>
				</div>
				{/*
				 * Picker is only rendered when `pickerOpen === true` so the
				 * `next/dynamic` bundle is fetched lazily.
				 * If the parent supplied `onOpenPicker`, we never set
				 * `pickerOpen` -- it stays false and the dialog never mounts.
				 */}
				{pickerOpen &&
				chatScope.projectId &&
				chatScope.organizationId ? (
					<InsertDiagramPickerDialog
						open={pickerOpen}
						onOpenChange={setPickerOpen}
						surface={surface}
						projectId={chatScope.projectId}
						organizationId={chatScope.organizationId}
						projectName={
							chatScopeProjectName ?? chatScope.projectId ?? ""
						}
						onPick={handlePickerPick}
					/>
				) : null}
			</>
		);
	}

	// Active button path. After successful insert it flips to "Inserted
	// into <Doc>" -- click re-runs FR-9 scroll/reinsert.
	const isInserted = action.status === "inserted";
	const isInserting = action.status === "inserting";
	const insertLabel = isInserted
		? t("insertedButton", { docName })
		: t("insertButton", { docName });

	return (
		<div
			className="flex items-center gap-2"
			data-slot="excalidraw-auto-insert-row"
		>
			<Button
				type="button"
				variant="default"
				size="sm"
				loading={isInserting}
				autoLoading={false}
				disabled={!action.enabled && !isInserted}
				onClick={() => {
					void action.click();
				}}
				aria-label={
					isInserted
						? `${insertLabel}`
						: `Insert this diagram into ${docName || "document"}`
				}
			>
				{isInserted ? (
					<>
						<ExternalLinkIcon className="size-3.5 motion-safe:transition-opacity motion-safe:duration-150" />
						{insertLabel}
					</>
				) : (
					insertLabel
				)}
			</Button>
			<CopyEmbedCodeButton
				t={t}
				tTip={tTip}
				showConfirm={showCopyConfirm}
				onClick={handleCopyClick}
			/>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Small leaves -- disabled-with-tooltip button, copy-embed-code button.
// ---------------------------------------------------------------------------

function DisabledButtonWithTooltip({
	label,
	tooltip,
}: {
	label: string;
	tooltip: string;
}): JSX.Element {
	// `disabled` on a real `<button>` swallows focus events; for the
	// tooltip to announce we wrap the button in a focusable `<span>` so
	// keyboard users still receive the message. shadcn `<Button>` keeps
	// its focus-visible ring via Radix.
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				{/* biome-ignore lint/a11y/noNoninteractiveTabindex: Radix Tooltip skips pointer events on disabled children -- the span wrapper must be focusable so keyboard users can discover the tooltip while the underlying Button stays semantically disabled. Mirrors PmSyncCloudToggle.tsx + CopilotSidebarInput.tsx precedent. */}
				<span tabIndex={0} className="inline-flex">
					<Button
						type="button"
						variant="default"
						size="sm"
						disabled
						aria-label={label}
					>
						{label}
					</Button>
				</span>
			</TooltipTrigger>
			<TooltipContent>{tooltip}</TooltipContent>
		</Tooltip>
	);
}

function CopyEmbedCodeButton({
	t,
	tTip,
	showConfirm,
	onClick,
}: {
	t: ReturnType<typeof useTranslations>;
	tTip: ReturnType<typeof useTranslations>;
	showConfirm: boolean;
	onClick: () => Promise<void>;
}): JSX.Element {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					onClick={() => {
						void onClick();
					}}
					aria-label="Copy <excalidraw-embed> markup to clipboard"
					data-slot="copy-embed-code"
				>
					{showConfirm ? (
						<CheckIcon
							className={cn(
								"size-3.5",
								// Motion-safe fade only -- spec § 14.2
								// explicitly forbids scale.
								"motion-safe:transition-opacity motion-safe:duration-150",
							)}
						/>
					) : (
						<ClipboardIcon
							className={cn(
								"size-3.5",
								"motion-safe:transition-opacity motion-safe:duration-150",
							)}
						/>
					)}
					{t("copyEmbedCodeButton")}
				</Button>
			</TooltipTrigger>
			<TooltipContent>{tTip("copyEmbedCode")}</TooltipContent>
		</Tooltip>
	);
}

// ---------------------------------------------------------------------------
// Memo wrapper (D3) -- spec § 15. Equality on chatMessageId +
// checkpointId + configId only. The other props churn on every parent
// render and would defeat the memo if they participated in comparison.
// ---------------------------------------------------------------------------

function arePropsEqual(
	prev: ChatMessageInsertDiagramButtonProps,
	next: ChatMessageInsertDiagramButtonProps,
): boolean {
	return (
		prev.chatMessageId === next.chatMessageId &&
		prev.toolResult.checkpointId === next.toolResult.checkpointId &&
		prev.toolResult.mcpConfigId === next.toolResult.mcpConfigId
	);
}

export const ChatMessageInsertDiagramButton = memo(
	ChatMessageInsertDiagramButtonImpl,
	arePropsEqual,
);
