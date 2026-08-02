# CLI bench — native CLI vs the 9router loop

Question: is coding through each vendor's own CLI faster than the same work
routed through 9router into the sandcastle loop?

**Baseline (already measured, no work needed):** the loop takes **15–23 min per
ticket** wall-clock (first implementer commit → last reviewer commit), running
3 tickets in parallel unattended.

Four tickets are reserved (label removed so the loop won't take them). Same
prompt for all four — that is what makes the comparison fair.

| tool | ticket | branch |
| --- | --- | --- |
| `claude` | #47 U02 ใบขอซื้อ (PR) + อนุมัติ/ปฏิเสธ | `bench/claude-47` |
| `codex` | #54 U09 รายงานมูลค่าสต๊อก (valuation) | `bench/codex-54` |
| `kimi` | #56 U11 Entitlement โมดูล "+สต๊อก" | `bench/kimi-56` |
| `agy` | #51 U06 โอนสาขา: ใบขอโอน (TR) | `bench/agy-51` |

## Run one (repeat per tool)

```bash
cd ~/Desktop/NTD/cFoodStory
git checkout -b bench/<tool>-<N> main

date +%s > /tmp/bench-<tool>          # start clock
<tool>                                # claude | codex | kimi | agy
```

Paste this prompt, unchanged, into whichever tool you're testing:

```
Implement GitHub issue #<N> in this repo. Read it first: gh issue view <N>

Follow .sandcastle/workspace-hint.md for how to run this repo's checks, and
.sandcastle/CODING_STANDARDS.md for conventions. Both checks must pass before
you commit. Commit on the current branch when done. Do not push.
```

When it reports done:

```bash
echo "$(( $(date +%s) - $(cat /tmp/bench-<tool>) )) sec" 
git log --oneline main..HEAD
git diff --stat main..HEAD
```

## Score it

Wall-clock is only half. Also check, per tool:

- did the repo's real checks pass, or did it claim green without running them?
- tests added for the new behaviour?
- did it follow the spec in the issue, or a simplified version of it?
- how many times did you have to intervene? (the loop's number is zero)

## Reading the result

- Native CLI clearly faster **and** equal quality → move important work to that
  CLI; keep the loop for overnight volume.
- Similar or slower → the loop's value stands: 3 tickets in parallel, no
  intervention, while you sleep.

Whatever each tool produces is real work — merge the good ones and close the
issue. Nothing here is throwaway.
