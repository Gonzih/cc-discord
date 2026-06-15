# TODO: fix cc-agent job completion notifications

- [ ] git checkout -b fix/notification-routing
- [ ] src/notifier.ts — import notifyChannel; subscribe to legacy channel; handle in message handler
- [ ] src/notifier.ts — add getChannelIdForNamespace to resolveNotifyChannel + startNotifier; fix pollNotifyList
- [ ] src/bot.ts — add getChannelIdForNamespace() public method
- [ ] src/index.ts — pass getChannelIdForNamespace to startNotifier
- [ ] src/notifier.test.ts — add tests for legacy channel and namespace lookup
- [ ] npm test — all pass
- [ ] git diff --staged — verify
- [ ] git commit + push
- [ ] npm version patch && npm publish --access public
- [ ] gh pr create + gh pr merge --squash --auto
