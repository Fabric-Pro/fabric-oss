"use client";

import { validateImageFile } from "@saas/projects/lib/image-upload-utils";
import { DIAGRAM_TEMPLATES } from "@saas/projects/lib/mermaid-templates";
import type { Editor } from "@tiptap/react";
import { Button } from "@ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ui/components/popover";
import { Separator } from "@ui/components/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import {
	AlignCenter,
	AlignJustify,
	AlignLeft,
	AlignRight,
	Bold,
	CheckSquare,
	Code,
	GitBranch,
	Heading1,
	Heading2,
	Heading3,
	Highlighter,
	Image as ImageIcon,
	Italic,
	Link as LinkIcon,
	List,
	ListOrdered,
	Palette,
	Quote,
	Redo,
	Strikethrough,
	Table as TableIcon,
	Underline as UnderlineIcon,
	Undo,
	Upload,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";

/**
 * Swatch palettes carry a translation key for the colour name alongside the
 * hex. The hex alone is what the old native `title=` exposed — "#a855f7" tells
 * a reader nothing — so the tooltip and the accessible name are built from the
 * translated name instead. Keys resolve under `tooltips.editor.colors.*`.
 */
const TEXT_COLOR_SWATCHES = [
	{ value: "#000000", nameKey: "colors.black" },
	{ value: "#dc2626", nameKey: "colors.red" },
	{ value: "#ea580c", nameKey: "colors.orange" },
	{ value: "#facc15", nameKey: "colors.yellow" },
	{ value: "#22c55e", nameKey: "colors.green" },
	{ value: "#3b82f6", nameKey: "colors.blue" },
	{ value: "#a855f7", nameKey: "colors.purple" },
	{ value: "#ec4899", nameKey: "colors.pink" },
] as const;

const HIGHLIGHT_COLOR_SWATCHES = [
	{ value: "#fef08a", nameKey: "colors.yellow" },
	{ value: "#bfdbfe", nameKey: "colors.blue" },
	{ value: "#bbf7d0", nameKey: "colors.green" },
	{ value: "#fecaca", nameKey: "colors.red" },
	{ value: "#e9d5ff", nameKey: "colors.purple" },
	{ value: "#fbcfe8", nameKey: "colors.pink" },
] as const;

interface EditorToolbarProps {
	editor: Editor | null;
	onImageUpload?: (files: FileList) => Promise<void>;
}

