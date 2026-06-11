# TODO: Full Attachment Handling

- [ ] Create branch feat/attachment-handling
- [ ] npm install
- [ ] Run baseline tests
- [ ] bot.ts: fix audio detection (add .wav, .webm, audio/ prefix)
- [ ] bot.ts: update handleVoice (caption combine + meta-agent routing)
- [ ] bot.ts: update handleImage (meta-agent routing + writeChatMessage)
- [ ] bot.ts: add handleDocument method
- [ ] bot.ts: add doc attachment check in handleMessage
- [ ] src/bot.test.ts: tests for new logic
- [ ] npm test — all tests pass
- [ ] git diff --staged — verify changes
- [ ] git commit + push
- [ ] npm run build && npm version patch && npm publish --access public
- [ ] gh pr create + gh pr merge --squash --auto
