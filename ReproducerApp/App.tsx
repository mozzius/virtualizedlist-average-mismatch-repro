/**
 * Repro: after a large prepend near the top of a FlatList with
 * maintainVisibleContentPosition, VirtualizedList maps the corrected scroll
 * offset to rows with estimates from an average row height that changed after
 * the spacer above the window was rendered, and unmounts the row the user is
 * reading.
 *
 * See ../README.md.
 *
 * @format
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  FlatList,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Platform,
  Pressable,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

type Row = { id: string; height: number };

const ROW_COUNT = 200;
const PREPEND_SIZES = [100, 50];
/**
 * Where the reader is when the rows arrive: near the top, like a feed that
 * restored its position and then loads what's newer. Not exactly 0, where iOS
 * anchors on a VirtualizedList spacer instead (react/react-native#58913).
 */
const START_OFFSET = 300;
/** Small views per row, so mounting a row costs about what a feed post does. */
const DOTS_PER_ROW = 60;
const REPEAT_ROUNDS = 10;
/** Bluesky's feed settings (Android). */
const WINDOW_SIZE = 9;
const MAX_TO_RENDER_PER_BATCH = 1;

function hash(id: string) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Deterministic heights, so every run lays out the same: 60-200pt for the
 * initial rows, 250-500pt for prepended ones.
 */
function makeRows(prefix: string, count: number, tall: boolean): Row[] {
  return Array.from({ length: count }, (_, i) => {
    const id = `${prefix}${i}`;
    const height = tall ? 250 + (hash(id) % 251) : 60 + (hash(id) % 141);
    return { id, height };
  });
}

const t0 = Date.now();
function log(message: string) {
  console.log(`[anchor] +${Date.now() - t0}ms ${message}`);
}

/**
 * Diagnostics only, not needed for the bug: VirtualizedList's render window
 * and the scroll offset it last saw.
 */
