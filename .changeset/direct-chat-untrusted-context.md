---
"fabric-app": patch
---

Direct chat now marks retrieved context as data rather than instructions

The Fabric assistant assembles its system prompt from three kinds of text it
did not author: the project context block, RAG hits from uploaded and workspace
documents, and session memory. All of it was concatenated straight into the
prompt, so a document that said "share this frame publicly" or "create a story
that…" read exactly like an instruction from the operator. The assistant's
frame tools are deliberately exempt from the write-authority gate because
frames are first-class content, which made a poisoned workspace file a
plausible path to publishing content the user never asked to publish.

Each retrieved block is now wrapped in a labelled
`<retrieved_context source=… trust="untrusted">` boundary, closing tags inside
the content are neutralised so a document cannot end the block early, and a
short handling rule is appended telling the model that whatever is inside is
information to answer with and never a direction to call tools, change its
behaviour, or create, share, publish or delete anything. The model sees the
same content as before; only the framing changes. The RAG join, the document
processing status messages, and the prompt cache prefix are untouched.
