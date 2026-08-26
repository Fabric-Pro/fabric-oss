import { Button } from "@ui/components/button";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";

type PaginationProps = {
	className?: string;
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
	totalItems,
	itemsPerPage,
	className,
	onChangeCurrentPage,
	previousLabel = "Previous page",
	nextLabel = "Next page",
}: PaginationProps) => {
	const numberOfPages = Math.ceil(totalItems / itemsPerPage);

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
					{currentPage * itemsPerPage - itemsPerPage + 1} -{" "}
					{currentPage * itemsPerPage > totalItems
						? totalItems
						: currentPage * itemsPerPage}{" "}
					of {totalItems}
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
