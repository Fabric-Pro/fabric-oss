---
"fabric-app": patch
---

Send only recent chat history when retrying a failed message, so a long conversation cannot outgrow the workflow payload limit

Fizzy #1997. Retrying a failed chat message passed the entire stored conversation as the workflow input, which travels to the worker in one message capped at 4 MiB. An oversized input is rejected at scheduling — before any code in the workflow runs — so nothing downstream can report it. Long-lived chats also accumulate a permanent context message per retrieval turn, so the history grows even when individual messages are small. Retries now send the most recent 60 messages, which is what the model needs to continue the conversation.