export function EditorToolbar({ editor, onImageUpload }: EditorToolbarProps) {
	const t = useTranslations("tooltips.documentEditor");
	const tEditor = useTranslations("tooltips.editor");
	const [linkUrl, setLinkUrl] = useState("");
	const [imageUrl, setImageUrl] = useState("");
	const [uploadError, setUploadError] = useState<string | null>(null);
	const [imagePopoverOpen, setImagePopoverOpen] = useState(false);
	const fileInputRef = useRef<HTMLInputElement>(null);

	if (!editor) {
		return null;
	}

	const setLink = () => {
		if (linkUrl === "") {
			editor.chain().focus().extendMarkRange("link").unsetLink().run();
			return;
		}

		editor
			.chain()
			.focus()
			.extendMarkRange("link")
			.setLink({ href: linkUrl })
			.run();
		setLinkUrl("");
	};

	const addImage = () => {
		if (imageUrl) {
			editor.chain().focus().setImage({ src: imageUrl }).run();
			setImageUrl("");
			setImagePopoverOpen(false);
		}
	};

	const handleFileSelect = async (files: FileList | null) => {
		if (!files?.length) {
			return;
		}
		setUploadError(null);

		// Validate first
		for (const file of Array.from(files)) {
			const validation = validateImageFile(file);
			if (!validation.valid) {
				setUploadError(validation.error ?? "Invalid image file.");
				return;
			}
		}

		setImagePopoverOpen(false);

		// Use the S3 upload pipeline if available, otherwise fall back to base64
		if (onImageUpload) {
			try {
				await onImageUpload(files);
			} catch {
				setUploadError("Upload failed. Please try again.");
			}
		} else {
			// Fallback for contexts without S3 (e.g. standalone editor)
			for (const file of Array.from(files)) {
				const reader = new FileReader();
				reader.onload = () => {
					editor
						.chain()
						.focus()
						.setImage({ src: reader.result as string })
						.updateAttributes("image", { width: "50%" })
						.run();
				};
				reader.readAsDataURL(file);
			}
		}
	};

	return (
		<div className="border-b border-border bg-card/50 sticky top-0 z-40">
			<div className="flex flex-wrap items-center gap-1 p-2">
				{/* Undo/Redo */}
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => editor.chain().focus().undo().run()}
							disabled={!editor.can().undo()}
							aria-label={t("undo")}
						>
							<Undo className="h-4 w-4" />
						</Button>
					</TooltipTrigger>
					<TooltipContent>{t("undo")}</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => editor.chain().focus().redo().run()}
							disabled={!editor.can().redo()}
							aria-label={t("redo")}
						>
							<Redo className="h-4 w-4" />
						</Button>
					</TooltipTrigger>
					<TooltipContent>{t("redo")}</TooltipContent>
				</Tooltip>

				<Separator
					orientation="vertical"
					className="h-6 w-px bg-border mx-1"
				/>

				{/* Headings */}
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant={
								editor.isActive("heading", { level: 1 })
									? "default"
									: "ghost"
							}
							size="sm"
							onClick={() =>
								editor
									.chain()
									.focus()
									.toggleHeading({ level: 1 })
									.run()
							}
							aria-label={t("heading1")}
						>
							<Heading1 className="h-4 w-4" />
						</Button>
					</TooltipTrigger>
					<TooltipContent>{t("heading1")}</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant={
								editor.isActive("heading", { level: 2 })
									? "default"
									: "ghost"
							}
							size="sm"
							onClick={() =>
								editor
									.chain()
									.focus()
									.toggleHeading({ level: 2 })
									.run()
							}
							aria-label={t("heading2")}
						>
							<Heading2 className="h-4 w-4" />
						</Button>
					</TooltipTrigger>
					<TooltipContent>{t("heading2")}</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant={
								editor.isActive("heading", { level: 3 })
									? "default"
									: "ghost"
							}
							size="sm"
							onClick={() =>
								editor
									.chain()
									.focus()
									.toggleHeading({ level: 3 })
									.run()
							}
							aria-label={t("heading3")}
						>
							<Heading3 className="h-4 w-4" />
						</Button>
					</TooltipTrigger>
					<TooltipContent>{t("heading3")}</TooltipContent>
				</Tooltip>

				<Separator
					orientation="vertical"
					className="h-6 w-px bg-border mx-1"
				/>

				{/* Text Formatting */}
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant={
								editor.isActive("bold") ? "default" : "ghost"
							}
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
								editor.isActive("underline")
									? "default"
									: "ghost"
							}
							size="sm"
							onClick={() =>
								editor.chain().focus().toggleUnderline().run()
							}
							aria-label={t("underline")}
						>
							<UnderlineIcon className="h-4 w-4" />
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
							variant={
								editor.isActive("code") ? "default" : "ghost"
							}
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

				<Separator
					orientation="vertical"
					className="h-6 w-px bg-border mx-1"
				/>

				{/* Text Color */}
				<Popover>
					<Tooltip>
						<TooltipTrigger asChild>
							<PopoverTrigger asChild>
								<Button
									variant="ghost"
									size="sm"
									aria-label={t("textColor")}
								>
									<Palette className="h-4 w-4" />
								</Button>
							</PopoverTrigger>
						</TooltipTrigger>
						<TooltipContent>{t("textColor")}</TooltipContent>
					</Tooltip>
					<PopoverContent className="bg-card border border-border rounded-lg shadow-lg p-2 z-50">
						<div className="grid grid-cols-5 gap-1">
							{TEXT_COLOR_SWATCHES.map(({ value, nameKey }) => {
								const copy = tEditor("textColorSwatch", {
									color: tEditor(nameKey),
								});
								return (
									<Tooltip key={value}>
										<TooltipTrigger asChild>
											<button
												type="button"
												className="w-6 h-6 rounded border border-border hover:scale-110 transition-transform"
												style={{
													backgroundColor: value,
												}}
												onClick={() =>
													editor
														.chain()
														.focus()
														.setColor(value)
														.run()
												}
												aria-label={copy}
											/>
										</TooltipTrigger>
										<TooltipContent>{copy}</TooltipContent>
									</Tooltip>
								);
							})}
						</div>
					</PopoverContent>
				</Popover>

				{/* Highlight */}
				<Popover>
					<Tooltip>
						<TooltipTrigger asChild>
							<PopoverTrigger asChild>
								<Button
									variant={
										editor.isActive("highlight")
											? "default"
											: "ghost"
									}
									size="sm"
									aria-label={t("highlight")}
								>
									<Highlighter className="h-4 w-4" />
								</Button>
							</PopoverTrigger>
						</TooltipTrigger>
						<TooltipContent>{t("highlight")}</TooltipContent>
					</Tooltip>
					<PopoverContent className="bg-card border border-border rounded-lg shadow-lg p-2 z-50">
						<div className="grid grid-cols-5 gap-1">
							{HIGHLIGHT_COLOR_SWATCHES.map(
								({ value, nameKey }) => {
									const copy = tEditor(
										"highlightColorSwatch",
										{ color: tEditor(nameKey) },
									);
									return (
										<Tooltip key={value}>
											<TooltipTrigger asChild>
												<button
													type="button"
													className="w-6 h-6 rounded border border-border hover:scale-110 transition-transform"
													style={{
														backgroundColor: value,
													}}
													onClick={() =>
														editor
															.chain()
															.focus()
															.toggleHighlight({
																color: value,
															})
															.run()
													}
													aria-label={copy}
												/>
											</TooltipTrigger>
											<TooltipContent>
												{copy}
											</TooltipContent>
										</Tooltip>
									);
								},
							)}
						</div>
					</PopoverContent>
				</Popover>

				<Separator
					orientation="vertical"
					className="h-6 w-px bg-border mx-1"
				/>

				{/* Lists */}
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant={
								editor.isActive("bulletList")
									? "default"
									: "ghost"
							}
							size="sm"
							onClick={() =>
								editor.chain().focus().toggleBulletList().run()
							}
							aria-label={t("bulletList")}
						>
							<List className="h-4 w-4" />
						</Button>
					</TooltipTrigger>
					<TooltipContent>{t("bulletList")}</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant={
								editor.isActive("orderedList")
									? "default"
									: "ghost"
							}
							size="sm"
							onClick={() =>
								editor.chain().focus().toggleOrderedList().run()
							}
							aria-label={t("numberedList")}
						>
							<ListOrdered className="h-4 w-4" />
						</Button>
					</TooltipTrigger>
					<TooltipContent>{t("numberedList")}</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant={
								editor.isActive("taskList")
									? "default"
									: "ghost"
							}
							size="sm"
							onClick={() =>
								editor.chain().focus().toggleTaskList().run()
							}
							aria-label={t("taskList")}
						>
							<CheckSquare className="h-4 w-4" />
						</Button>
					</TooltipTrigger>
					<TooltipContent>{t("taskList")}</TooltipContent>
				</Tooltip>

				<Separator
					orientation="vertical"
					className="h-6 w-px bg-border mx-1"
				/>

				{/* Block Types */}
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant={
								editor.isActive("blockquote")
									? "default"
									: "ghost"
							}
							size="sm"
							onClick={() =>
								editor.chain().focus().toggleBlockquote().run()
							}
							aria-label={t("blockquote")}
						>
							<Quote className="h-4 w-4" />
						</Button>
					</TooltipTrigger>
					<TooltipContent>{t("blockquote")}</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant={
								editor.isActive("codeBlock")
									? "default"
									: "ghost"
							}
							size="sm"
							onClick={() =>
								editor.chain().focus().toggleCodeBlock().run()
							}
							aria-label={t("codeBlock")}
						>
							<Code className="h-4 w-4" />
						</Button>
					</TooltipTrigger>
					<TooltipContent>{t("codeBlock")}</TooltipContent>
				</Tooltip>

				{/* Diagram Dropdown */}
				<DropdownMenu>
					<Tooltip>
						<TooltipTrigger asChild>
							<DropdownMenuTrigger asChild>
								<Button
									variant="ghost"
									size="sm"
									aria-label={t("insertDiagram")}
								>
									<GitBranch className="h-4 w-4" />
								</Button>
							</DropdownMenuTrigger>
						</TooltipTrigger>
						<TooltipContent>{t("insertDiagram")}</TooltipContent>
					</Tooltip>
					<DropdownMenuContent align="start" className="w-64">
						{DIAGRAM_TEMPLATES.map((tpl) => {
							const Icon = tpl.icon;
							return (
								<DropdownMenuItem
									key={tpl.id}
									onClick={() => {
										editor
											.chain()
											.focus()
											.insertContent({
												type: "mermaidBlock",
												attrs:
													tpl.id === "empty"
														? {}
														: {
																diagramType:
																	tpl.id,
															},
												content: [
													{
														type: "text",
														text: tpl.template,
													},
												],
											})
											.run();
									}}
								>
									<Icon className="mr-2 h-4 w-4" />
									<div className="flex flex-col">
										<span className="text-sm">
											{tpl.title}
										</span>
										<span className="text-xs text-muted-foreground">
											{tpl.description}
										</span>
									</div>
								</DropdownMenuItem>
							);
						})}
					</DropdownMenuContent>
				</DropdownMenu>

				<Separator
					orientation="vertical"
					className="h-6 w-px bg-border mx-1"
				/>

				{/* Alignment */}
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant={
								editor.isActive({ textAlign: "left" })
									? "default"
									: "ghost"
							}
							size="sm"
							onClick={() =>
								editor
									.chain()
									.focus()
									.setTextAlign("left")
									.run()
							}
							aria-label={t("alignLeft")}
						>
							<AlignLeft className="h-4 w-4" />
						</Button>
					</TooltipTrigger>
					<TooltipContent>{t("alignLeft")}</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant={
								editor.isActive({ textAlign: "center" })
									? "default"
									: "ghost"
							}
							size="sm"
							onClick={() =>
								editor
									.chain()
									.focus()
									.setTextAlign("center")
									.run()
							}
							aria-label={t("alignCenter")}
						>
							<AlignCenter className="h-4 w-4" />
						</Button>
					</TooltipTrigger>
					<TooltipContent>{t("alignCenter")}</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant={
								editor.isActive({ textAlign: "right" })
									? "default"
									: "ghost"
							}
							size="sm"
							onClick={() =>
								editor
									.chain()
									.focus()
									.setTextAlign("right")
									.run()
							}
							aria-label={t("alignRight")}
						>
							<AlignRight className="h-4 w-4" />
						</Button>
					</TooltipTrigger>
					<TooltipContent>{t("alignRight")}</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant={
								editor.isActive({ textAlign: "justify" })
									? "default"
									: "ghost"
							}
							size="sm"
							onClick={() =>
								editor
									.chain()
									.focus()
									.setTextAlign("justify")
									.run()
							}
							aria-label={t("justify")}
						>
							<AlignJustify className="h-4 w-4" />
						</Button>
					</TooltipTrigger>
					<TooltipContent>{t("justify")}</TooltipContent>
				</Tooltip>

				<Separator
					orientation="vertical"
					className="h-6 w-px bg-border mx-1"
				/>

				{/* Link */}
				<Popover>
					<Tooltip>
						<TooltipTrigger asChild>
							<PopoverTrigger asChild>
								<Button
									variant={
										editor.isActive("link")
											? "default"
											: "ghost"
									}
									size="sm"
									aria-label={t("link")}
								>
									<LinkIcon className="h-4 w-4" />
								</Button>
							</PopoverTrigger>
						</TooltipTrigger>
						<TooltipContent>{t("link")}</TooltipContent>
					</Tooltip>
					<PopoverContent className="bg-card border border-border rounded-lg shadow-lg p-3 z-50 w-80">
						<div className="space-y-2">
							<label
								htmlFor="toolbar-link-url"
								className="text-sm font-medium"
							>
								Enter URL
							</label>
							<input
								id="toolbar-link-url"
								type="url"
								value={linkUrl}
								onChange={(e) => setLinkUrl(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") {
										setLink();
									}
								}}
								placeholder="https://example.com"
								className="w-full px-2 py-1 text-sm border border-border rounded bg-background"
							/>
							<div className="flex gap-2">
								<Button size="sm" onClick={setLink}>
									Set Link
								</Button>
								{editor.isActive("link") && (
									<Button
										size="sm"
										variant="outline"
										onClick={() =>
											editor
												.chain()
												.focus()
												.unsetLink()
												.run()
										}
									>
										Remove Link
									</Button>
								)}
							</div>
						</div>
					</PopoverContent>
				</Popover>

				{/* Image */}
				<Popover
					open={imagePopoverOpen}
					onOpenChange={setImagePopoverOpen}
				>
					<Tooltip>
						<TooltipTrigger asChild>
							<PopoverTrigger asChild>
								<Button
									variant="ghost"
									size="sm"
									aria-label={t("image")}
								>
									<ImageIcon className="h-4 w-4" />
								</Button>
							</PopoverTrigger>
						</TooltipTrigger>
						<TooltipContent>{t("image")}</TooltipContent>
					</Tooltip>
					<PopoverContent className="bg-card border border-border rounded-lg shadow-lg p-3 z-50 w-80">
						<Tabs defaultValue="upload">
							<TabsList className="w-full">
								<TabsTrigger value="upload" className="flex-1">
									Upload
								</TabsTrigger>
								<TabsTrigger value="url" className="flex-1">
									URL
								</TabsTrigger>
							</TabsList>
							<TabsContent value="upload">
								<div className="space-y-3 pt-1">
									{/*
									 * `sr-only`, not `hidden` (= display:none).
									 * Chromium 124+ silently swallows the file
									 * picker on display:none inputs even when
									 * triggered by a real user-gesture click.
									 */}
									<input
										ref={fileInputRef}
										type="file"
										accept="image/png,image/jpeg,image/gif,image/webp"
										className="sr-only"
										aria-hidden="true"
										tabIndex={-1}
										onChange={(e) =>
											handleFileSelect(e.target.files)
										}
									/>
									<Button
										variant="outline"
										size="sm"
										className="w-full"
										onClick={() =>
											fileInputRef.current?.click()
										}
										aria-label="Browse files"
									>
										<Upload className="mr-2 h-4 w-4" />
										Browse files
									</Button>
									<p className="text-xs text-muted-foreground">
										PNG, JPG, GIF, WebP — max 5 MB
									</p>
									{uploadError && (
										<p
											className="text-xs text-destructive"
											role="alert"
										>
											{uploadError}
										</p>
									)}
								</div>
							</TabsContent>
							<TabsContent value="url">
								<div className="space-y-2 pt-1">
									<label
										htmlFor="toolbar-image-url"
										className="text-sm font-medium"
									>
										Image URL
									</label>
									<input
										id="toolbar-image-url"
										type="url"
										value={imageUrl}
										onChange={(e) =>
											setImageUrl(e.target.value)
										}
										onKeyDown={(e) => {
											if (e.key === "Enter") {
												addImage();
											}
										}}
										placeholder="https://example.com/image.png"
										className="w-full px-2 py-1 text-sm border border-border rounded bg-background"
									/>
									<Button size="sm" onClick={addImage}>
										Add Image
									</Button>
								</div>
							</TabsContent>
						</Tabs>
					</PopoverContent>
				</Popover>

				{/* Table */}
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant="ghost"
							size="sm"
							onClick={() =>
								editor
									.chain()
									.focus()
									.insertTable({
										rows: 3,
										cols: 3,
										withHeaderRow: true,
									})
									.run()
							}
							aria-label={t("insertTable")}
						>
							<TableIcon className="h-4 w-4" />
						</Button>
					</TooltipTrigger>
					<TooltipContent>{t("insertTable")}</TooltipContent>
				</Tooltip>
			</div>
		</div>
	);
}
