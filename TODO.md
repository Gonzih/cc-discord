# TODO: @gonzih/cc-discord v0.1.3

- [x] Write PLAN.md and TODO.md
- [ ] Create branch feat/per-channel-cron-routing
- [ ] bot.ts: pre-populate snowflakeMap in ClientReady with all cached guild channels
- [ ] bot.ts: make reverseSnowflakeLookup public
- [ ] bot.ts: /crons list — show <#channelId> mention per job
- [ ] notifier.ts: parseNotification returns {text, chatId?}
- [ ] notifier.ts: notify subscriber uses chatId for routing
- [ ] notifier.ts: pollNotifyList uses chatId for routing
- [ ] notifier.test.ts: update tests for new return type
- [ ] Run tests — must pass
- [ ] git diff --staged review
- [ ] git commit + push
- [ ] npm run build && npm version patch && npm publish --access public
- [ ] gh pr create + gh pr merge --squash --auto
