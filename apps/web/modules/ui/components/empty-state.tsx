import { cn } from "@ui/lib";
import * as React from "react";

interface EmptyStateProps {
	children: React.ReactNode;
	className?: string;
}

export function EmptyState({ children, className }: EmptyStateProps) {
	return (
		<div
			className={cn(
				"flex flex-col items-center justify-center text-center p-8",
				className,
			)}
		>
			{children}
		</div>
	);
}

interface EmptyStateIconProps {
	children: React.ReactNode;
	className?: string;
}

export function EmptyStateIcon({ children, className }: EmptyStateIconProps) {
	return (
		<div className={cn("mb-4 text-muted-foreground", className)}>
			{children}
		</div>
	);
}

interface EmptyStateTitleProps {
	children: React.ReactNode;
	className?: string;
}

export function EmptyStateTitle({ children, className }: EmptyStateTitleProps) {
	return (
		<h3 className={cn("text-lg font-semibold mb-2", className)}>
			{children}
		</h3>
	);
}

interface EmptyStateDescriptionProps {
	children: React.ReactNode;
	className?: string;
}

export function EmptyStateDescription({
	children,
	className,
}: EmptyStateDescriptionProps) {
	return (
		<p className={cn("text-sm text-muted-foreground mb-4", className)}>
			{children}
		</p>
	);
}

interface EmptyStateActionProps {
	children: React.ReactNode;
	className?: string;
}

export function EmptyStateAction({
	children,
	className,
}: EmptyStateActionProps) {
	return <div className={cn("mt-2", className)}>{children}</div>;
}
