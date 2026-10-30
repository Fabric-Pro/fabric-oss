"use client";

import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { cn } from "@ui/lib";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

type PaginationProps = {
	className?: string;
	formatRange?: (from: number, to: number, total: number) => string;
	pageLabel?: (page: number) => string;
	navigationLabel?: string;
	goToPageLabel?: string;
	goLabel?: string;
	pageRangeError?: (lastPage: number) => string;
	totalItems: number;
	itemsPerPage: number;
	currentPage: number;
	onChangeCurrentPage: (page: number) => void;
	/** Accessible names for the icon-only nav buttons. Override when several
	 *  pagers share one page so screen-reader users can tell them apart. */
	previousLabel?: string;
	nextLabel?: string;
};

const Pagination = ({
	currentPage,
	formatRange = (from, to, total) => `${from} - ${to} of ${total}`,
	pageLabel = (page) => `Page ${page}`,
	navigationLabel = "Pagination",
	goToPageLabel = "Go to page",
	goLabel = "Go",
	pageRangeError = (lastPage) => `Enter a page from 1 to ${lastPage}`,
	totalItems,
	itemsPerPage,
	className,
	onChangeCurrentPage,
	previousLabel = "Previous page",
	nextLabel = "Next page",
}: PaginationProps) => {
	const numberOfPages = Math.ceil(totalItems / itemsPerPage);
	const inputId = useId();
	const pageInputRef = useRef<HTMLInputElement>(null);
	const errorId = `${inputId}-error`;
	const [pageInput, setPageInput] = useState("");
	const [invalidPage, setInvalidPage] = useState(false);
	useEffect(() => {
		setPageInput("");
		setInvalidPage(false);
	}, [currentPage, numberOfPages]);

	if (numberOfPages > 1) {
		const page = Math.min(
			numberOfPages,
			Math.max(1, Math.trunc(currentPage) || 1),
		);
		const visiblePages = [
			...new Set([1, numberOfPages, page - 1, page, page + 1]),
		]
			.filter((value) => value >= 1 && value <= numberOfPages)
			.sort((a, b) => a - b);
		const pages: Array<number | string> = [];
		for (const value of visiblePages) {
			const previous = pages.at(-1);
			if (typeof previous === "number") {
				if (value - previous === 2) {
					pages.push(previous + 1);
				} else if (value - previous > 2) {
					pages.push(`gap-${previous}`);
				}
			}
			pages.push(value);
		}
		return (
			<nav
				aria-label={navigationLabel}
				className={cn("min-w-0 max-w-full", className)}
			>
				<div className="flex min-w-0 flex-wrap items-center justify-center gap-1">
					<Button
						type="button"
						variant="ghost"
						size="icon"
						aria-label={previousLabel}
						disabled={page <= 1}
						onClick={() => onChangeCurrentPage(page - 1)}
					>
						<ChevronLeftIcon aria-hidden="true" />
					</Button>
					{pages.map((value) =>
						typeof value === "number" ? (
							<Button
								key={value}
								type="button"
								size="sm"
								className="min-w-9 tabular-nums"
								variant={value === page ? "primary" : "ghost"}
								aria-label={pageLabel(value)}
								aria-current={
									value === page ? "page" : undefined
								}
								onClick={() => onChangeCurrentPage(value)}
							>
								{value}
							</Button>
						) : (
							<span
								key={value}
								aria-hidden="true"
								className="px-1 text-muted-foreground"
							>
								…
							</span>
						),
					)}
					<Button
						type="button"
						variant="ghost"
						size="icon"
						aria-label={nextLabel}
						disabled={page >= numberOfPages}
						onClick={() => onChangeCurrentPage(page + 1)}
					>
						<ChevronRightIcon aria-hidden="true" />
					</Button>
					<form
						noValidate
						className="flex min-w-0 max-w-full flex-wrap items-center justify-center gap-2"
						onSubmit={(event) => {
							event.preventDefault();
							if (pageInputRef.current?.validity.badInput) {
								setInvalidPage(true);
								return;
							}
							if (pageInput.trim() === "") {
								return;
							}
							const targetPage = Number(pageInput);
							if (
								!Number.isSafeInteger(targetPage) ||
								targetPage < 1 ||
								targetPage > numberOfPages
							) {
								setInvalidPage(true);
								return;
							}
							setInvalidPage(false);
							onChangeCurrentPage(targetPage);
						}}
					>
						<label htmlFor={inputId} className="text-sm">
							{goToPageLabel}
						</label>
						<Input
							id={inputId}
							ref={pageInputRef}
							aria-label={`${goToPageLabel}, ${navigationLabel}`}
							type="number"
							min={1}
							max={numberOfPages}
							step={1}
							value={pageInput}
							onChange={(event) => {
								setPageInput(event.target.value);
								setInvalidPage(false);
							}}
							aria-invalid={invalidPage || undefined}
							aria-describedby={invalidPage ? errorId : undefined}
							className="w-20 min-w-0 max-w-full tabular-nums"
						/>
						<Button
							type="submit"
							size="sm"
							variant="outline"
							aria-label={`${goLabel}, ${navigationLabel}`}
						>
							{goLabel}
						</Button>
					</form>
				</div>
				{invalidPage && (
					<p
						id={errorId}
						role="alert"
						className="mt-2 text-center text-sm text-destructive"
					>
						{pageRangeError(numberOfPages)}
					</p>
				)}
				<p className="mt-2 text-center text-sm text-muted-foreground tabular-nums">
					{formatRange(
						(page - 1) * itemsPerPage + 1,
						Math.min(page * itemsPerPage, totalItems),
						totalItems,
					)}
				</p>
			</nav>
		);
	}

	return (
		<div className={className}>
			<div className="flex items-center justify-center gap-4">
				<Button
					type="button"
					variant="ghost"
					size="icon"
					aria-label={previousLabel}
					disabled={currentPage === 1}
					onClick={() => onChangeCurrentPage(currentPage - 1)}
				>
					<ChevronLeftIcon />
				</Button>
				<span className="text-gray-500 text-sm">
					{formatRange(
						(currentPage - 1) * itemsPerPage + 1,
						Math.min(currentPage * itemsPerPage, totalItems),
						totalItems,
					)}
				</span>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					aria-label={nextLabel}
					disabled={currentPage === numberOfPages}
					onClick={() => onChangeCurrentPage(currentPage + 1)}
				>
					<ChevronRightIcon />
				</Button>
			</div>
		</div>
	);
};
Pagination.displayName = "Pagination";

export { Pagination };