function readList(list: unknown) {
  const vl = (list as any)?._listRef;
  const s = vl?.state;
  if (!s) {
    return null;
  }
  return {
    first: s.cellsAroundViewport.first as number,
    last: s.cellsAroundViewport.last as number,
    offset: vl._scrollMetrics?.offset as number,
  };
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

type ViewRef = React.ComponentRef<typeof View>;

const rowRefs = new Map<string, ViewRef>();
/** The row at the top of the viewport when the prepend was issued. */
let anchorId: string | null = null;

function RowView({ row }: { row: Row }) {
  useEffect(() => {
    if (row.id !== anchorId) {
      return;
    }
    log(`${row.id} mounted`);
    return () => {
      if (row.id === anchorId) {
        log(`${row.id} UNMOUNTED`);
      }
    };
  }, [row.id]);
  return (
    <View
      ref={ref => {
        if (ref) {
          rowRefs.set(row.id, ref);
        } else {
          rowRefs.delete(row.id);
        }
      }}
      style={[
        styles.row,
        { height: row.height },
        row.id.startsWith('p') && styles.prepended,
      ]}
    >
      <Text style={styles.rowText}>
        {row.id} ({row.height}pt)
      </Text>
      <View style={styles.dots}>
        {Array.from({ length: DOTS_PER_ROW }, (_, i) => (
          <View key={i} style={styles.dot} />
        ))}
      </View>
    </View>
  );
}

function measureInWindow(view: ViewRef) {
  return new Promise<{ y: number; height: number }>(resolve =>
    view.measureInWindow((_x, y, _w, height) => resolve({ y, height })),
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" />
      <Repro />
    </SafeAreaProvider>
  );
}

type Result = { held: boolean; summary: string };

/**
 * `pr`: the open PRs this bug otherwise hides behind,
 * react/react-native#58922 (hold the window until native's correction for a
 * moved anchor arrives) and #58911 (a prepend batched with a cells update is
 * skipped, which a slow device can run into).
 * `fix`: the fix for this bug.
 */
type Mode = { pr: boolean; fix: boolean };

function describeMode({ pr, fix }: Mode) {
  return `PRs ${pr ? 'on' : 'off'}, fix ${fix ? 'on' : 'off'}`;
}

type Pending = {
  at: number;
  /** When the prepended rows were committed. */
  committedAt: number | null;
  /** VirtualizedList's window, and when it last changed. */
  window: string;
  windowAt: number;
  head: string;
  anchor: { id: string; y: number };
  resolve: (r: Result) => void;
};

function Repro() {
  const listRef = useRef<FlatList<Row>>(null);
  const listViewRef = useRef<ViewRef>(null);
  const [mode, setMode] = useState<Mode>({ pr: true, fix: false });
  const [sizeIndex, setSizeIndex] = useState(0);
  const prependCount = PREPEND_SIZES[sizeIndex];
  const [generation, setGeneration] = useState(0);
  const [rows, setRows] = useState(() => makeRows('r', ROW_COUNT, false));
  const [readout, setReadout] = useState<string[]>(['Tap Run.']);
  const [busy, setBusy] = useState(false);

  const scroll = useRef({ y: 0, h: 0, t: 0, corrections: 0 });
  const pending = useRef<Pending | null>(null);
  const watch = useRef<null | { until: number; last: string }>(null);

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = e.nativeEvent.contentOffset.y;
    const h = e.nativeEvent.contentSize.height;
    const dy = y - scroll.current.y;
    const dh = h - scroll.current.h;
    // An offset change that matches a content size change is mVCP keeping the
    // anchor in place, not the user scrolling.
    const correction = Math.abs(dh) >= 20 && Math.abs(dy - dh) <= 2;
    if (correction) {
      scroll.current.corrections += 1;
    }
    scroll.current = { ...scroll.current, y, h, t: Date.now() };
    if (pending.current) {
      log(
        `scroll y=${y.toFixed(1)} (dy=${dy.toFixed(1)}) h=${h.toFixed(
          0,
        )} (dh=${dh.toFixed(0)})` + (correction ? ' correction' : ''),
      );
    }
  };

  // Log every change of the render window for a few seconds after a prepend,
  // with the scroll offset VirtualizedList had at the time.
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const w = watch.current;
      if (w && Date.now() < w.until) {
        const s = readList(listRef.current);
        const key = s ? `${s.first}..${s.last}` : '';
        if (s && key !== w.last) {
          log(`window ${w.last} -> ${key} (offset ${s.offset?.toFixed(1)})`);
          w.last = key;
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  // Runs after VirtualizedList has committed the new data.
  useLayoutEffect(() => {
    const p = pending.current;
    if (!p || rows[0].id !== p.head) {
      return;
    }
    p.committedAt = Date.now();
    const s = readList(listRef.current);
    log(`commit: window ${s?.first}..${s?.last}`);
  }, [rows]);

  /** Screen positions of the mounted rows, relative to the top of the list. */
  const measureRows = async () => {
    const out = new Map<string, { y: number; height: number }>();
    const list = listViewRef.current;
    if (!list) {
      return out;
    }
    const { y: listY } = await measureInWindow(list);
    await Promise.all(
      [...rowRefs].map(async ([rowId, view]) => {
        const m = await measureInWindow(view);
        out.set(rowId, { y: m.y - listY, height: m.height });
      }),
    );
    return out;
  };
  const topOf = (measured: Map<string, { y: number; height: number }>) => {
    for (const [id, m] of measured) {
      if (m.y <= 0.5 && m.y + m.height > 0.5) {
        return { id, y: m.y };
      }
    }
    return null;
  };

  // Once the list is still, find where the row the user was reading went.
  useEffect(() => {
    const id = setInterval(async () => {
      const p = pending.current;
      if (!p) {
        return;
      }
      const now = Date.now();
      const w = readList(listRef.current);
      const key = w ? `${w.first}..${w.last}` : '';
      if (key !== p.window) {
        p.window = key;
        p.windowAt = now;
      }
      // Still means no window change and no scroll event for 1.5s: on a busy
      // device a correction can take most of a second to arrive.
      if (
        p.committedAt == null ||
        now - p.committedAt < 1500 ||
        now - scroll.current.t < 1500 ||
        now - p.windowAt < 1500
      ) {
        return;
      }
      pending.current = null;
      watch.current = null;
      const measured = await measureRows();
      const top = topOf(measured);
      const y = measured.get(p.anchor.id)?.y ?? null;
      anchorId = null;
      const held = y != null && Math.abs(y - p.anchor.y) <= 2;
      const s = readList(listRef.current);
      const summary =
        `${p.anchor.id}: ${p.anchor.y.toFixed(1)}pt -> ` +
        `${y == null ? 'not rendered' : `${y.toFixed(1)}pt`}. ` +
        `Top row now ${top?.id} at ${top?.y.toFixed(1)}pt. ` +
        `${scroll.current.corrections} corrections, window ${s?.first}..${s?.last}`;
      log(`settled: ${summary} -> ${held ? 'HELD' : 'JUMPED'}`);
      p.resolve({ held, summary });
    }, 100);
    return () => clearInterval(id);
  }, []);

  const reset = (nextMode = mode) => {
    pending.current = null;
    watch.current = null;
    anchorId = null;
    scroll.current = { y: 0, h: 0, t: 0, corrections: 0 };
    rowRefs.clear();
    setMode(nextMode);
    setRows(makeRows('r', ROW_COUNT, false));
    setGeneration(g => g + 1);
    log(`reset, ${describeMode(nextMode)}`);
  };

  const waitUntilIdle = async () => {
    const start = Date.now();
    let last = '';
    let since = Date.now();
    while (Date.now() - start < 30000) {
      const s = readList(listRef.current);
      const key = s ? `${s.first}..${s.last}` : '';
      if (key !== last) {
        last = key;
        since = Date.now();
      }
      if (
        Math.abs(scroll.current.y - START_OFFSET) < 1 &&
        Date.now() - since >= 1000 &&
        Date.now() - scroll.current.t >= 500
      ) {
        return;
      }
      await sleep(100);
    }
    log('list never went idle');
  };

  /**
   * One round: a fresh list, scrolled to START_OFFSET, gets `prependCount`
   * tall rows prepended, and we wait for it to settle.
   */
  const runOnce = async (): Promise<Result> => {
    reset(mode);
    await sleep(1200);
    // A slow device may not have laid the new list out yet: retry until the
    // scroll lands.
    for (
      let i = 0;
      i < 10 && Math.abs(scroll.current.y - START_OFFSET) >= 1;
      i++
    ) {
      listRef.current?.scrollToOffset({
        offset: START_OFFSET,
        animated: false,
      });
      await sleep(1000);
    }
    // Prepend to an idle list: scrolled into place, and VirtualizedList done
    // filling in its window, which a slow device takes a while to do.
    await waitUntilIdle();
    const before = topOf(await measureRows());
    if (!before) {
      return { held: false, summary: 'no row at the top' };
    }
    anchorId = before.id;
    const added = makeRows('p', prependCount, true);
    const total = added.reduce((sum, r) => sum + r.height, 0);
    const s = readList(listRef.current);
    scroll.current.corrections = 0;
    watch.current = {
      until: Date.now() + 10000,
      last: s ? `${s.first}..${s.last}` : '',
    };
    log(
      `prepending ${prependCount} rows (${total}pt) at y=${scroll.current.y.toFixed(
        1,
      )}, ` +
        `${describeMode(mode)}, ${before.id} at ${before.y.toFixed(1)}pt, ` +
        `window ${s?.first}..${s?.last}`,
    );
    return new Promise<Result>(resolve => {
      pending.current = {
        at: Date.now(),
        committedAt: null,
        window: '',
        windowAt: Date.now(),
        head: added[0].id,
        anchor: before,
        resolve,
      };
      setRows(prev => [...added, ...prev]);
    });
  };

  const run = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    setReadout([`Running: ${prependCount} rows, ${describeMode(mode)}…`]);
    const r = await runOnce();
    setReadout([
      `${describeMode(mode)}, ${prependCount} rows prepended above the reader`,
      r.summary,
      r.held ? 'HELD' : 'JUMPED: the row you were reading moved',
    ]);
    setBusy(false);
  };

  const repeat = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    let jumped = 0;
    for (let i = 1; i <= REPEAT_ROUNDS; i++) {
      setReadout([
        `Repeat, ${describeMode(
          mode,
        )}: round ${i}/${REPEAT_ROUNDS}, ${jumped} jumped so far…`,
      ]);
      const r = await runOnce();
      if (!r.held) {
        jumped += 1;
      }
      log(`round ${i}/${REPEAT_ROUNDS}: ${r.held ? 'HELD' : 'JUMPED'}`);
    }
    const line = `Repeat, ${describeMode(
      mode,
    )}, ${prependCount} rows: ${jumped}/${REPEAT_ROUNDS} jumped`;
    log(line);
    setReadout([line]);
    setBusy(false);
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <View style={styles.controls}>
          <Button label="Run" onPress={run} />
          <Button label="Repeat" onPress={repeat} />
          <Button
            label={`${prependCount} rows`}
            onPress={() => setSizeIndex(i => (i + 1) % PREPEND_SIZES.length)}
          />
        </View>
        <View style={styles.controls}>
          <Text style={styles.fixLabel}>PRs</Text>
          <Switch
            value={mode.pr}
            onValueChange={value => {
              reset({ ...mode, pr: value });
              setReadout(['Tap Run.']);
            }}
            accessibilityLabel="PRs"
          />
          <Text style={styles.fixLabel}>Fix</Text>
          <Switch
            value={mode.fix}
            onValueChange={value => {
              reset({ ...mode, fix: value });
              setReadout(['Tap Run.']);
            }}
            accessibilityLabel="Fix"
          />
        </View>
        <Text style={styles.readout} testID="readout">
          {readout.filter(Boolean).join('\n')}
        </Text>
      </View>
      <View ref={listViewRef} style={styles.list} collapsable={false}>
        <FlatList
          key={generation}
          ref={listRef}
          data={rows}
          keyExtractor={row => row.id}
          renderItem={({ item }) => <RowView row={item} />}
          maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
          windowSize={WINDOW_SIZE}
          maxToRenderPerBatch={MAX_TO_RENDER_PER_BATCH}
          // Off on Android too (FlatList's default there is on), to keep its
          // clipping out of the picture.
          removeClippedSubviews={false}
          onScroll={onScroll}
          scrollEventThrottle={16}
          // Both props are added by patches/@react-native+virtualized-lists+0.87.1.patch.
          {...({
            awaitAnchorCorrection: mode.pr,
            detectBatchedPrepend: mode.pr,
            preferMeasuredCells: mode.fix,
          } as object)}
        />
      </View>
    </SafeAreaView>
  );
}

function Button({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
    >
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  header: { padding: 8, gap: 6, borderBottomWidth: 1, borderColor: '#ccc' },
  controls: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  button: {
    backgroundColor: '#e4e6eb',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  buttonPressed: { opacity: 0.6 },
  buttonText: { fontSize: 15, fontWeight: '600' },
  fixLabel: { fontSize: 15, fontWeight: '600' },
  readout: {
    fontSize: 12,
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
    minHeight: 48,
  },
  list: { flex: 1 },
  row: {
    padding: 8,
    borderBottomWidth: 1,
    borderColor: '#ccc',
    backgroundColor: '#f6f8fa',
  },
  prepended: { backgroundColor: '#fff3d6' },
  rowText: { fontSize: 16 },
  dots: { flexDirection: 'row', flexWrap: 'wrap', gap: 2, marginTop: 4 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#9ab' },
});
