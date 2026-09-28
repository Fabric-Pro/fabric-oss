"use client";

/**
 * TipTap node for a Glossy visual slot (Fizzy #2589, KTD18).
 *
 * A visual slot is an editor's request for a visual at a position in a
 * Proposal or Business Case: a kind (or best fit) and an optional hint. Its
 * markdown form is one tag on its own line, owned by
 * `@repo/utils/glossy/visual-slots`:
 *
 *   <visual-slot data-slot-id="…" data-kind="…" data-hint="…"></visual-slot>
 *
 * ## Always registered
 *
 * The node sits in `buildSharedRichDocumentExtensions`, so every editor that
 * shares the rich schema — the document editor, the feature editor, the diff
 * viewers, collaborative mode — parses the tag into a node instead of
 * dropping it. Only the insert controls depend on the rollout gate and the
 * document type (R40): with the gate off, slots already in a document still
 * load, show, and save intact.
 *
 * Saving goes through `excalidrawAwareBlankReplacement`, which writes the tag
 * back with `serializeVisualSlot` — the same one-line form every server write
 * path produces. Attributes are declared in that function's order (id, kind,
 * hint, orphaned-from) so the editor's own HTML reads the same way.
 *
 * ## Assistant applications
 *
 * The in-editor assistant replaces the body with model output, and a model
 * may drop, move, or invent a slot tag. `preserveEditorVisualSlots` splices
 * the editor's current slots into the incoming markdown before it is applied
 * (KTD17), the client half of the helper every server write path runs. While
 * a run streams, the document editor splices from the run's baseline instead:
 * mid-run the editor holds a partial frame, not a complete document.
 */

import { isGlossyEligible } from "@repo/utils/glossy/eligibility";
import {
	VISUAL_SLOT_HINT_ATTR,
	VISUAL_SLOT_ID_ATTR,
	VISUAL_SLOT_KIND_ATTR,
	VISUAL_SLOT_TAG,
} from "@repo/utils/glossy/outline";
import {
	hasVisualSlots,
	parseVisualSlots,
	preserveVisualSlots,
	VISUAL_SLOT_ORPHANED_FROM_ATTR,
} from "@repo/utils/glossy/visual-slots";
import type { VisualKind } from "@repo/utils/glossy/visual-spec";
import { useFeatureFlag } from "@saas/shared/components/FeatureFlagProvider";
import { type Editor, Node } from "@tiptap/core";
import {
	NodeViewWrapper,
	type ReactNodeViewProps,
	ReactNodeViewRenderer,
} from "@tiptap/react";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ui/components/popover";
import { RadioGroup, RadioGroupItem } from "@ui/components/radio-group";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	ChartGantt,
	Columns2,
	type LucideIcon,
	Network,
	SquareDashed,
	TrendingUp,
	WandSparkles,
	Workflow,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useId, useState } from "react";
import { diffPartialText } from "./diff-utils";
import { getEditorMarkdownForSave } from "./editor-markdown-save";

export const VISUAL_SLOT_NODE_NAME = "visualSlot";

/** The radio value that stands for best fit, stored as no `data-kind`. */
const BEST_FIT = "auto";

/**
 * The kinds a person can request, best fit first. Existing Mermaid is left
 * out: it names a diagram already in the document, not one to be made.
 */
const VISUAL_SLOT_KIND_OPTIONS = [
	{ value: BEST_FIT, icon: WandSparkles },
	{ value: "timeline", icon: ChartGantt },
	{ value: "comparison", icon: Columns2 },
	{ value: "stat", icon: TrendingUp },
	{ value: "flow", icon: Workflow },
	{ value: "org_chart", icon: Network },
] as const satisfies ReadonlyArray<{ value: VisualKind; icon: LucideIcon }>;

type KnownKindValue = (typeof VISUAL_SLOT_KIND_OPTIONS)[number]["value"];

function kindOption(kind: string | null) {
	return VISUAL_SLOT_KIND_OPTIONS.find(
		(option) => option.value === (kind ?? BEST_FIT),
	);
}

