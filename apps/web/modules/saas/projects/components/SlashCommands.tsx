"use client";

import { DIAGRAM_TEMPLATES } from "@saas/projects/lib/mermaid-templates";
import { Extension } from "@tiptap/core";
import { ReactRenderer } from "@tiptap/react";
import { Suggestion } from "@tiptap/suggestion";
import {
	CheckSquare,
	Code,
	Heading1,
	Heading2,
	Heading3,
	Link as LinkIcon,
	List,
	ListOrdered,
	type LucideIcon,
	Minus,
	Quote,
	Table as TableIcon,
	Upload,
} from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useState } from "react";
import tippy, { type Instance as TippyInstance } from "tippy.js";

interface SlashCommandItem {
	title: string;
	description: string;
	icon: LucideIcon;
	command: (props: any) => void;
}

/**
 * Global callback for image uploads from slash commands.
 * Set by DocumentEditor when the S3 upload handler is available.
 * Slash commands can't access React props, so this acts as a bridge.
 */
let _globalImageUploadHandler: ((files: FileList) => Promise<void>) | null =
	null;

/** Register the image upload handler (called by DocumentEditor on mount). */
export function setSlashCommandImageUploadHandler(
	handler: ((files: FileList) => Promise<void>) | null,
) {
	_globalImageUploadHandler = handler;
}

const slashCommands: SlashCommandItem[] = [
	{
		title: "Heading 1",
		description: "Large section heading",
		icon: Heading1,
		command: ({ editor, range }) => {
			editor
				.chain()
				.focus()
				.deleteRange(range)
				.setNode("heading", { level: 1 })
				.run();
		},
	},
	{
		title: "Heading 2",
		description: "Medium section heading",
		icon: Heading2,
		command: ({ editor, range }) => {
			editor
				.chain()
				.focus()
				.deleteRange(range)
				.setNode("heading", { level: 2 })
				.run();
		},
	},
	{
		title: "Heading 3",
		description: "Small section heading",
		icon: Heading3,
		command: ({ editor, range }) => {
			editor
				.chain()
				.focus()
				.deleteRange(range)
				.setNode("heading", { level: 3 })
				.run();
		},
	},
	{
		title: "Bullet List",
		description: "Create a bulleted list",
		icon: List,
		command: ({ editor, range }) => {
			editor.chain().focus().deleteRange(range).toggleBulletList().run();
		},
	},
	{
		title: "Numbered List",
		description: "Create a numbered list",
		icon: ListOrdered,
		command: ({ editor, range }) => {
			editor.chain().focus().deleteRange(range).toggleOrderedList().run();
		},
	},
	{
		title: "Task List",
		description: "Track tasks with a checklist",
		icon: CheckSquare,
		command: ({ editor, range }) => {
			editor.chain().focus().deleteRange(range).toggleTaskList().run();
		},
	},
	{
		title: "Quote",
		description: "Capture a quote",
		icon: Quote,
		command: ({ editor, range }) => {
			editor.chain().focus().deleteRange(range).toggleBlockquote().run();
		},
	},
	{
		title: "Code Block",
		description: "Insert code with syntax highlighting",
		icon: Code,
		command: ({ editor, range }) => {
			editor.chain().focus().deleteRange(range).toggleCodeBlock().run();
		},
	},
	{
		title: "Table",
		description: "Insert a table",
		icon: TableIcon,
		command: ({ editor, range }) => {
			editor
				.chain()
				.focus()
				.deleteRange(range)
				.insertTable({ rows: 3, cols: 3, withHeaderRow: true })
				.run();
		},
	},
	{
		title: "Divider",
		description: "Insert a horizontal divider",
		icon: Minus,
		command: ({ editor, range }) => {
			editor.chain().focus().deleteRange(range).setHorizontalRule().run();
		},
	},
	{
		title: "Image Upload",
		description: "Upload an image from your device",
		icon: Upload,
		command: ({ editor, range }: { editor: any; range: any }) => {
			editor.chain().focus().deleteRange(range).run();
			// Open native file picker, route through S3 upload pipeline
			const input = document.createElement("input");
			input.type = "file";
			input.accept = "image/png,image/jpeg,image/gif,image/webp";
			input.onchange = () => {
				const files = input.files;
				if (!files?.length) {
					return;
				}
				if (_globalImageUploadHandler) {
					_globalImageUploadHandler(files);
				} else {
					// Fallback for contexts without S3
					const reader = new FileReader();
					reader.onload = () => {
						editor
							.chain()
							.focus()
							.setImage({ src: reader.result as string })
							.updateAttributes("image", { width: "50%" })
							.run();
					};
					reader.readAsDataURL(files[0]);
				}
			};
			input.click();
		},
	},
	{
		title: "Image from URL",
		description: "Insert an image from a web link",
		icon: LinkIcon,
		command: ({ editor, range }: { editor: any; range: any }) => {
			editor.chain().focus().deleteRange(range).run();
			const url = window.prompt("Enter image URL:");
			if (url) {
				editor
					.chain()
					.focus()
					.setImage({ src: url })
					.updateAttributes("image", { width: "50%" })
					.run();
			}
		},
	},
	// Diagram commands generated from DIAGRAM_TEMPLATES
	...DIAGRAM_TEMPLATES.map((tpl) => ({
		title: tpl.title,
		description: tpl.description,
		icon: tpl.icon,
		command: ({ editor, range }: { editor: any; range: any }) => {
			editor
				.chain()
				.focus()
				.deleteRange(range)
				.insertContent({
					type: "mermaidBlock",
					attrs: tpl.id === "empty" ? {} : { diagramType: tpl.id },
					content: [{ type: "text", text: tpl.template }],
				})
				.run();
		},
	})),
];

