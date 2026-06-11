# TODO: cc-wire 0.1.6 integration

- [x] Install @gonzih/cc-wire@0.1.6 and verify exports
- [x] Write PLAN.md and TODO.md
- [ ] Create branch chore/cc-wire-0.1.6
- [ ] notifier.ts: import NotificationPayload, Transport, notifyListKey from cc-wire
- [ ] notifier.ts: replace inline type cast with NotificationPayload in parseNotification()
- [ ] notifier.ts: add routing filter (return null when discord excluded)
- [ ] notifier.ts: update parseNotification return type to ParsedNotification | null
- [ ] notifier.ts: update both callers to handle null
- [ ] notifier.ts: use notifyListKey(namespace) instead of local notifyListKey variable
- [ ] notifier.test.ts: add routing filter tests
- [ ] npm test — must pass
- [ ] git diff --staged review
- [ ] git commit + push
- [ ] npm run build && npm version patch && npm publish --access public
- [ ] gh pr create + gh pr merge --squash --auto
