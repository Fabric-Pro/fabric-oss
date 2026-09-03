---
"fabric-app": patch
---

Make the shared document prefix of RAG chunk enrichment cacheable, so each chunk no longer re-bills the whole document (Fizzy #2362)

Contextual enrichment calls the model once per chunk and used to concatenate the document and the chunk into one user message. Prompt caching can only reuse a prefix that ends on a message boundary, so nothing about the document could ever be cached, and on a one-shot completion the only breakpoint that fires is the end of the system run. The document now lives in the system prompt, byte-identical across every chunk of a document, and the AI SDK call marks it with the provider-agnostic cache breakpoint (the Databricks compat shim marks the system run itself).

The default document context cap rises from 8000 to 24000 characters. Anthropic's minimum cacheable prefix is model-dependent and not monotonic: the model the enrichment task resolves to in production needs 4096 tokens, and 8000 characters (~2000 tokens) could never reach it, so a perfectly placed breakpoint was still silently ignored. Production enrichment prompts run ~4.4 characters per token; 24000 characters is ~5000-5500 tokens. Profiling recent project contexts put ~77% of chunks in documents long enough to cache at the new cap and ~14% in the band that now carries more context at full rate; below the old cap nothing changes.

The document is untrusted content and now sits in the system role, because a marked user message has no breakpoint on the Databricks path (the shim deliberately marks only the system run on one-shot calls). Containment is explicit: the instructions declare the document and chunk untrusted data, the prompt's own delimiter tags are escaped inside them, and the one-sentence output is only ever prepended to a chunk of the same document, whose text is already embedded verbatim.

Adds packages/rag/lib/chunking/__tests__/contextual-enrichment.test.ts pinning the system/user split, the delimiter containment, and the cache marker on the tenant-backed path.
