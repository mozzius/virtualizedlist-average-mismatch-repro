# VirtualizedList unmounts the visible row after a big prepend near the top: its row estimates no longer match the spacer it rendered

After 100 rows are prepended near the top of a `FlatList` with
`maintainVisibleContentPosition` (mVCP), native mVCP corrects the scroll offset
so the reader stays on their row. VirtualizedList then recomputes its render
window from that offset, but against estimated row positions that no longer
match the spacer it rendered above the window. The window lands on rows above
the viewport, the reader's row is unmounted, and the list jumps.

- **Upstream issue:** ISSUE_URL
- **Upstream fix:** PR_URL
- **Found in:** the Bluesky app, which restores a feed position and then
  prepends up to 100 newer posts above the reader, often while the device is
  busy starting up

## Environment

| | |
| --- | --- |
| react-native | 0.87.1 (the code is unchanged on `main` at 99aefad) |
| react | 19.2.3 |
| Architecture | New (Fabric), Hermes |
| Reproduced on | Android emulator (API 35); the logic is platform-independent JS |
| Dependencies | Only the template's, plus `patch-package` (see below) |

## The bug without a device

```bash
cd ReproducerApp
yarn install            # postinstall applies patches/ with patch-package
yarn test
```

[`__tests__/averageMismatch.test.tsx`](ReproducerApp/__tests__/averageMismatch.test.tsx)
drives a `VirtualizedList` through its private layout and scroll handlers, as
React Native's own tests do. It is deterministic:

1. 100 rows of 10, at the top. Rows 0-4 are rendered and measured: average 10.
2. 20 rows are prepended. The window moves to the old rows' new indices,
   20-24. Rows 0-1 render for the initial region, then a spacer for rows 2-19
   at the average: 180.
3. Rows 0-1 lay out at 100 each, so the old row 0 (index 20) is at 380. That
   raises the average to 250 / 7 = 35.7, and VirtualizedList now estimates rows
   2-19 at 71-714, overlapping rows 20-24, which are measured at 380-430.
4. mVCP's correction arrives: offset 380.

Stock moves the window to `10..12`, unmounting rows 20-24, the rows on screen.
With the fix the window is `10..24`: it keeps rows 20-24, and renders one batch
of rows above them, toward the overscan the estimates ask for, which re-renders
the spacer with the new average. Output: [`evidence/jest.log`](evidence/jest.log).
The same test is the regression test in the upstream PR, where it fails on
`main`.

## What happens on a device

From the Android verification app Bluesky used to test its patches (`MVCPVL`
lines are tracing inside VirtualizedList; 100 rows prepended at the top):

```text
MVCPVL L i=0 -->0 len=101 off=0                     // the prepended rows' layouts arrive first
MVCPVL S off=23449 len=27378 p=1                    // mVCP's correction: row 100 (the reader's) is at 23449
MVCPVL W 100..117->84..87 off=23449 avg=278         // the window, computed right away, skips row 100
```

1. After the prepend, rows `[0, initialNumToRender)` render at the top, then a
   spacer for the rest of the prepended rows, sized at `_averageCellLength` per
   row (218 at that render), then the window: the reader's rows, now 100-117.
2. The rows above the spacer are measured, and the average becomes 278.
3. The correction's scroll event spends `pendingScrollUpdateCount`, and the
   window is recomputed. `computeWindowedRenderLimits` binary-searches
   `getCellMetricsApprox`, which puts an unmeasured row at `average × index`
   with the *new* average. Row 84 is estimated at 23352-23630; on screen it is
   inside the spacer, thousands of points higher. The offset maps to row 84,
   and rows 100-117 are unmounted.

On a fast device this is a race and the list usually survives it: the render
that spends `pendingScrollUpdateCount` also re-sizes the spacer with the new
average, and if its correction arrives before VirtualizedList's 50ms cells
update, the estimates match again. A busy device loses the race.
#58922 (waiting for a correction after a layout) doesn't help: the layouts
arrive before the correction, and the window is recomputed after it.

[`ISSUE.md`](ISSUE.md) is the upstream report.

## The fix

In `computeWindowedRenderLimits`, before trusting the search, find the mounted
cell in the current window whose measured frame contains the start of the
viewport. If the search landed somewhere else (other than the cell just before
it, at a shared boundary), take the visible range from the mounted cells that
cover the viewport:

```js
const mounted = mountedCellsInViewport(visibleBegin, visibleEnd, prev, ...);
if (mounted != null && first !== mounted.first && first !== mounted.first - 1) {
  first = mounted.first;
  last = Math.max(last ?? mounted.last, mounted.last);
  // overscanFirst/overscanLast widened to include them, if needed
}
```

When the estimates agree with the measured frames, nothing changes: every
existing VirtualizedList test passes unmodified. The overscan is still found from
estimates, so the window can't grow any further than it already could, and a
fling is unaffected.

## Results

### Android, the verification app

The verification app Bluesky used to test its VirtualizedList patches on RN
0.87.1 (Android emulator, API 35, debug build), with #58911, #58916 and #58922
applied in both columns: 100 rows prepended at the top (`S3-top-100`), or below
a leading row like Bluesky's composer prompt (`B-lead-100`, minIndexForVisible
1), each with `removeClippedSubviews` on and off, 4 runs each. "Loaded" runs had
four busy loops inside the emulator. The results files are in
[`evidence/verification-app/`](evidence/verification-app/).

