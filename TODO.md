# TODO: Remove hashtag routing from cc-discord

- [x] Write PLAN.md and TODO.md
- [ ] router.ts: Remove parseRoutingTag function and RoutingTag interface
- [ ] router.ts: Update file header comment to remove hashtag routing references
- [ ] router.test.ts: Remove parseRoutingTag import and describe block
- [ ] bot.ts: Remove parseRoutingTag from router import
- [ ] bot.ts: Remove metaAgentStatusKey from @gonzih/cc-wire import
- [ ] bot.ts: Remove #tag / #org/repo routing block in handleMessage
- [ ] bot.ts: Remove "Channel name → meta-agent namespace routing" block in handleMessage
- [ ] Run tests — must pass
- [ ] git diff --staged review
- [ ] npm version patch && npm publish --access public
- [ ] git commit + push on feature branch
- [ ] gh pr create + gh pr merge --squash --auto
