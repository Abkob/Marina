# Copilot redesign — 24 September 2026

The conversation now uses Marina’s white canvas, slate typography and indigo controls. One header replaces the duplicate mobile header; schedule and goal panels open from Chat tools. Assistant replies sit directly on the canvas, with matching light proposal and calendar cards.

Interaction changes:

- Multiline composer with separate attachment/tools/send controls and 44px touch targets. Return inserts a new line on phones; desktop Enter sends and Shift+Enter inserts a line.
- VisualViewport height and offset keep the conversation above the keyboard. Navigation remains hidden until keyboard dismissal completes. Pinch zoom is left alone.
- Send retains typing focus. Replies do not reopen the phone keyboard. A keyboard-dismiss control is available while typing.
- Conversation scrolling stays within the message area. Reading earlier messages suspends automatic scrolling; Latest returns to the end. The button follows the composer as the draft grows.
- Searchable history, confirmation before deletion, copy response, model selector and planning tools in a shared sheet.
- Nemotron is the default in local configuration and Vercel. DeepSeek remains a selectable model and fallback.

References consulted:

- [ChatGPT iOS FAQ](https://help.openai.com/en/articles/7885016-chatgpt-ios-app-faq): history entry point and confirming conversation deletion.
- [Claude conversation management](https://support.claude.com/en/articles/8230524-delete-or-rename-a-conversation): mobile conversation management patterns.
- [MDN VisualViewport](https://developer.mozilla.org/en-US/docs/Web/API/VisualViewport): visible viewport resizing and offset when a keyboard covers the layout viewport.

Validation: full project check passed (582 tests, TypeScript, production build, serverless entry and Vercel preflight). Added viewport regression coverage for keyboard appearance/dismissal, pinch zoom and cleanup. Disposable local browser fixtures exercise multiline typing, send, a suggested plan’s time adjustments, saved history and 375px/320px layouts without changing real workspace data. Keyboard geometry is simulated; physical iPhone Safari and Home Screen keyboard behavior cannot be verified from this desktop browser.
