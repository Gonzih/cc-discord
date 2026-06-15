# TODO: loop observability layer

- [x] git checkout -b feat/loop-observability
- [ ] src/loop-manager.ts — create LoopState, GateFailure, EvalReport, LoopManager, isGoalMessage, parseEvalReport
- [ ] src/bot.ts — add GuildMessageReactions intent, LoopManager field, handleReactionAdd, createLoopThread, getLoopThreadId, postEvalEmbed, modify handleMessage for loop detection + thread routing
- [ ] src/notifier.ts — extend ParsedNotification with evalReport, update parseNotification, thread routing in flushMetaAgentBuffer / pollOneNamespace / pubsub handler
- [ ] src/loop-manager.test.ts — unit tests for isGoalMessage, parseEvalReport, LoopManager
- [ ] src/notifier.test.ts — tests for eval_report parsing and thread routing
- [ ] npm test — all pass
- [ ] git diff --staged — verify
- [ ] git commit + push
- [ ] npm version patch && npm publish --access public
- [ ] gh pr create + gh pr merge --squash --auto
