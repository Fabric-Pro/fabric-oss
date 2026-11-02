"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

/** Observe fragments from router navigation and native hash changes. */
export function useLocationHash(): string {
	const searchParams = useSearchParams();
	const [hash, setHash] = useState("");

	useEffect(() => {
		// A hash-only soft navigation fires no `hashchange`, but in Next 16 it
		// still gives `useSearchParams()` a new identity: the router memoizes
		// search params on the canonical URL, which includes the hash.
		setHash(window.location.hash);
	}, [searchParams]);

	useEffect(() => {
		const updateHash = () => setHash(window.location.hash);
		window.addEventListener("hashchange", updateHash);
		return () => window.removeEventListener("hashchange", updateHash);
	}, []);

	return hash;
}
