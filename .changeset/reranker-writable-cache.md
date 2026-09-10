---
"fabric-app": patch
---

Store local reranker model files in the runtime temporary directory so non-root deployments can load and reuse the cross-encoder model.
