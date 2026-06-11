# TODO: Typing indicator for meta-agent routing

- [ ] Create branch fix/meta-agent-typing
- [ ] Run baseline tests
- [ ] bot.ts: add metaAgentTypingTimers field
- [ ] bot.ts: add startMetaAgentTyping private method
- [ ] bot.ts: add stopMetaAgentTyping public method
- [ ] bot.ts: call startMetaAgentTyping in handleMessage meta-agent path
- [ ] bot.ts: call startMetaAgentTyping in handleVoice meta-agent path
- [ ] bot.ts: call startMetaAgentTyping in handleImage meta-agent path
- [ ] bot.ts: call startMetaAgentTyping in handleDocument meta-agent path
- [ ] bot.ts: clear metaAgentTypingTimers in stop()
- [ ] notifier.ts: call bot.stopMetaAgentTyping in flushMetaAgentBuffer
- [ ] notifier.test.ts: add stopMetaAgentTyping to buildMocks()
- [ ] notifier.test.ts: add test that flush stops typing
- [ ] npm test — all pass
- [ ] git diff --staged — verify
- [ ] git commit + push
- [ ] npm run build && npm version patch && npm publish --access public
- [ ] gh pr create + gh pr merge --squash --auto
