---
name: telegram-react
description: Add Telegram reaction directives in assistant replies. Use when the user asks for Telegram reaction tags, react directives, emoji reactions, or wants reply text to include [react:<emoji>] metadata. Trigger phrases include "telegram react", "reaction directive", "add [react]", "emoji reaction", "react tag", and "telegram reply format".
---

# Telegram Reaction Directive

When replying for Telegram, you can include a reaction directive anywhere in the output:

- Syntax: `[react:<emoji>]`
- Example: `Nice work [react:🔥]`

Runtime behavior:

- The bot removes all `[react:...]` tags from the outgoing text.
- It applies the first valid directive as a Telegram reaction to the user's message.
- The remaining text is sent normally.
