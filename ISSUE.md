# VirtualizedList unmounts the visible row after a big prepend near the top: the window is computed from row estimates that no longer match the spacer

### Description

After a large prepend near the top of a `FlatList` with `maintainVisibleContentPosition` (mVCP), the row the user is reading is unmounted and the list jumps. mVCP corrects the scroll offset, but VirtualizedList recomputes its window from it against estimated row positions that no longer match the spacer it rendered, and the window lands on rows above the viewport.

On an Android emulator, with 100 rows prepended at the top and #58911, #58916 and #58922 applied, this unmounted the reader's row in 12 of 32 runs, and in 0 of 32 with the fix below. It's a race that a busy device loses: 10 of those 12 were with the emulator's CPUs loaded (of 16 runs).

#### Cause

1. After the prepend, rows `[0, initialNumToRender)` render at the top, then a spacer for the rest of the prepended rows, sized at `_averageCellLength` per row (218pt in the traced run), then the window: the old rows, now at 100+.
2. Those top rows are measured, and the average becomes 278pt.
3. The correction's scroll event spends `pendingScrollUpdateCount` and the window is recomputed. [`computeWindowedRenderLimits`](https://github.com/react/react-native/blob/99aefad9fb5/packages/virtualized-lists/Lists/VirtualizeUtils.js#L152-L158) binary-searches `getCellMetricsApprox`, which puts an unmeasured row at `average × index` with the new average. For the rows in the spacer that's thousands of points below where the spacer really puts them, past the measured rows of the window. The offset maps to row 84, and rows 100-117 are unmounted.

It's a race: the render that spends `pendingScrollUpdateCount` also re-sizes the spacer with the new average, and if that correction arrives before the 50ms cells update, the estimates match again. A busy device loses it. #58922 doesn't help, because the layouts come before the correction here.

#### Proposed fix

In `computeWindowedRenderLimits`, find the mounted cell in the current window whose measured frame contains the start of the viewport. If the search landed somewhere else, take the visible range from the mounted cells that cover the viewport. When estimates and measurements agree nothing changes, and the overscan is still from estimates, so the window can't grow. PR to follow.

### Steps to reproduce

1. `git clone https://github.com/mozzius/virtualizedlist-average-mismatch-repro && cd virtualizedlist-average-mismatch-repro/ReproducerApp && yarn install`
2. `yarn test`. It drives a `VirtualizedList` through the sequence above, deterministically: a prepend of 20 at the top, the 2 rendered rows measured at 100 (average 10 → 35.7), then the correction. Stock moves the window to `10..12`, unmounting rows 20-24, which are on screen. With the fix (the repro's patch adds it behind a `preferMeasuredCells` prop) they stay.
3. On a device: `yarn android --mode release`, load the emulator's CPUs (the README has a one-liner), and tap **Repeat** with **Fix** off, then on. It's a race that a responsive device wins. On a loaded emulator the window skipped the visible row in 3 of 20 runs without the fix, 0 of 10 with it.

### React Native Version

0.87.1. The code is unchanged on `main` (99aefad).

### Affected Platforms

Runtime - Android

### Output of `npx @react-native-community/cli info`

```text
System:
  OS: macOS 27.0.1
IDEs:
  Xcode: 27.0/27A266a
npmPackages:
  react: 19.2.3
  react-native: 0.87.1
Android:
  hermesEnabled: true
  newArchEnabled: true
```

Android emulator, API 35. The logic is platform-independent JS; I didn't catch the race on an idle iOS simulator.

### Stacktrace or Logs

Tracing inside VirtualizedList (`L` layout, `S` scroll, `W` window):

```text
MVCPVL L i=0 -->0 len=101 off=0                // the prepended rows are measured
MVCPVL S off=23449 len=27378 p=1               // mVCP's correction: row 100 is at 23449
MVCPVL W 100..117->84..87 off=23449 avg=278    // the window, computed at once, skips row 100
```

With the fix: `pinned 77..80 -> 100..103`, then the window grows up one row at a time with each correction. Logs are in the repro's [`evidence/`](https://github.com/mozzius/virtualizedlist-average-mismatch-repro/tree/main/evidence).

### MANDATORY Reproducer

https://github.com/mozzius/virtualizedlist-average-mismatch-repro

### Screenshots and Videos

No video: on a device it's a race, so `yarn test` is the reliable way to see it. The per-run logs are in the repro's `evidence/`.
