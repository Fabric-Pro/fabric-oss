---
"fabric-app": patch
---

Image generation now calls the AI SDK's stable `generateImage` entry point instead of the deprecated experimental alias, so the image-generation activities keep working when the alias is removed in the next SDK major.
