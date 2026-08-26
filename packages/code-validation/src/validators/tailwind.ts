/**
 * Tailwind CSS Class Validator
 *
 * Validates Tailwind CSS class names in code.
 * Uses a combination of known valid classes and pattern matching.
 */

import type {
	TailwindValidationResult,
	TailwindValidationWarning,
} from "../types/validation";

// Core Tailwind utilities that are always valid
const CORE_UTILITIES = new Set([
	// Layout
	"block",
	"inline-block",
	"inline",
	"flex",
	"inline-flex",
	"table",
	"inline-table",
	"table-caption",
	"table-cell",
	"table-column",
	"table-column-group",
	"table-footer-group",
	"table-header-group",
	"table-row-group",
	"table-row",
	"flow-root",
	"grid",
	"inline-grid",
	"contents",
	"list-item",
	"hidden",

	// Position
	"static",
	"fixed",
	"absolute",
	"relative",
	"sticky",

	// Display
	"container",
	"box-border",
	"box-content",

	// Flex
	"flex-row",
	"flex-row-reverse",
	"flex-col",
	"flex-col-reverse",
	"flex-wrap",
	"flex-wrap-reverse",
	"flex-nowrap",
	"flex-1",
	"flex-auto",
	"flex-initial",
	"flex-none",
	"grow",
	"grow-0",
	"shrink",
	"shrink-0",
	// Flex alignment
	"items-start",
	"items-end",
	"items-center",
	"items-baseline",
	"items-stretch",
	"justify-start",
	"justify-end",
	"justify-center",
	"justify-between",
	"justify-around",
	"justify-evenly",
	"content-start",
	"content-end",
	"content-center",
	"content-between",
	"content-around",
	"content-evenly",

	// Grid
	"grid-cols-1",
	"grid-cols-2",
	"grid-cols-3",
	"grid-cols-4",
	"grid-cols-5",
	"grid-cols-6",
	"grid-cols-7",
	"grid-cols-8",
	"grid-cols-9",
	"grid-cols-10",
	"grid-cols-11",
	"grid-cols-12",
	"grid-rows-1",
	"grid-rows-2",
	"grid-rows-3",
	"grid-rows-4",
	"grid-rows-5",
	"grid-rows-6",
	"gap-0",
	"gap-1",
	"gap-2",
	"gap-3",
	"gap-4",
	"gap-5",
	"gap-6",
	"gap-8",
	"gap-10",
	"gap-12",

	// Spacing (margin)
	"m-0",
	"m-1",
	"m-2",
	"m-3",
	"m-4",
	"m-5",
	"m-6",
	"m-8",
	"m-10",
	"m-12",
	"m-16",
	"m-20",
	"m-24",
	"mx-0",
	"mx-1",
	"mx-2",
	"mx-3",
	"mx-4",
	"mx-5",
	"mx-6",
	"mx-8",
	"mx-10",
	"mx-12",
	"mx-auto",
	"my-0",
	"my-1",
	"my-2",
	"my-3",
	"my-4",
	"my-5",
	"my-6",
	"my-8",
	"my-10",
	"my-12",
	"my-auto",
	"mt-0",
	"mt-1",
	"mt-2",
	"mt-3",
	"mt-4",
	"mt-5",
	"mt-6",
	"mt-8",
	"mt-10",
	"mt-12",
	"mr-0",
	"mr-1",
	"mr-2",
	"mr-3",
	"mr-4",
	"mr-5",
	"mr-6",
	"mr-8",
	"mr-auto",
	"mb-0",
	"mb-1",
	"mb-2",
	"mb-3",
	"mb-4",
	"mb-5",
	"mb-6",
	"mb-8",
	"mb-10",
	"mb-12",
	"ml-0",
	"ml-1",
	"ml-2",
	"ml-3",
	"ml-4",
	"ml-5",
	"ml-6",
	"ml-8",
	"ml-auto",

	// Spacing (padding)
	"p-0",
	"p-1",
	"p-2",
	"p-3",
	"p-4",
	"p-5",
	"p-6",
	"p-8",
	"p-10",
	"p-12",
	"p-16",
	"px-0",
	"px-1",
	"px-2",
	"px-3",
	"px-4",
	"px-5",
	"px-6",
	"px-8",
	"px-10",
	"px-12",
	"py-0",
	"py-1",
	"py-2",
	"py-3",
	"py-4",
	"py-5",
	"py-6",
	"py-8",
	"py-10",
	"py-12",
	"pt-0",
	"pt-1",
	"pt-2",
	"pt-3",
	"pt-4",
	"pt-5",
	"pt-6",
	"pt-8",
	"pt-10",
	"pt-12",
	"pr-0",
	"pr-1",
	"pr-2",
	"pr-3",
	"pr-4",
	"pr-5",
	"pr-6",
	"pr-8",
	"pr-10",
	"pr-12",
	"pb-0",
	"pb-1",
	"pb-2",
	"pb-3",
	"pb-4",
	"pb-5",
	"pb-6",
	"pb-8",
	"pb-10",
	"pb-12",
	"pl-0",
	"pl-1",
	"pl-2",
	"pl-3",
	"pl-4",
	"pl-5",
	"pl-6",
	"pl-8",
	"pl-10",
	"pl-12",

	// Sizing
	"w-0",
	"w-1",
	"w-2",
	"w-3",
	"w-4",
	"w-5",
	"w-6",
	"w-8",
	"w-10",
	"w-12",
	"w-16",
	"w-20",
	"w-24",
	"w-32",
	"w-40",
	"w-48",
	"w-56",
	"w-64",
	"w-auto",
	"w-full",
	"w-screen",
	"w-min",
	"w-max",
	"w-fit",
	"h-0",
	"h-1",
	"h-2",
	"h-3",
	"h-4",
	"h-5",
	"h-6",
	"h-8",
	"h-10",
	"h-12",
	"h-16",
	"h-20",
	"h-24",
	"h-32",
	"h-40",
	"h-48",
	"h-56",
	"h-64",
	"h-auto",
	"h-full",
	"h-screen",
	"h-min",
	"h-max",
	"h-fit",

	// Typography
	"text-xs",
	"text-sm",
	"text-base",
	"text-lg",
	"text-xl",
	"text-2xl",
	"text-3xl",
	"text-4xl",
	"text-5xl",
	"text-6xl",
	"text-7xl",
	"text-8xl",
	"text-9xl",
	"font-thin",
	"font-extralight",
	"font-light",
	"font-normal",
	"font-medium",
	"font-semibold",
	"font-bold",
	"font-extrabold",
	"font-black",
	"leading-none",
	"leading-tight",
	"leading-snug",
	"leading-normal",
	"leading-relaxed",
	"leading-loose",
	"tracking-tighter",
	"tracking-tight",
	"tracking-normal",
	"tracking-wide",
	"tracking-wider",
	"tracking-widest",
	"text-left",
	"text-center",
	"text-right",
	"text-justify",
	"text-start",
	"text-end",
	"underline",
	"overline",
	"line-through",
	"no-underline",
	"uppercase",
	"lowercase",
	"capitalize",
	"normal-case",
	"truncate",
	"text-ellipsis",
	"text-clip",
	"whitespace-normal",
	"whitespace-nowrap",
	"whitespace-pre",
	"whitespace-pre-line",
	"whitespace-pre-wrap",
	"break-normal",
	"break-words",
	"break-all",
	"break-keep",

	// Colors (text)
	"text-inherit",
	"text-current",
	"text-transparent",
	"text-black",
	"text-white",
	"text-slate-50",
	"text-slate-100",
	"text-slate-200",
	"text-slate-300",
	"text-slate-400",
	"text-slate-500",
	"text-slate-600",
	"text-slate-700",
	"text-slate-800",
	"text-slate-900",
	"text-gray-50",
	"text-gray-100",
	"text-gray-200",
	"text-gray-300",
	"text-gray-400",
	"text-gray-500",
	"text-gray-600",
	"text-gray-700",
	"text-gray-800",
	"text-gray-900",
	"text-zinc-50",
	"text-zinc-100",
	"text-zinc-200",
	"text-zinc-300",
	"text-zinc-400",
	"text-zinc-500",
	"text-zinc-600",
	"text-zinc-700",
	"text-zinc-800",
	"text-zinc-900",
	"text-neutral-50",
	"text-neutral-100",
	"text-neutral-200",
	"text-neutral-300",
	"text-neutral-400",
	"text-neutral-500",
	"text-neutral-600",
	"text-neutral-700",
	"text-neutral-800",
	"text-neutral-900",
	"text-stone-50",
	"text-stone-100",
	"text-stone-200",
	"text-stone-300",
	"text-stone-400",
	"text-stone-500",
	"text-stone-600",
	"text-stone-700",
	"text-stone-800",
	"text-stone-900",
	"text-red-50",
	"text-red-100",
	"text-red-200",
	"text-red-300",
	"text-red-400",
	"text-red-500",
	"text-red-600",
	"text-red-700",
	"text-red-800",
	"text-red-900",
	"text-orange-50",
	"text-orange-100",
	"text-orange-200",
	"text-orange-300",
	"text-orange-400",
	"text-orange-500",
	"text-orange-600",
	"text-orange-700",
	"text-orange-800",
	"text-orange-900",
	"text-amber-50",
	"text-amber-100",
	"text-amber-200",
	"text-amber-300",
	"text-amber-400",
	"text-amber-500",
	"text-amber-600",
	"text-amber-700",
	"text-amber-800",
	"text-amber-900",
	"text-yellow-50",
	"text-yellow-100",
	"text-yellow-200",
	"text-yellow-300",
	"text-yellow-400",
	"text-yellow-500",
	"text-yellow-600",
	"text-yellow-700",
	"text-yellow-800",
	"text-yellow-900",
	"text-lime-50",
	"text-lime-100",
	"text-lime-200",
	"text-lime-300",
	"text-lime-400",
	"text-lime-500",
	"text-lime-600",
	"text-lime-700",
	"text-lime-800",
	"text-lime-900",
	"text-green-50",
	"text-green-100",
	"text-green-200",
	"text-green-300",
	"text-green-400",
	"text-green-500",
	"text-green-600",
	"text-green-700",
	"text-green-800",
	"text-green-900",
	"text-emerald-50",
	"text-emerald-100",
	"text-emerald-200",
	"text-emerald-300",
	"text-emerald-400",
	"text-emerald-500",
	"text-emerald-600",
	"text-emerald-700",
	"text-emerald-800",
	"text-emerald-900",
	"text-teal-50",
	"text-teal-100",
	"text-teal-200",
	"text-teal-300",
	"text-teal-400",
	"text-teal-500",
	"text-teal-600",
	"text-teal-700",
	"text-teal-800",
	"text-teal-900",
	"text-cyan-50",
	"text-cyan-100",
	"text-cyan-200",
	"text-cyan-300",
	"text-cyan-400",
	"text-cyan-500",
	"text-cyan-600",
	"text-cyan-700",
	"text-cyan-800",
	"text-cyan-900",
	"text-sky-50",
	"text-sky-100",
	"text-sky-200",
	"text-sky-300",
	"text-sky-400",
	"text-sky-500",
	"text-sky-600",
	"text-sky-700",
	"text-sky-800",
	"text-sky-900",
	"text-blue-50",
	"text-blue-100",
	"text-blue-200",
	"text-blue-300",
	"text-blue-400",
	"text-blue-500",
	"text-blue-600",
	"text-blue-700",
	"text-blue-800",
	"text-blue-900",
	"text-indigo-50",
	"text-indigo-100",
	"text-indigo-200",
	"text-indigo-300",
	"text-indigo-400",
	"text-indigo-500",
	"text-indigo-600",
	"text-indigo-700",
	"text-indigo-800",
	"text-indigo-900",
	"text-violet-50",
	"text-violet-100",
	"text-violet-200",
	"text-violet-300",
	"text-violet-400",
	"text-violet-500",
	"text-violet-600",
	"text-violet-700",
	"text-violet-800",
	"text-violet-900",
	"text-purple-50",
	"text-purple-100",
	"text-purple-200",
	"text-purple-300",
	"text-purple-400",
	"text-purple-500",
	"text-purple-600",
	"text-purple-700",
	"text-purple-800",
	"text-purple-900",
	"text-fuchsia-50",
	"text-fuchsia-100",
	"text-fuchsia-200",
	"text-fuchsia-300",
	"text-fuchsia-400",
	"text-fuchsia-500",
	"text-fuchsia-600",
	"text-fuchsia-700",
	"text-fuchsia-800",
	"text-fuchsia-900",
	"text-pink-50",
	"text-pink-100",
	"text-pink-200",
	"text-pink-300",
	"text-pink-400",
	"text-pink-500",
	"text-pink-600",
	"text-pink-700",
	"text-pink-800",
	"text-pink-900",
	"text-rose-50",
	"text-rose-100",
	"text-rose-200",
	"text-rose-300",
	"text-rose-400",
	"text-rose-500",
	"text-rose-600",
	"text-rose-700",
	"text-rose-800",
	"text-rose-900",

	// Background colors
	"bg-inherit",
	"bg-current",
	"bg-transparent",
	"bg-black",
	"bg-white",
	"bg-slate-50",
	"bg-slate-100",
	"bg-slate-200",
	"bg-slate-300",
	"bg-slate-400",
	"bg-slate-500",
	"bg-slate-600",
	"bg-slate-700",
	"bg-slate-800",
	"bg-slate-900",
	"bg-gray-50",
	"bg-gray-100",
	"bg-gray-200",
	"bg-gray-300",
	"bg-gray-400",
	"bg-gray-500",
	"bg-gray-600",
	"bg-gray-700",
	"bg-gray-800",
	"bg-gray-900",
	"bg-zinc-50",
	"bg-zinc-100",
	"bg-zinc-200",
	"bg-zinc-300",
	"bg-zinc-400",
	"bg-zinc-500",
	"bg-zinc-600",
	"bg-zinc-700",
	"bg-zinc-800",
	"bg-zinc-900",
	"bg-neutral-50",
	"bg-neutral-100",
	"bg-neutral-200",
	"bg-neutral-300",
	"bg-neutral-400",
	"bg-neutral-500",
	"bg-neutral-600",
	"bg-neutral-700",
	"bg-neutral-800",
	"bg-neutral-900",
	"bg-red-50",
	"bg-red-100",
	"bg-red-200",
	"bg-red-300",
	"bg-red-400",
	"bg-red-500",
	"bg-red-600",
	"bg-red-700",
	"bg-red-800",
	"bg-red-900",
	"bg-green-50",
	"bg-green-100",
	"bg-green-200",
	"bg-green-300",
	"bg-green-400",
	"bg-green-500",
	"bg-green-600",
	"bg-green-700",
	"bg-green-800",
	"bg-green-900",
	"bg-blue-50",
	"bg-blue-100",
	"bg-blue-200",
	"bg-blue-300",
	"bg-blue-400",
	"bg-blue-500",
	"bg-blue-600",
	"bg-blue-700",
	"bg-blue-800",
	"bg-blue-900",

	// Border
	"border-0",
	"border",
	"border-2",
	"border-4",
	"border-8",
	"border-solid",
	"border-dashed",
	"border-dotted",
	"border-double",
	"border-hidden",
	"border-none",
	"border-collapse",
	"border-separate",

	// Border radius
	"rounded-none",
	"rounded-sm",
	"rounded",
	"rounded-md",
	"rounded-lg",
	"rounded-xl",
	"rounded-2xl",
	"rounded-3xl",
	"rounded-full",

	// Shadow
	"shadow-sm",
	"shadow",
	"shadow-md",
	"shadow-lg",
	"shadow-xl",
	"shadow-2xl",
	"shadow-inner",
	"shadow-none",

	// Opacity
	"opacity-0",
	"opacity-5",
	"opacity-10",
	"opacity-20",
	"opacity-25",
	"opacity-30",
	"opacity-40",
	"opacity-50",
	"opacity-60",
	"opacity-70",
	"opacity-75",
	"opacity-80",
	"opacity-90",
	"opacity-95",
	"opacity-100",

	// Z-index
	"z-0",
	"z-10",
	"z-20",
	"z-30",
	"z-40",
	"z-50",
	"z-auto",

	// Overflow
	"overflow-auto",
	"overflow-hidden",
	"overflow-clip",
	"overflow-visible",
	"overflow-scroll",
	"overflow-x-auto",
	"overflow-y-auto",
	"overflow-x-hidden",
	"overflow-y-hidden",

	// Cursor
	"cursor-auto",
	"cursor-default",
	"cursor-pointer",
	"cursor-wait",
	"cursor-text",
	"cursor-move",
	"cursor-help",
	"cursor-not-allowed",
	"cursor-none",

	// Pointer events
	"pointer-events-none",
	"pointer-events-auto",

	// Visibility
	"visible",
	"invisible",
	"collapse",

	// Select
	"select-none",
	"select-text",
	"select-all",
	"select-auto",

	// Resize
	"resize-none",
	"resize-y",
	"resize-x",
	"resize",

	// Transition
	"transition-none",
	"transition-all",
	"transition",
	"transition-colors",
	"transition-opacity",
	"transition-shadow",
	"transition-transform",

	// Duration
	"duration-0",
	"duration-75",
	"duration-100",
	"duration-150",
	"duration-200",
	"duration-300",
	"duration-500",
	"duration-700",
	"duration-1000",

	// Ease
	"ease-linear",
	"ease-in",
	"ease-out",
	"ease-in-out",

	// Scale
	"scale-0",
	"scale-50",
	"scale-75",
	"scale-90",
	"scale-95",
	"scale-100",
	"scale-105",
	"scale-110",
	"scale-125",
	"scale-150",

	// Rotate
	"rotate-0",
	"rotate-1",
	"rotate-2",
	"rotate-3",
	"rotate-6",
	"rotate-12",
	"rotate-45",
	"rotate-90",
	"rotate-180",

	// Translate
	"translate-x-0",
	"translate-x-1",
	"translate-x-2",
	"translate-x-4",
	"translate-x-full",
	"translate-y-0",
	"translate-y-1",
	"translate-y-2",
	"translate-y-4",
	"translate-y-full",

	// Hover states
	"hover:bg-opacity-50",
	"hover:bg-opacity-75",
	"hover:bg-opacity-100",
	"hover:text-opacity-50",
	"hover:text-opacity-75",
	"hover:text-opacity-100",

	// Focus states
	"focus:outline-none",
	"focus:ring-2",
	"focus:ring-4",
	"focus:ring-offset-2",
	"focus:ring-offset-4",

	// Active states
	"active:bg-opacity-75",
	"active:scale-95",

	// Disabled states
	"disabled:opacity-50",
	"disabled:cursor-not-allowed",

	// Group hover
	"group-hover:opacity-100",
	"group-hover:visible",

	// Dark mode
	"dark:bg-gray-800",
	"dark:bg-gray-900",
	"dark:text-white",
	"dark:text-gray-200",
]);