interface VisualSlotValue {
	/** `null` for best fit. */
	kind: string | null;
	/** `null` when the editor gave none. Always a single line. */
	hint: string | null;
}

/**
 * A hint is one line: the tag it lands in must stay on one line of markdown,
 * so line breaks become spaces.
 */
function singleLine(value: string): string {
	return value.replace(/\s*[\r\n]+\s*/g, " ");
}

/** A new slot id. Collisions are re-issued by `preserveVisualSlots`. */
export function createVisualSlotId(): string {
	return `slot-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

declare module "@tiptap/core" {
	interface Commands<ReturnType> {
		visualSlot: {
			/**
			 * Insert a visual slot after the top-level block holding the
			 * selection, so it never splits a paragraph, list, or table.
			 */
			insertVisualSlot: (value: VisualSlotValue) => ReturnType;
		};
	}
	interface Storage {
		visualSlot: VisualSlotStorage;
	}
}

interface VisualSlotStorage {
	/**
	 * Whether this editor offers the slash command. Set by
	 * `VisualSlotControlsGate`; the node itself never depends on it.
	 */
	insertEnabled: boolean;
}

/**
 * Whether the editor's document holds a slot node. Cheap next to serializing
 * the document, which only an editor that holds a slot needs.
 */
function editorHoldsVisualSlots(editor: Editor): boolean {
	let found = false;
	editor.state.doc.descendants((node) => {
		if (found) {
			return false;
		}
		if (node.type.name === VISUAL_SLOT_NODE_NAME) {
			found = true;
			return false;
		}
		return true;
	});
	return found;
}

/**
 * `incoming` with the editor's current slots spliced in (KTD17): what an
 * assistant application writes in place of the model's body.
 *
 * Current means the editor at the moment of application, not when the
 * proposal was generated, so a slot placed while a proposal was pending
 * survives it. Slot tags in `incoming` are stripped either way, so the
 * assistant can neither introduce a slot nor resurrect one the person
 * deleted. When neither side holds a slot, `incoming` comes back unchanged.
 */
export function preserveEditorVisualSlots(
	editor: Editor,
	incoming: string,
): string {
	const current = editorHoldsVisualSlots(editor)
		? getEditorMarkdownForSave(editor)
		: null;
	return preserveVisualSlots(current, incoming);
}

/**
 * `diffPartialText` with every slot line diffed as one word.
 *
 * The word diff otherwise works inside a slot tag: a slot re-anchored at the
 * end of the document with a new `data-orphaned-from` gets markers between
 * its attributes, the tag no longer parses, and the review shows it as
 * escaped text that accepting would save in place of the slot. As one word,
 * a changed slot is deleted and inserted whole — and the node's parse rule
 * drops the deleted copy.
 */
export function diffKeepingVisualSlotsWhole(
	oldText: string,
	newText: string,
	isComplete?: boolean,
): string {
	if (!hasVisualSlots(oldText) && !hasVisualSlots(newText)) {
		return diffPartialText(oldText, newText, isComplete);
	}

	const tokenByLine = new Map<string, string>();
	const lineByToken = new Map<string, string>();
	const atomize = (text: string) => {
		const slotLines = new Set(
			parseVisualSlots(text).map((slot) => slot.line - 1),
		);
		return text
			.split("\n")
			.map((line, index) => {
				if (!slotLines.has(index)) {
					return line;
				}
				let token = tokenByLine.get(line);
				if (!token) {
					// Letters and digits only, so the word diff sees one word.
					token = `glossyvisualslot${tokenByLine.size}placeholder`;
					tokenByLine.set(line, token);
					lineByToken.set(token, line);
				}
				return token;
			})
			.join("\n");
	};

	return diffPartialText(
		atomize(oldText),
		atomize(newText),
		isComplete,
	).replace(
		/glossyvisualslot\d+placeholder/g,
		(token) => lineByToken.get(token) ?? token,
	);
}

function readAttribute(element: HTMLElement, name: string): string | null {
	return element.getAttribute(name)?.trim() || null;
}

export const VisualSlot = Node.create({
	name: VISUAL_SLOT_NODE_NAME,

	group: "block",

	// No editable content: kind and hint are edited through the chip's
	// popover, never typed into.
	atom: true,
	defining: true,
	isolating: true,

	addStorage() {
		return { insertEnabled: false } satisfies VisualSlotStorage;
	},

	// Declared in `serializeVisualSlot`'s order; a null attribute renders
	// nothing, as that function omits an empty one.
	addAttributes() {
		return {
			slotId: {
				default: null,
				parseHTML: (element: HTMLElement) =>
					readAttribute(element, VISUAL_SLOT_ID_ATTR),
				renderHTML: (attrs: Record<string, unknown>) =>
					attrs.slotId ? { [VISUAL_SLOT_ID_ATTR]: attrs.slotId } : {},
			},
			kind: {
				default: null,
				parseHTML: (element: HTMLElement) =>
					readAttribute(element, VISUAL_SLOT_KIND_ATTR),
				renderHTML: (attrs: Record<string, unknown>) =>
					attrs.kind ? { [VISUAL_SLOT_KIND_ATTR]: attrs.kind } : {},
			},
			hint: {
				default: null,
				parseHTML: (element: HTMLElement) => {
					const hint = readAttribute(element, VISUAL_SLOT_HINT_ATTR);
					return hint ? singleLine(hint) : null;
				},
				renderHTML: (attrs: Record<string, unknown>) =>
					attrs.hint ? { [VISUAL_SLOT_HINT_ATTR]: attrs.hint } : {},
			},
			orphanedFrom: {
				default: null,
				parseHTML: (element: HTMLElement) =>
					readAttribute(element, VISUAL_SLOT_ORPHANED_FROM_ATTR),
				renderHTML: (attrs: Record<string, unknown>) =>
					attrs.orphanedFrom
						? {
								[VISUAL_SLOT_ORPHANED_FROM_ATTR]:
									attrs.orphanedFrom,
							}
						: {},
			},
		};
	},

	parseHTML() {
		return [
			{
				tag: VISUAL_SLOT_TAG,
				// A slot inside a diff deletion is the old position of a slot
				// the proposal moved (preservation re-anchors it, so it also
				// appears where it now belongs). ProseMirror would lift it out
				// of the deletion as a plain block — a mark cannot hold a block
				// node — and accepting would then save the slot twice.
				getAttrs: (element: HTMLElement) =>
					element.closest("del.diff-del") ? false : null,
			},
		];
	},

	renderHTML({ HTMLAttributes }) {
		return [VISUAL_SLOT_TAG, HTMLAttributes];
	},

	addCommands() {
		return {
			insertVisualSlot:
				(value) =>
				({ state, tr, dispatch }) => {
					const { $to } = state.selection;
					const at =
						$to.depth > 0 ? $to.after(1) : state.selection.to;
					const node = state.schema.nodes[
						VISUAL_SLOT_NODE_NAME
					].create({
						slotId: createVisualSlotId(),
						kind: value.kind,
						hint: value.hint,
					});
					if (dispatch) {
						tr.insert(at, node).scrollIntoView();
					}
					return true;
				},
		};
	},

	addNodeView() {
		return ReactNodeViewRenderer(VisualSlotNodeView);
	},
});

/**
 * The kind picker and hint field, shared by the toolbar's insert control and
 * a placed chip, so both read the same way. Modelled on the Mermaid insert
 * menu: each kind is a row with an icon, a title, and a line of description.
 */
function VisualSlotForm({
	initial,
	submitLabel,
	onSubmit,
	onRemove,
}: {
	initial?: VisualSlotValue;
	submitLabel: string;
	onSubmit: (value: VisualSlotValue) => void;
	onRemove?: () => void;
}) {
	const t = useTranslations("tooltips.documentEditor");
	const [kind, setKind] = useState<string>(initial?.kind ?? BEST_FIT);
	const [hint, setHint] = useState(initial?.hint ?? "");
	const hintId = useId();

	const submit = () => {
		const trimmed = singleLine(hint).trim();
		onSubmit({
			kind: kind === BEST_FIT ? null : kind,
			hint: trimmed || null,
		});
	};

	return (
		<div className="space-y-3">
			<p className="text-sm font-medium">{t("visualSlot.title")}</p>
			<RadioGroup
				value={kind}
				onValueChange={setKind}
				aria-label={t("visualSlot.kindGroupLabel")}
				className="gap-1"
			>
				{VISUAL_SLOT_KIND_OPTIONS.map(({ value, icon: Icon }) => {
					const itemId = `${hintId}-${value}`;
					return (
						<Label
							key={value}
							htmlFor={itemId}
							className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 font-normal hover:bg-accent hover:text-accent-foreground"
						>
							<RadioGroupItem value={value} id={itemId} />
							<Icon
								className="h-4 w-4 shrink-0"
								aria-hidden="true"
							/>
							<span className="flex flex-col">
								<span className="text-sm">
									{t(`visualSlot.kinds.${value}.title`)}
								</span>
								<span className="text-xs text-muted-foreground">
									{t(`visualSlot.kinds.${value}.description`)}
								</span>
							</span>
						</Label>
					);
				})}
			</RadioGroup>
			<div className="space-y-1.5">
				<Label htmlFor={hintId}>{t("visualSlot.hintLabel")}</Label>
				<Input
					id={hintId}
					value={hint}
					onChange={(event) =>
						setHint(singleLine(event.target.value))
					}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							event.preventDefault();
							submit();
						}
					}}
					placeholder={t("visualSlot.hintPlaceholder")}
					maxLength={200}
					className="text-sm"
				/>
			</div>
			<div className="flex justify-between gap-2">
				{onRemove ? (
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={onRemove}
						className="text-destructive hover:text-destructive"
					>
						{t("visualSlot.remove")}
					</Button>
				) : (
					<span />
				)}
				<Button type="button" size="sm" onClick={submit}>
					{submitLabel}
				</Button>
			</div>
		</div>
	);
}

/**
 * The toolbar's insert control: a button that opens the form and inserts the
 * slot after the top-level block holding the selection. `EditorToolbar`
 * renders it only when its `visualSlots` prop is set.
 */
export function VisualSlotToolbarButton({ editor }: { editor: Editor }) {
	const t = useTranslations("tooltips.documentEditor");
	const [open, setOpen] = useState(false);

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<Tooltip>
				<TooltipTrigger asChild>
					<PopoverTrigger asChild>
						<Button
							variant="ghost"
							size="sm"
							aria-label={t("visualSlot.insert")}
						>
							<SquareDashed className="h-4 w-4" />
						</Button>
					</PopoverTrigger>
				</TooltipTrigger>
				<TooltipContent>{t("visualSlot.insert")}</TooltipContent>
			</Tooltip>
			<PopoverContent
				align="start"
				className="bg-card border border-border rounded-lg shadow-lg p-3 z-50 w-80"
			>
				<VisualSlotForm
					submitLabel={t("visualSlot.insertAction")}
					onSubmit={(value) => {
						editor.chain().focus().insertVisualSlot(value).run();
						setOpen(false);
					}}
				/>
			</PopoverContent>
		</Popover>
	);
}

/**
 * The chip a slot shows as. Clicking it opens the form, prefilled, to change
 * the kind or hint. An orphaned slot — its section gone after a rewrite —
 * names the section it came from (R39).
 */
export function VisualSlotNodeView({
	node,
	editor,
	selected,
	updateAttributes,
	deleteNode,
}: ReactNodeViewProps) {
	const t = useTranslations("tooltips.documentEditor");
	const [open, setOpen] = useState(false);
	const descriptionId = useId();

	const kind = (node.attrs.kind as string | null) ?? null;
	const hint = (node.attrs.hint as string | null) ?? null;
	const orphanedFrom = (node.attrs.orphanedFrom as string | null) ?? null;

	// A kind this editor does not offer — written by another client — shows
	// as written rather than as best fit, and editing only the hint keeps it.
	const option = kindOption(kind);
	const knownValue: KnownKindValue | null = option?.value ?? null;
	const Icon = option?.icon ?? WandSparkles;
	const title = knownValue
		? t(`visualSlot.kinds.${knownValue}.title`)
		: (kind ?? "");
	const name = knownValue ? t(`visualSlot.kinds.${knownValue}.name`) : kind;
	const label = t("visualSlot.chipLabel", { kind: name ?? "" });
	const hasDescription = Boolean(hint || orphanedFrom);

	const body = (
		<>
			<Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
			<span className="flex min-w-0 flex-col text-left">
				<span className="font-medium text-foreground">{title}</span>
				{hasDescription && (
					<span id={descriptionId} className="flex flex-col text-xs">
						{hint && <span className="truncate">{hint}</span>}
						{orphanedFrom && (
							<span>
								{t("visualSlot.orphanedFrom", {
									section: orphanedFrom,
								})}
							</span>
						)}
					</span>
				)}
			</span>
		</>
	);

	const chipClassName = cn(
		"my-2 inline-flex max-w-full items-center gap-2 rounded-md border border-dashed border-border bg-muted/40 px-3 py-1.5 text-sm text-muted-foreground",
		selected && "ring-2 ring-ring",
	);

	return (
		<NodeViewWrapper
			className="visual-slot-wrapper"
			contentEditable={false}
		>
			{editor.isEditable ? (
				<Popover open={open} onOpenChange={setOpen}>
					<PopoverTrigger asChild>
						<button
							type="button"
							aria-label={label}
							aria-describedby={
								hasDescription ? descriptionId : undefined
							}
							className={cn(
								chipClassName,
								"cursor-pointer transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring",
							)}
						>
							{body}
						</button>
					</PopoverTrigger>
					<PopoverContent
						align="start"
						className="bg-card border border-border rounded-lg shadow-lg p-3 z-50 w-80"
					>
						<VisualSlotForm
							initial={{ kind, hint }}
							submitLabel={t("visualSlot.save")}
							onSubmit={(value) => {
								updateAttributes(value);
								setOpen(false);
							}}
							onRemove={() => {
								setOpen(false);
								deleteNode();
							}}
						/>
					</PopoverContent>
				</Popover>
			) : (
				// Read-only: a figure stands for the visual the slot asks for.
				<figure
					aria-label={label}
					aria-describedby={
						hasDescription ? descriptionId : undefined
					}
					className={chipClassName}
				>
					{body}
				</figure>
			)}
		</NodeViewWrapper>
	);
}

/**
 * Decides whether a document editor offers the visual-slot insert controls:
 * the rollout gate is on for the organization and the document type is one a
 * Glossy edition can be built from (R37, R40). Hands the answer to the
 * toolbar through `children` and to the slash command through the editor's
 * `visualSlot` storage.
 *
 * `useFeatureFlag` throws without a `FeatureFlagProvider`, by design. Reading
 * the flag here — in the editor chrome, not at the top of the document editor
 * — keeps the render tests that stub that chrome free of a flag provider,
 * while a provider missing in the app still fails loudly.
 */
export function VisualSlotControlsGate({
	editor,
	documentType,
	children,
}: {
	editor: Editor | null;
	documentType: string | null | undefined;
	children: (enabled: boolean) => ReactNode;
}) {
	const flagEnabled = useFeatureFlag("GLOSSY_EDITION");
	const enabled = flagEnabled && isGlossyEligible(documentType ?? "");

	useEffect(() => {
		const storage = editor?.storage.visualSlot;
		if (!storage) {
			return;
		}
		storage.insertEnabled = enabled;
		return () => {
			storage.insertEnabled = false;
		};
	}, [editor, enabled]);

	return <>{children(enabled)}</>;
}
