# TODO: fix ⏰ echo and duplicate notification bugs

- [ ] git checkout -b fix/cron-echo-dedup
- [ ] src/notifier.ts — Bug 1: suppress cron echo in chat:incoming handler
- [ ] src/notifier.ts — Bug 2A: in pollOneNamespace, check in-memory dedup first
- [ ] src/notifier.ts — Bug 2B: in message handler, fire-and-forget Redis mark after in-memory mark
- [ ] src/notifier.test.ts — add chatIncomingChannel import
- [ ] src/notifier.test.ts — update buildMocks with lpush, ltrim, publish methods
- [ ] src/notifier.test.ts — add tests for Bug 1 (⏰ and [cron] suppression, normal pass-through)
- [ ] src/notifier.test.ts — add test for Bug 2 (cross-path dedup: pub/sub then list poll)
- [ ] npm test — all pass
- [ ] git diff --staged — verify
- [ ] git commit + push
- [ ] npm version patch && npm publish --access public
- [ ] gh pr create + gh pr merge --squash --auto
