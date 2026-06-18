# TODO: reduce Discord noise

- [ ] Fix 1: add cron-fire filter in parseNotification (return null for is_cron+⏰ prefix)
- [ ] Fix 2: add length gate in flushMetaAgentBuffer (skip rawText.length < 20)
- [ ] Add tests for both new behaviors in notifier.test.ts
- [ ] npm test — all pass
- [ ] git diff --staged — verify
- [ ] git commit + push
- [ ] npm version patch && npm publish --access public
- [ ] gh pr create + gh pr merge --squash --auto