interface SlashCommandsListProps {
	items: SlashCommandItem[];
	command: (item: SlashCommandItem) => void;
}

const SlashCommandsList = forwardRef<
	{ onKeyDown: (props: { event: KeyboardEvent }) => boolean },
	SlashCommandsListProps
>((props, ref) => {
	const [selectedIndex, setSelectedIndex] = useState(0);

	const selectItem = (index: number) => {
		const item = props.items[index];
		if (item) {
			props.command(item);
		}
	};

	const upHandler = () => {
		setSelectedIndex(
			(selectedIndex + props.items.length - 1) % props.items.length,
		);
	};

	const downHandler = () => {
		setSelectedIndex((selectedIndex + 1) % props.items.length);
	};

	const enterHandler = () => {
		selectItem(selectedIndex);
	};

	useEffect(() => {
		setSelectedIndex(0);
	}, [props.items]);

	useImperativeHandle(ref, () => ({
		onKeyDown: ({ event }: { event: KeyboardEvent }) => {
			if (event.key === "ArrowUp") {
				upHandler();
				return true;
			}

			if (event.key === "ArrowDown") {
				downHandler();
				return true;
			}

			if (event.key === "Enter") {
				enterHandler();
				return true;
			}

			return false;
		},
	}));

	return (
		<div className="slash-commands-menu bg-card border border-border rounded-lg shadow-lg overflow-hidden max-h-[400px] overflow-y-auto">
			{props.items.length > 0 ? (
				<div className="p-1">
					{props.items.map((item, index) => {
						const Icon = item.icon;
						return (
							<button
								key={index}
								type="button"
								className={`w-full flex items-center gap-3 px-3 py-2 rounded text-left transition-colors ${
									index === selectedIndex
										? "bg-primary/10 text-primary"
										: "text-foreground hover:bg-muted"
								}`}
								onClick={() => selectItem(index)}
							>
								<Icon className="h-4 w-4 flex-shrink-0" />
								<div className="flex-1 min-w-0">
									<div className="text-sm font-medium truncate">
										{item.title}
									</div>
									<div className="text-xs text-muted-foreground truncate">
										{item.description}
									</div>
								</div>
							</button>
						);
					})}
				</div>
			) : (
				<div className="p-4 text-center text-sm text-muted-foreground">
					No results
				</div>
			)}
		</div>
	);
});

SlashCommandsList.displayName = "SlashCommandsList";

export const SlashCommandsExtension = Extension.create({
	name: "slashCommands",

	addOptions() {
		return {
			suggestion: {
				char: "/",
				command: ({ editor, range, props }: any) => {
					props.command({ editor, range });
				},
			},
		};
	},

	addProseMirrorPlugins() {
		return [
			Suggestion({
				editor: this.editor,
				...this.options.suggestion,
				items: ({ query }: { query: string }) => {
					return slashCommands.filter((item) =>
						item.title.toLowerCase().includes(query.toLowerCase()),
					);
				},
				render: () => {
					let component: ReactRenderer<any>;
					let popup: TippyInstance[];

					return {
						onStart: (props: any) => {
							component = new ReactRenderer(SlashCommandsList, {
								props,
								editor: props.editor,
							});

							if (!props.clientRect) {
								return;
							}

							popup = tippy("body", {
								getReferenceClientRect: props.clientRect,
								appendTo: () => document.body,
								content: component.element,
								showOnCreate: true,
								interactive: true,
								trigger: "manual",
								placement: "bottom-start",
							});
						},

						onUpdate(props: any) {
							component.updateProps(props);

							if (!props.clientRect) {
								return;
							}

							popup[0]?.setProps({
								getReferenceClientRect: props.clientRect,
							});
						},

						onKeyDown(props: any) {
							if (props.event.key === "Escape") {
								popup[0]?.hide();
								return true;
							}

							return component.ref?.onKeyDown(props) ?? false;
						},

						onExit() {
							popup[0]?.destroy();
							component.destroy();
						},
					};
				},
			}),
		];
	},
});
