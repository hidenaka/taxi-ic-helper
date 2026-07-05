# Queue Movement Direction Design

## Goal
Improve Haneda taxi pool queue movement measurement so visible queue motion is separated into replenishment and departure-like emptying, instead of treating every front-density change as the same event.

## Context
Mac mini currently records `movement-shift-history.jsonl` every 60 seconds and `slot-occupancy-history.jsonl` about every 30 seconds. The existing forecast path counts replenishment from `frontDensity` transitions, but camera validation showed some events are cars leaving a front box and exposing brighter pavement.

## Design
Keep the existing front-density event detector as the movement signal source, then classify each detected event with nearby occupancy history when available.

- If the median occupancy after the event is higher than before it, classify it as `replenish`.
- If the median occupancy after the event is lower than before it, classify it as `departure`.
- If occupancy is unavailable or unchanged, fall back to the front-density transition direction.
- Existing `actual` values remain replenishment counts only.
- Additional JSON fields may expose departure counts without breaking existing readers.

## Files
- `scripts/lib/advance-counter.mjs`: expose directional transition detection.
- `scripts/lib/advance-forecast.mjs`: add movement classification and keep `binAdvanceCounts` compatibility.
- `scripts/publish-advance-forecast.mjs`: include departure count in `current.stalls[*]`.
- `tests/advance-counter.test.mjs`: cover directional transition detection.
- `tests/advance-forecast.test.mjs`: cover occupancy-based direction override.

## Validation
Use TDD with `node --test tests/advance-counter.test.mjs tests/advance-forecast.test.mjs`, then run the full `npm test`.
