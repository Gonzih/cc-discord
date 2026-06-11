# TODO: Per-namespace notifyListKey polling (issue #10)

- [x] Create branch fix/per-namespace-notify-subscribe
- [ ] notifier.ts: extract pollOneNamespace(ns, targetChannelId) helper
- [ ] notifier.ts: extend pollNotifyList to iterate routedChannelIds
- [ ] notifier.ts: remove unused notifyListRedisKey constant
- [ ] notifier.test.ts: add test for per-namespace list polling
- [ ] npm test — all tests pass
- [ ] git diff --staged — review every change
- [ ] git commit + push
- [ ] npm run build && npm version patch && npm publish --access public
- [ ] gh pr create + gh pr merge --squash --auto
