"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import Mention from "@tiptap/extension-mention";
import { ReactNodeViewRenderer, ReactRenderer } from "@tiptap/react";
import tippy, { type Instance as TippyInstance } from "tippy.js";
import { MentionList } from "../components/MentionList";
import { MentionNodeView } from "../components/MentionNodeView";

const MENTION_ANCHOR_PREFIX = "m_";

function generateMentionAnchorId(): string {
	const rand = Math.random().toString(36).slice(2, 10);
	return `${MENTION_ANCHOR_PREFIX}${Date.now().toString(36)}${rand}`;
}

interface MentionExtensionOptions {
	/**
	 * Resolves the active project + document ids at query time. Returning
	 * `null` for either is valid — the suggestion popover will yield no
	 * items, leaving the mention node view in place for already-rendered
	 * chips (used by read-only contexts like VersionDiffViewer and
	 * StoryWorkspace).
	 */
	getProjectId: () => string | null;
	getDocumentId: () => string | null;
}

/**
 * Inline @-mention node. Stored as
 *   <span data-type="mention" data-id=<userId> data-label=<name>
 *         data-mention-id=<anchor> class="mention">@Name</span>
 *
 * `mentionId` is set on first insertion (via the suggestion command in
 * MentionList) and stays stable for the lifetime of that mention so the
 * notification deep-link can scroll the recipient to it.
 *
 * Suggestion candidates come from `projects.documents.searchMentionables`,
 * scoped to the document's project owner + accepted ProjectMembers. See
 * `docs/superpowers/specs/2026-05-12-mention-scope-project-collaborators-design.md`.
 */
export function buildMentionExtension(opts: MentionExtensionOptions) {
	return Mention.extend({
		addAttributes() {
			const parent = this.parent?.() ?? {};
			return {
				...parent,
				mentionId: {
					default: null,
					parseHTML: (el) =>
						(el as HTMLElement).getAttribute("data-mention-id") ??
						generateMentionAnchorId(),
					renderHTML: (attrs) => ({
						"data-mention-id":
							(attrs.mentionId as string | null) ??
							generateMentionAnchorId(),
					}),
				},
				groupTag: {
					default: null,
					parseHTML: (el) =>
						(el as HTMLElement).getAttribute("data-group-tag"),
					renderHTML: (attrs) =>
						attrs.groupTag
							? { "data-group-tag": attrs.groupTag as string }
							: {},
				},
			};
		},

		addNodeView() {
			return ReactNodeViewRenderer(MentionNodeView);
		},
	}).configure({
		HTMLAttributes: { class: "mention" },
		renderText: ({ node }) => `@${node.attrs.label ?? ""}`,
		suggestion: {
			char: "@",
			items: async ({ query }: { query: string }) => {
				const projectId = opts.getProjectId();
				const documentId = opts.getDocumentId();
				if (!projectId || !documentId) {
					return [];
				}
				try {
					const result =
						await orpcClient.projects.documents.searchMentionables({
							projectId,
							documentId,
							query: query || "",
						});
					const groups = (result?.groups ?? []).map((g) => ({
						kind: "group" as const,
						tag: g.tag,
						label: g.label,
						memberCount: g.memberCount,
					}));
					const users = (result?.members ?? []).map((m) => ({
						kind: "user" as const,
						id: m.id,
						name: m.name,
						email: m.email,
						avatarUrl: m.avatarUrl,
					}));
					// Procedure returns ≤10 members plus additive group
					// candidates (combined can exceed 10); take 8 for the
					// popover display limit, groups surfaced ahead of users.
					return [...groups, ...users].slice(0, 8);
				} catch {
					return [];
				}
			},
			command: ({ editor, range, props }: any) => {
				const attrs =
					props.kind === "group"
						? {
								groupTag: props.groupTag,
								label: props.label,
								mentionId: generateMentionAnchorId(),
							}
						: {
								id: props.id,
								label: props.label,
								mentionId: generateMentionAnchorId(),
							};
				editor
					.chain()
					.focus()
					.insertContentAt(range, [
						{ type: "mention", attrs },
						{ type: "text", text: " " },
					])
					.run();
			},
			render: () => {
				let component: ReactRenderer<any>;
				let popup: TippyInstance[];
				let listboxId = "";

				return {
					onStart: (props: any) => {
						// Generate a stable listbox id for this suggestion session.
						listboxId = `mention-listbox-${
							typeof crypto !== "undefined" && crypto.randomUUID
								? crypto.randomUUID()
								: Math.random().toString(36).slice(2)
						}`;

						// ARIA: announce the contenteditable as a combobox while
						// the suggestion popover is open.
						const editorDom: HTMLElement = props.editor.view.dom;
						editorDom.setAttribute("role", "combobox");
						editorDom.setAttribute("aria-haspopup", "listbox");
						editorDom.setAttribute("aria-expanded", "true");
						editorDom.setAttribute("aria-controls", listboxId);

						// Callback passed to MentionList so it can keep
						// aria-activedescendant in sync as the user arrows through results.
						const setActiveDescendant = (index: number) => {
							props.editor.view.dom.setAttribute(
								"aria-activedescendant",
								`${listboxId}-opt-${index}`,
							);
						};

						component = new ReactRenderer(MentionList, {
							props: { ...props, listboxId, setActiveDescendant },
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
						return (
							(component.ref as any)?.onKeyDown(props) ?? false
						);
					},
					onExit(props: any) {
						// ARIA: remove all combobox attrs from the contenteditable.
						const editorDom: HTMLElement = props.editor.view.dom;
						for (const attr of [
							"role",
							"aria-haspopup",
							"aria-expanded",
							"aria-controls",
							"aria-activedescendant",
						]) {
							editorDom.removeAttribute(attr);
						}
						listboxId = "";

						popup[0]?.destroy();
						component.destroy();
					},
				};
			},
		},
	});
}

/**
 * @deprecated No-document fallback. Suggestion popovers built from this
 * instance always resolve `projectId`/`documentId` to `null` and therefore
 * yield no candidates. Routes that mount the document editor MUST
 * construct the extension via
 * `buildMentionExtension({ getProjectId: () => p, getDocumentId: () => d })`
 * and pass it through to TipTap. Kept as a fallback so test harnesses and
 * any non-document callers continue to compile.
 */
export const MentionExtension = buildMentionExtension({
	getProjectId: () => null,
	getDocumentId: () => null,
});
