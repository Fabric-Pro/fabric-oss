"use client";

import type { Editor } from "@tiptap/react";
import { Button } from "@ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import {
	Bold,
	Code,
	Highlighter,
	Italic,
	Sparkles,
	Strikethrough,
	Underline,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

interface EditorBubbleMenuProps {
	editor: Editor;
	onAIAssist?: () => void;
}

export function EditorBubbleMenu({
	editor,
	onAIAssist,
}: EditorBubbleMenuProps) {
	const t = useTranslations("tooltips.documentEditor");
	const [show, setShow] = useState(false);
	const [position, setPosition] = useState({ top: 0, left: 0 });
	const menuRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const updateMenu = () => {
			const { selection } = editor.state;
			const { from, to } = selection;

			// Only show menu when text is selected
			if (from === to) {
				setShow(false);
				return;
			}

			// Get selection coordinates
			const start = editor.view.coordsAtPos(from);
			const end = editor.view.coordsAtPos(to);

			const menuWidth = menuRef.current?.offsetWidth || 0;
			const top = start.top - 50; // Position above selection
			const left = (start.left + end.left) / 2 - menuWidth / 2;

			setPosition({ top, left });
			setShow(true);
		};

		editor.on("selectionUpdate", updateMenu);
		editor.on("transaction", updateMenu);

		return () => {
			editor.off("selectionUpdate", updateMenu);
			editor.off("transaction", updateMenu);
		};
	}, [editor]);

	if (!show) {
		return null;
	}

	return (
		<div
			ref={menuRef}
			className="fixed z-50 bubble-menu bg-card border border-border rounded-lg shadow-lg flex items-center gap-1 p-1"
			style={{
				top: `${position.top}px`,
				left: `${position.left}px`,
			}}
		>
			{/* AI Assist Button */}
			{onAIAssist && (
				<>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="sm"
								onClick={onAIAssist}
								className="text-primary hover:text-primary"
								aria-label={t("bubbleMenuAiAssist")}
							>
								<Sparkles className="h-4 w-4" />
								<span className="ml-1 text-xs">AI</span>
							</Button>
						</TooltipTrigger>
						<TooltipContent>
							{t("bubbleMenuAiAssist")}
						</TooltipContent>
					</Tooltip>
					<div className="w-px h-4 bg-border" />
				</>
			)}

			{/* Text Formatting */}
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						variant={editor.isActive("bold") ? "default" : "ghost"}
						size="sm"
						onClick={() =>
							editor.chain().focus().toggleBold().run()
						}
						aria-label={t("bold")}
					>
						<Bold className="h-4 w-4" />
					</Button>
				</TooltipTrigger>
				<TooltipContent>{t("bold")}</TooltipContent>
			</Tooltip>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						variant={
							editor.isActive("italic") ? "default" : "ghost"
						}
						size="sm"
						onClick={() =>
							editor.chain().focus().toggleItalic().run()
						}
						aria-label={t("italic")}
					>
						<Italic className="h-4 w-4" />
					</Button>
				</TooltipTrigger>
				<TooltipContent>{t("italic")}</TooltipContent>
			</Tooltip>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						variant={
							editor.isActive("underline") ? "default" : "ghost"
						}
						size="sm"
						onClick={() =>
							editor.chain().focus().toggleUnderline().run()
						}
						aria-label={t("underline")}
					>
						<Underline className="h-4 w-4" />
					</Button>
				</TooltipTrigger>
				<TooltipContent>{t("underline")}</TooltipContent>
			</Tooltip>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						variant={
							editor.isActive("strike") ? "default" : "ghost"
						}
						size="sm"
						onClick={() =>
							editor.chain().focus().toggleStrike().run()
						}
						aria-label={t("strikethrough")}
					>
						<Strikethrough className="h-4 w-4" />
					</Button>
				</TooltipTrigger>
				<TooltipContent>{t("strikethrough")}</TooltipContent>
			</Tooltip>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						variant={editor.isActive("code") ? "default" : "ghost"}
						size="sm"
						onClick={() =>
							editor.chain().focus().toggleCode().run()
						}
						aria-label={t("inlineCode")}
					>
						<Code className="h-4 w-4" />
					</Button>
				</TooltipTrigger>
				<TooltipContent>{t("inlineCode")}</TooltipContent>
			</Tooltip>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						variant={
							editor.isActive("highlight") ? "default" : "ghost"
						}
						size="sm"
						onClick={() =>
							editor.chain().focus().toggleHighlight().run()
						}
						aria-label={t("highlight")}
					>
						<Highlighter className="h-4 w-4" />
					</Button>
				</TooltipTrigger>
				<TooltipContent>{t("highlight")}</TooltipContent>
			</Tooltip>
		</div>
	);
}
