/**
 * The bug without a device: after a prepend, the rows rendered above the
 * spacer are measured and change the average row height. VirtualizedList then
 * maps the corrected scroll offset to rows with estimates from the new
 * average, but the spacer on screen was sized with the old one.
 *
 * Like React Native's own VirtualizedList tests, this drives the list through
 * its private handlers (`_onLayout`, `_onContentSizeChange`, `_onCellLayout`,
 * `_onScroll`). Those are what the native layout and scroll events call.
 *
 * @format
 */

import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { VirtualizedList } from 'react-native';

jest.useFakeTimers();

type Item = { key: string };

const ITEM_HEIGHT = 10;
const PREPENDED_ITEM_HEIGHT = 100;
const VIEWPORT = { width: 10, height: 50 };

function items(count: number, prefix: string): Item[] {
  return Array.from({ length: count }, (_, i) => ({ key: `${prefix}${i}` }));
}

async function run(fix: boolean) {
  const data = items(100, 'r');
  const props = (d: Item[]) =>
    ({
      data: d,
      renderItem: ({ item }: { item: Item }) =>
        React.createElement('Item', { value: item.key }),
      getItem: (dd: Item[], index: number) => dd[index],
      getItemCount: (dd: Item[]) => dd.length,
      keyExtractor: (item: Item) => item.key,
      initialNumToRender: 2,
      windowSize: 1,
      maintainVisibleContentPosition: { minIndexForVisible: 0 },
      // Added by patches/@react-native+virtualized-lists+0.87.1.patch.
      preferMeasuredCells: fix,
    } as any);

  let component!: ReactTestRenderer;
  await act(() => {
    component = create(<VirtualizedList {...props(data)} />);
  });
  const list = component.root.findByType(VirtualizedList as any)
    .instance as any;
  const layout = (
    d: Item[],
    indices: number[],
    offsetOf: (i: number) => number,
    height: number,
  ) => {
    for (const i of indices) {
      list._onCellLayout(
        {
          nativeEvent: { layout: { x: 0, y: offsetOf(i), width: 10, height } },
        },
        d[i].key,
        i,
      );
    }
  };

  // At the top, rows r0-r4 (10 each) rendered and measured: average 10.
  await act(() => {
    list._onLayout({ nativeEvent: { layout: VIEWPORT } });
    list._onContentSizeChange(10, data.length * ITEM_HEIGHT);
    layout(data, [0, 1, 2, 3, 4], i => i * ITEM_HEIGHT, ITEM_HEIGHT);
    jest.runAllTimers();
  });
  await act(() => {
    layout(data, [0, 1, 2, 3, 4], i => i * ITEM_HEIGHT, ITEM_HEIGHT);
    jest.runAllTimers();
  });
  const before = { ...list.state.cellsAroundViewport };

  // Prepend 20 rows. The window moves to r0-r4's new indices, 20-24. Rows 0
  // and 1 render for the initial region, and a spacer for rows 2-19 at the
  // average, 18 * 10 = 180, sits between them and the window.
  const newData = [...items(20, 'p'), ...data];
  await act(() => {
    component.update(<VirtualizedList {...props(newData)} />);
  });
  const afterPrepend = { ...list.state.cellsAroundViewport };

  // Native lays the commit out. Rows 0 and 1 are 100 tall, so r0 (index 20)
  // is at 2 * 100 + 180 = 380. Their layouts reach JS first and raise the
  // average to 250 / 7, about 35.7, so rows 2-19 are now estimated at 71-714:
  // past r0, whose measured frame is at 380-390. Then the scroll event with
  // mVCP's correction (0 -> 380).
  const r0 = 2 * PREPENDED_ITEM_HEIGHT + 18 * ITEM_HEIGHT;
  await act(() => {
    list._onContentSizeChange(10, r0 + data.length * ITEM_HEIGHT);
    layout(
      newData,
      [0, 1],
      i => i * PREPENDED_ITEM_HEIGHT,
      PREPENDED_ITEM_HEIGHT,
    );
    layout(
      newData,
      [20, 21, 22, 23, 24],
      i => r0 + (i - 20) * ITEM_HEIGHT,
      ITEM_HEIGHT,
    );
    list._onScroll({
      timeStamp: Date.now(),
      nativeEvent: {
        contentOffset: { x: 0, y: r0 },
        contentSize: { width: 10, height: r0 + data.length * ITEM_HEIGHT },
        layoutMeasurement: VIEWPORT,
        zoomScale: 1,
      },
    });
    jest.runAllTimers();
  });
  const afterCorrection = { ...list.state.cellsAroundViewport };
  return { before, afterPrepend, afterCorrection };
}

test('stock: the window moves into the estimates and unmounts r0-r4', async () => {
  const r = await run(false);
  expect(r.before).toEqual({ first: 0, last: 4 });
  expect(r.afterPrepend).toEqual({ first: 20, last: 24 });
  // The window moves to rows 10-12, inside the spacer.
  expect(r.afterCorrection).toEqual({ first: 10, last: 12 });
});

test('fixed: the window keeps r0-r4, the rows on screen', async () => {
  const r = await run(true);
  expect(r.before).toEqual({ first: 0, last: 4 });
  expect(r.afterPrepend).toEqual({ first: 20, last: 24 });
  // Rows 20-24 stay, plus one batch above them toward the estimated overscan.
  expect(r.afterCorrection).toEqual({ first: 10, last: 24 });
});
