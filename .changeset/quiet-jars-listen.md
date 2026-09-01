---
"fabric-app": patch
---

Backlog analysis now retrieves context across distinct documents, so one long meeting transcript can no longer hide a project's PRDs and decisions (Fizzy #2316)

Project-context retrieval asks the vector store for `topK` chunks and dedupes by document
afterwards, so a document split into many chunks can occupy every slot and leave dedup with that
one document. The agent's query path opted into diversification for exactly this reason; backlog
analysis never did, and it is the path that reads a project's whole corpus. Storing meeting
transcripts unabridged makes the crowding materially more likely, so this turns diversification on
there too.

Diversification previously implied skipping reranking — a latency exemption for the agent's in-line
path, applied by the branch rather than requested by the caller. Reranking is on by default per
project, so switching a background caller to diversified retrieval would have silently dropped its
relevance ordering. The exemption is now an explicit `skipRerank` option: the agent path asks for
it and behaves exactly as before, while backlog analysis gets both diversity and reranking. Both
exit paths share one rerank helper, so a failed rerank still falls back to the unreranked results
rather than costing the caller its context.
