const assert = require('node:assert/strict');
const test = require('node:test');

let chart = {};
try {
  chart = require('../site/uptime-history-chart.js');
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}

const DAY = 86400000;
const MINUTE = 60000;
const START = Date.UTC(2022, 5, 11);

const closeTo = (actual, expected) => Math.abs(actual - expected) < 1e-9;

test('a one-day window counts only that day', () => {
  const day = START + 2 * DAY;
  const intervals = [[day + 60 * MINUTE, day + 70 * MINUTE]];
  const series = chart.computeUptimeHistorySeries?.(intervals, START, START + 4 * DAY, 1);

  assert.equal(series?.length, 4);
  assert.equal(series[0].uptime, 100);
  assert.equal(series[1].uptime, 100);
  assert.ok(closeTo(series[2].uptime, 100 * (1 - 10 / 1440)));
  assert.equal(series[3].uptime, 100);
});

test('a longer window dilutes the same downtime', () => {
  const day = START + 2 * DAY;
  const intervals = [[day + 60 * MINUTE, day + 70 * MINUTE]];
  const series = chart.computeUptimeHistorySeries?.(intervals, START, START + 4 * DAY, 7);

  assert.ok(closeTo(series[2].uptime, 100 * (1 - 10 / (7 * 1440))));
});

test('overlapping intervals count once', () => {
  const day = START + 2 * DAY;
  const intervals = [
    [day + 60 * MINUTE, day + 70 * MINUTE],
    [day + 65 * MINUTE, day + 75 * MINUTE],
  ];
  const series = chart.computeUptimeHistorySeries?.(intervals, START, START + 4 * DAY, 1);

  assert.ok(closeTo(series[2].uptime, 100 * (1 - 15 / 1440)));
});

test('long windows start only after their lookback fits trusted history', () => {
  assert.equal(chart.DEFAULT_WINDOW_DAYS, 90);
  assert.equal(chart.uptimeSeriesStartMs?.(START, 90), START);
  assert.equal(chart.uptimeSeriesStartMs?.(START, 1), START);
  assert.equal(chart.uptimeSeriesStartMs?.(START, 180), START + 89 * DAY);
  assert.equal(chart.uptimeSeriesStartMs?.(START, 365), START + 274 * DAY);
});

test('a wide uptime range uses fewer y-axis labels', () => {
  const series = [
    { time: START, uptime: 100 },
    { time: START + DAY, uptime: 0 },
    { time: START + 2 * DAY, uptime: 100 },
  ];
  const layout = {
    width: 1200,
    height: 480,
    marginLeft: 64,
    marginRight: 32,
    marginTop: 78,
    marginBottom: 64,
  };
  const markup = chart.buildUptimeHistorySVG?.(series, layout, 1)?.markup || '';
  const labels = Array.from(markup.matchAll(/>(\d+)%<\/text>/g), (match) => Number(match[1]));

  assert.deepEqual(labels, [100, 75, 50, 25, 0]);
});