| 32 runs each | Without the fix | With the fix |
| --- | --- | --- |
| Window skipped above the reader right after the correction (this bug) | **12** (2 of 16 quiet, 10 of 16 loaded) | **0** |
| Reader's row held | 15 | 29 |
| Other failures | 5: the window jumped *below* the reader (4), a drift (1) | 3: the window jumped below the reader once, at host load 54; a probe timeout with no visible drift; the stuck mount below |

The window jumping below the reader is a different ordering: a correction's
scroll event handled before the layouts of the render that caused it. The stuck
mount (no scroll event at all after the prepend, with `MissingViewState` soft
exceptions) is native, and shows up in every mode.

Without #58922, the fix alone isn't enough. On stock 0.87.1 under load the row
held in 0 of 8 runs, and with only the fix in 2 of 8: most of the others kept
the row at the correction (`99..117`) and lost it one render later, when the
spacer was re-estimated (`70..73`). That second step is
[#58921](https://github.com/react/react-native/issues/58921).

Moving prepends (`S2-momentum-100`, `S2-drag-100`, `S3-flingtop-100`, 4 runs
each) behaved the same with and without the fix, and the window stayed bounded
(at most 39 cells with the fix, 34 without).

### Android, this app

Release build, Android emulator (API 35), PRs on, `removeClippedSubviews`
off, with four busy loops inside the emulator:

| | Fix off | Fix on |
| --- | --- | --- |
| Runs | 20 | 10 |
| Held | 14 | 9 |
| Window skipped above `r1`, `r1` unmounted (this bug) | **3** | **0** |
| `r1` still mounted but 500-1500pt lower (a correction missed) | 3 | 0 |
| No correction at all (native, the stuck mount) | 0 | 1 |

Without the busy loops it held 10 of 10 either way: on a responsive device the
spacer's correction wins the race. On an idle iOS simulator (iPhone 17 Pro, iOS
26.5, Release) none of 40 runs jumped without the fix, across variations of this
app, so there are no iOS numbers here; the code involved is the same.

## Running it

```bash
cd ReproducerApp
yarn install
yarn android --mode release   # the numbers above; a debug build works too, over `yarn start`
```

It's a race that a responsive device wins, so load the device. For an Android
emulator, four busy loops inside it did it:

```bash
for i in 1 2 3 4; do adb shell "nohup sh -c 'while :; do :; done' >/dev/null 2>&1 &"; done
# restart the emulator to stop them
```

Tap **Repeat**. Each of its 10 rounds builds a fresh list of 200 rows
(60-200pt), scrolls it to y=300, waits for VirtualizedList to finish filling
in its window, notes the row at the top (`r1` at -117pt), and prepends 100 tall
rows (250-500pt). Once the list is still, it checks where `r1` is: `HELD` if
it's where it was, `JUMPED` if not.

The list uses Bluesky's feed settings, `windowSize={9}` and
`maxToRenderPerBatch={1}`, and each row renders 60 small views, so mounting one
costs about what a feed post does. `removeClippedSubviews` is off, to keep
Android's clipping out of the picture.

### Toggles

Both come from
[`patches/@react-native+virtualized-lists+0.87.1.patch`](ReproducerApp/patches/@react-native+virtualized-lists+0.87.1.patch),
which `patch-package` applies on `yarn install`. Each switch resets the list.
Off, the patched code returns before reading anything, so VirtualizedList runs
stock 0.87.1.

- **PRs** (on by default): two open PRs that this bug otherwise hides behind.
  [#58922](https://github.com/react/react-native/pull/58922): without it, once
  the fix has kept the row, the spacer re-render that follows loses it again
  ([#58921](https://github.com/react/react-native/issues/58921)).
  [#58911](https://github.com/react/react-native/pull/58911): on a slow device
  the prepend can land in the same render as a cells update and be skipped
  ([#58909](https://github.com/react/react-native/issues/58909)).
- **Fix**: the fix above (`preferMeasuredCells`). The proposed fix has no prop.

## Logs

| File | What |
| --- | --- |
| [`evidence/jest.log`](evidence/jest.log) | `yarn test` |
| [`evidence/android-repro.log`](evidence/android-repro.log) | This app's runs above |
| [`evidence/verification-app/trace-without-fix.log`](evidence/verification-app/trace-without-fix.log) | The trace in [What happens on a device](#what-happens-on-a-device) |
| [`evidence/verification-app/trace-with-fix.log`](evidence/verification-app/trace-with-fix.log) | The same scenario with the fix, CPUs loaded: `MVCPVL A pinned` lines are the fix keeping the rows on screen |
| [`evidence/verification-app/*.jsonl`](evidence/verification-app/) | The verification app's results, one run per line: at rest (`static`), loaded (`load`), stock vs stock + fix (`stock-load`), and moving |

## Related

- [#58913](https://github.com/react/react-native/issues/58913): at exactly
  y=0, iOS mVCP anchors on a VirtualizedList spacer instead of a row. This app
  starts at y=300 to keep it out of the way.
- [#58909](https://github.com/react/react-native/issues/58909),
  [#58870](https://github.com/react/react-native/issues/58870) and
  [#58921](https://github.com/react/react-native/issues/58921) are separate
  VirtualizedList bugs in the same area. The fixes don't overlap.