// Valid Tailwind prefixes/patterns
const VALID_PREFIXES = [
	"hover:",
	"focus:",
	"active:",
	"disabled:",
	"visited:",
	"checked:",
	"first:",
	"last:",
	"odd:",
	"even:",
	"group-hover:",
	"group-focus:",
	"focus-within:",
	"focus-visible:",
	"motion-safe:",
	"motion-reduce:",
	"dark:",
	"light:",
	"print:",
	"placeholder:",
	"selection:",
	"marker:",
	"file:",
	"backdrop:",
	"before:",
	"after:",
	"first-letter:",
	"first-line:",
];

// Valid responsive prefixes
const RESPONSIVE_PREFIXES = ["sm:", "md:", "lg:", "xl:", "2xl:"];

// Common arbitrary value patterns
const ARBITRARY_VALUE_PATTERN = /\[(.+?)\]$/;

/**
 * Check if a class is a valid Tailwind class
 *
 * Uses multiple strategies:
 * 1. Exact match in known utilities
 * 2. Valid prefix + known utility
 * 3. Valid responsive prefix + known utility
 * 4. Arbitrary value pattern
 * 5. Common patterns (fractions, colors with opacity)
 *
 * @param className - The class name to check
 * @returns true if potentially valid
 */
function isValidTailwindClass(className: string): boolean {
	// Empty or whitespace
	if (!className || className.trim() === "") {
		return false;
	}

	const cls = className.trim();

	// Exact match
	if (CORE_UTILITIES.has(cls)) {
		return true;
	}

	// Check for prefix + utility
	for (const prefix of [...VALID_PREFIXES, ...RESPONSIVE_PREFIXES]) {
		if (cls.startsWith(prefix)) {
			const baseClass = cls.slice(prefix.length);
			// Recursively check without the prefix
			if (isValidTailwindClass(baseClass)) {
				return true;
			}
		}
	}

	// Arbitrary values: e.g., w-[100px], text-[14px], bg-[#ff0000]
	if (ARBITRARY_VALUE_PATTERN.test(cls)) {
		const baseClass = cls.replace(ARBITRARY_VALUE_PATTERN, "");
		// The base class should be a valid utility name pattern
		if (isValidArbitraryBase(baseClass)) {
			return true;
		}
	}

	// Fraction values: e.g., w-1/2, h-3/4
	if (/\w+-\d+\/\d+$/.test(cls)) {
		const baseClass = cls.replace(/-\d+\/\d+$/, "");
		if (
			CORE_UTILITIES.has(`${baseClass}-1/2`) ||
			CORE_UTILITIES.has(`${baseClass}-full`)
		) {
			return true;
		}
	}

	// Color with opacity: e.g., text-red-500/50, bg-blue-600/75
	if (/\w+-\w+-\d+\/\d+$/.test(cls)) {
		const baseClass = cls.replace(/\/\d+$/, "");
		if (CORE_UTILITIES.has(baseClass)) {
			return true;
		}
	}

	// Number suffixes for utilities that accept arbitrary numbers
	if (
		/^(m|p|gap|space|w|h|min-w|min-h|max-w|max-h|border|outline|ring|shadow)-[\d.]+$/.test(
			cls,
		)
	) {
		return true;
	}

	// Negative values
	if (cls.startsWith("-")) {
		return isValidTailwindClass(cls.slice(1));
	}

	// Important modifier
	if (cls.startsWith("!")) {
		return isValidTailwindClass(cls.slice(1));
	}

	return false;
}

