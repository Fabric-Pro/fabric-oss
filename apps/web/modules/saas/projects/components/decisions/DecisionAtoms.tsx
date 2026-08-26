"use client";

import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { useTranslations } from "next-intl";
import { useState } from "react";
import {
	avatarColorClass,
	type DecisionDuration,
	DOMAIN_CONFIG,
	DURATION_CONFIG,
	formatDecisionDateTime,
	formatDecisionDateTimeUtc,
	initialsOf,
	isDecisionDomain,
	TYPE_TAG_CLASS,
} from "./constants";

/**
 * A decision timestamp in the viewer's locale (full date + time), with a
 * Local / UTC breakdown on hover so collaborators across time zones agree on
 * exactly when a decision was made.
 */
export function DecisionDateTime({
	value,
	className,
}: {
	value: string | Date;
	className?: string;
}) {
	const local = formatDecisionDateTime(value);
	if (!local) {
		return null;
	}
	const utc = formatDecisionDateTimeUtc(value);
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span className={cn("cursor-default", className)}>{local}</span>
			</TooltipTrigger>
			<TooltipContent surface="popover">
				<span className="block">
					<span className="text-muted-foreground">Local: </span>
					{local}
				</span>
				<span className="block">
					<span className="text-muted-foreground">UTC: </span>
					{utc}
				</span>
			</TooltipContent>
		</Tooltip>
	);
}

/**
 * The tagging pill stack (type · duration · Priority) shown wherever a decision
 * is summarised — card row, table row and detail sheet. One component so a
 * styling or copy change lands in every surface at once.
 */
export function DecisionTagPills({
	decisionType,
	duration,
	priorityFlagged,
	className,
}: {
	decisionType?: { name: string } | null;
	duration?: DecisionDuration | null;
	priorityFlagged?: boolean;
	className?: string;
}) {
	const pill =
		"inline-flex items-center rounded-full border px-2 py-0.5 font-medium text-[11px] leading-none";
	return (
		<>
			{decisionType?.name && (
				<span className={cn(pill, TYPE_TAG_CLASS, className)}>
					{decisionType.name}
				</span>
			)}
			{duration && (
				<span
					className={cn(
						pill,
						DURATION_CONFIG[duration].tagClassName,
						className,
					)}
				>
					{DURATION_CONFIG[duration].label}
				</span>
			)}
			{priorityFlagged && (
				<span
					className={cn(
						pill,
						"border-primary/30 bg-primary/10 text-primary-ink",
						className,
					)}
				>
					Priority
				</span>
			)}
		</>
	);
}

/** Small category/area tag (Infrastructure, Data, AI, …). Renders nothing for unknown domains. */
export function DomainTag({
	domain,
	className,
}: {
	domain?: string | null;
	className?: string;
}) {
	if (!isDecisionDomain(domain)) {
		return null;
	}
	const cfg = DOMAIN_CONFIG[domain];
	return (
		<span
			className={cn(
				"inline-flex items-center rounded-full border px-2 py-0.5 font-medium text-[11px] leading-none",
				cfg.tagClassName,
				className,
			)}
		>
			{cfg.label}
		</span>
	);
}

export interface AvatarPerson {
	name: string;
	image?: string | null;
}

/**
 * A member avatar — their profile image when available, otherwise deterministic
 * colored initials. Ringed so it reads cleanly in an overlapping stack.
 */
export function Avatar({
	name,
	image,
	size = "sm",
	className,
}: {
	name: string;
	image?: string | null;
	size?: "sm" | "md";
	className?: string;
}) {
	const t = useTranslations("tooltips.decisions");
	const [broken, setBroken] = useState(false);
	const sizeCls = size === "sm" ? "size-6 text-[10px]" : "size-7 text-[11px]";
	if (image && !broken) {
		return (
			// biome-ignore lint/performance/noImgElement: tiny avatar, external member image — next/image domain config not warranted
			<img
				src={image}
				alt={name}
				onError={() => setBroken(true)}
				className={cn(
					"inline-block shrink-0 rounded-full object-cover ring-2 ring-background",
					sizeCls,
					className,
				)}
			/>
		);
	}
	return (
		<span
			className={cn(
				"inline-flex shrink-0 items-center justify-center rounded-full font-medium text-white ring-2 ring-background",
				sizeCls,
				avatarColorClass(name),
				className,
			)}
		>
			{/* The initials are a visual shorthand — read aloud they are noise, so
				they are hidden and the full name is exposed instead. No tooltip
				here: every `Avatar` renders inside `AvatarStack`, which already
				carries one, and Radix does not dedupe nested tooltips. */}
			<span aria-hidden="true">{initialsOf(name)}</span>
			<span className="sr-only">{t("memberName", { name })}</span>
		</span>
	);
}

/** Overlapping avatar stack — shows up to `max` members, then a "+N" chip. */
export function AvatarStack({
	people,
	max = 3,
}: {
	people: AvatarPerson[];
	max?: number;
}) {
	const t = useTranslations("tooltips.decisions");
	if (people.length === 0) {
		return null;
	}
	const shown = people.slice(0, max);
	const extra = people.length - shown.length;
	return (
		// The stack is not focusable, so this tooltip is a pointer affordance —
		// it is the only place the names behind the "+N" chip are spelled out.
		// Assistive tech already reads each shown avatar's `sr-only` name plus
		// the "+N" count, so no duplicate list is repeated here.
		<Tooltip>
			<TooltipTrigger asChild>
				<span className="flex -space-x-2">
					{shown.map((p, i) => (
						<Avatar
							key={`${p.name}-${i}`}
							name={p.name}
							image={p.image}
						/>
					))}
					{extra > 0 && (
						<span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-muted font-medium text-[10px] text-muted-foreground ring-2 ring-background">
							+{extra}
						</span>
					)}
				</span>
			</TooltipTrigger>
			<TooltipContent>
				{t("memberList", {
					names: people.map((p) => p.name).join(", "),
				})}
			</TooltipContent>
		</Tooltip>
	);
}
