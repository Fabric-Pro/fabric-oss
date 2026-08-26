"use client";

import { useRouteProjectId } from "@saas/projects/hooks/use-route-project-id";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ExcalidrawCanvas } from "./ExcalidrawCanvas";

type ExcalidrawElement = Record<string, unknown>;

interface ExcalidrawEditorProps {
	elements: ExcalidrawElement[];
	appState?: Record<string, unknown>;
	onClose: () => void;
	checkpointId?: string | null;
	configId?: string | null;
	organizationId?: string | null;
	onElementsChange?: (elements: ExcalidrawElement[]) => void;
}

/**
 * Fullscreen Excalidraw modal — opened from the inline preview or the
 * diagrams list. Owns the save-to-checkpoint loop and the page chrome; the
 * canvas rendering itself is delegated to `ExcalidrawCanvas` so this view,
 * the inline preview, and any future Excalidraw surfaces all render scenes
 * the same way.
 */
export function ExcalidrawEditor({
	elements,
	appState,
	onClose,
	checkpointId,
	configId,
	organizationId,
	onElementsChange,
}: ExcalidrawEditorProps) {
	const latestElementsRef = useRef<ExcalidrawElement[]>(elements);
	const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [saveStatus, setSaveStatus] = useState<
		"idle" | "saving" | "saved" | "error"
	>("idle");
	// Read-only mode write-gate — save_checkpoint is a diagram
	// write; pass the owning project so it is blocked while read-only.
	const projectId = useRouteProjectId();

	const saveToCheckpoint = useCallback(
		async (els: ExcalidrawElement[]) => {
			if (!checkpointId || !configId) {
				return;
			}
			setSaveStatus("saving");
			try {
				const response = await fetch("/api/mcp-app/call-tool", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						configId,
						toolName: "save_checkpoint",
						args: {
							id: checkpointId,
							data: JSON.stringify({ elements: els }),
						},
						organizationId,
						projectId,
					}),
				});
				setSaveStatus(response.ok ? "saved" : "error");
			} catch {
				setSaveStatus("error");
			}
		},
		[checkpointId, configId, organizationId, projectId],
	);

	const handleChange = useCallback(
		(els: ExcalidrawElement[]) => {
			latestElementsRef.current = els;
			// Debounce: edits often arrive at 60fps during a drag; waiting 2s
			// turns a stroke into a single save instead of dozens.
			if (saveTimerRef.current) {
				clearTimeout(saveTimerRef.current);
			}
			setSaveStatus("idle");
			saveTimerRef.current = setTimeout(() => {
				saveToCheckpoint(els);
			}, 2000);
		},
		[saveToCheckpoint],
	);

	const handleClose = useCallback(async () => {
		if (saveTimerRef.current) {
			clearTimeout(saveTimerRef.current);
			saveTimerRef.current = null;
			// Flush any pending change immediately so the user doesn't lose
			// edits made in the last 2s before closing. AWAIT the save so
			// the preview's checkpoint refetch (triggered by `onClose`)
			// reads the just-saved scene instead of racing the in-flight
			// save and returning the stale pre-edit version. Save status
			// in the header ("Saving…" → "✓ Saved") gives the user feedback
			// during the brief delay.
			if (checkpointId && configId) {
				await saveToCheckpoint(latestElementsRef.current);
			}
		}
		onElementsChange?.(latestElementsRef.current);
		onClose();
	}, [onClose, onElementsChange, checkpointId, configId, saveToCheckpoint]);

	useEffect(() => {
		return () => {
			if (saveTimerRef.current) {
				clearTimeout(saveTimerRef.current);
			}
		};
	}, []);

	// Portal to document.body — escapes parent overflow:hidden and z-index
	// stacking contexts (the chat surface clips its own content).
	return createPortal(
		<div
			style={{
				position: "fixed",
				inset: 0,
				zIndex: 99999,
				display: "flex",
				flexDirection: "column",
				background: "#ffffff",
				width: "100vw",
				height: "100vh",
			}}
		>
			{/* Header */}
			<div
				style={{
					display: "flex",
					height: 40,
					flexShrink: 0,
					alignItems: "center",
					justifyContent: "space-between",
					borderBottom: "1px solid #e5e5e5",
					padding: "0 16px",
					background: "#fff",
					zIndex: 10,
				}}
			>
				<div style={{ display: "flex", alignItems: "center", gap: 12 }}>
					<span
						style={{
							fontWeight: 600,
							color: "#1a1a1a",
							fontSize: 14,
						}}
					>
						Excalidraw
					</span>
					{checkpointId && (
						<span
							style={{
								fontSize: 12,
								fontWeight: 500,
								color:
									saveStatus === "saved"
										? "#22c55e"
										: saveStatus === "saving"
											? "#f59e0b"
											: saveStatus === "error"
												? "#ef4444"
												: "#999",
							}}
						>
							{saveStatus === "saved" && "✓ Saved"}
							{saveStatus === "saving" && "Saving..."}
							{saveStatus === "error" && "Save failed"}
						</span>
					)}
				</div>
				<button
					type="button"
					onClick={handleClose}
					style={{
						fontSize: 13,
						color: "#666",
						background: "none",
						border: "1px solid transparent",
						borderRadius: 6,
						padding: "4px 10px",
						cursor: "pointer",
					}}
					onMouseOver={(e) => {
						e.currentTarget.style.background = "#f5f5f5";
						e.currentTarget.style.borderColor = "#e5e5e5";
					}}
					onFocus={(e) => {
						e.currentTarget.style.background = "#f5f5f5";
						e.currentTarget.style.borderColor = "#e5e5e5";
					}}
					onMouseOut={(e) => {
						e.currentTarget.style.background = "none";
						e.currentTarget.style.borderColor = "transparent";
					}}
					onBlur={(e) => {
						e.currentTarget.style.background = "none";
						e.currentTarget.style.borderColor = "transparent";
					}}
				>
					← Back to chat
				</button>
			</div>

			{/* Canvas — owned by ExcalidrawCanvas so element conversion, font
			    settling, and auto-fit are shared with the inline preview. */}
			<div style={{ flex: 1, position: "relative", minHeight: 0 }}>
				<ExcalidrawCanvas
					elements={elements}
					appState={appState}
					onChange={handleChange}
					theme="light"
				/>
			</div>
		</div>,
		document.body,
	);
}
