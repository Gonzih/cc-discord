# TODO: Fix Primary Namespace Chat Output Leak

- [ ] Create branch fix/primary-namespace-chat-output-leak
- [x] Run baseline tests (60 passed)
- [ ] notifier.ts: remove notifyChannelId fallback from pmessage handler for primary namespace
- [ ] notifier.test.ts: add test — primary namespace pmessage should be dropped, not sent to Discord
- [ ] npm test — all tests pass
- [ ] git diff --staged — verify changes
- [ ] git commit + push
- [ ] npm run build && npm version patch && npm publish --access public
- [ ] gh pr create + gh pr merge --squash --auto
