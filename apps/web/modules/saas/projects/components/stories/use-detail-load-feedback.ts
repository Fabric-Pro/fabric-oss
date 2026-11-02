import { useEffect } from "react";
import { toast } from "sonner";

export function useDetailLoadFeedback(
	open: boolean,
	query: { isError: boolean; isFetching: boolean },
	close: () => void,
	message: string,
) {
	useEffect(() => {
		if (open && query.isError && !query.isFetching) {
			close();
			toast.error(message);
		}
	}, [open, query.isError, query.isFetching, close, message]);
}