/**
 * Check if a base class is valid for arbitrary values
 */
function isValidArbitraryBase(baseClass: string): boolean {
	const validBases = [
		"w",
		"h",
		"min-w",
		"min-h",
		"max-w",
		"max-h",
		"p",
		"px",
		"py",
		"pt",
		"pr",
		"pb",
		"pl",
		"m",
		"mx",
		"my",
		"mt",
		"mr",
		"mb",
		"ml",
		"text",
		"bg",
		"border",
		"outline",
		"ring",
		"gap",
		"space-x",
		"space-y",
		"top",
		"right",
		"bottom",
		"left",
		"inset",
		"translate-x",
		"translate-y",
		"scale",
		"rotate",
		"skew-x",
		"skew-y",
		"duration",
		"delay",
		"transition",
		"animate",
		"cursor",
		"grid-cols",
		"grid-rows",
	];

	// Check base class
	for (const valid of validBases) {
		if (baseClass === valid || baseClass.startsWith(`${valid}-`)) {
			return true;
		}
	}

	return false;
}

/**
 * Extract class names from JSX code
 *
 * Looks for className and class attributes
 *
 * @param code - The JSX/TSX code
 * @returns Array of class name strings found
 */
function extractClassNames(
	code: string,
): Array<{ className: string; line: number; column: number }> {
	const results: Array<{ className: string; line: number; column: number }> =
		[];

	// Match className="..." or className='...' or className={`...`}
	const classNameRegex =
		/className\s*=\s*(?:{`([^`]+)`}|"([^"]+)"|'([^']+)')/g;

	let match: RegExpExecArray | null;
	while (
		// biome-ignore lint/suspicious/noAssignInExpressions: standard regex iteration idiom
		(match = classNameRegex.exec(code)) !== null
	) {
		const classValue = match[1] || match[2] || match[3];
		if (classValue) {
			// Calculate line and column
			const upToMatch = code.slice(0, match.index);
			const lines = upToMatch.split("\n");
			const line = lines.length;
			const column = lines[lines.length - 1].length + 1;

			// Split into individual classes
			const classes = classValue.split(/\s+/).filter(Boolean);
			for (const cls of classes) {
				results.push({ className: cls, line, column });
			}
		}
	}

	return results;
}

/**
 * Validate Tailwind CSS classes in code
 *
 * @param code - The code to validate
 * @returns TailwindValidationResult with warnings for unknown classes
 */
export function validateTailwindClasses(
	code: string,
): TailwindValidationResult {
	const warnings: TailwindValidationWarning[] = [];
	const classOccurrences = new Map<
		string,
		Array<{ line: number; column: number }>
	>();

	// Extract all class names
	const extractedClasses = extractClassNames(code);

	// Group by class name to avoid duplicate warnings
	for (const { className, line, column } of extractedClasses) {
		if (!classOccurrences.has(className)) {
			classOccurrences.set(className, []);
		}
		classOccurrences.get(className)?.push({ line, column });
	}

	// Validate each unique class
	for (const [className, locations] of classOccurrences) {
		if (!isValidTailwindClass(className)) {
			// Report at first occurrence
			const first = locations[0];
			warnings.push({
				message: `Unknown Tailwind class: "${className}"`,
				className,
				line: first.line,
				column: first.column,
			});
		}
	}

	return {
		valid: warnings.length === 0,
		warnings,
	};
}
