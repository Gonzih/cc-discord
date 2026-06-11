# TODO: Fix channel→namespace mappings lost on restart

- [ ] Create branch fix/channel-mapping-persist
- [ ] Run baseline tests
- [ ] Part 1: add persistChannelMapping call in handleMessage (line ~463)
- [ ] Part 1: add persistChannelMapping call in handleVoice (line ~508)
- [ ] Part 1: add persistChannelMapping call in handleImage (line ~556)
- [ ] Part 1: add persistChannelMapping call in handleDocument (line ~600)
- [ ] Part 2: add "not configured" rejection for unmapped guild channels in handleMessage
- [ ] npm test — all tests pass
- [ ] git diff --staged — verify changes
- [ ] git commit + push
- [ ] npm run build && npm version patch && npm publish --access public
- [ ] gh pr create + gh pr merge --squash --auto
