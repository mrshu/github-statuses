const assert = require('node:assert/strict');
const test = require('node:test');

const componentWindows = require('../site/component-windows.js');

const iso = (windows) => windows.map(([start, end]) => [start.toISOString(), end.toISOString()]);

const incident = {
  downtime_start: '2026-09-23T10:11:00Z',
  downtime_end: '2026-09-24T04:55:00Z',
  component_windows: [
    { component: 'API Requests', start_at: '2026-09-23T10:11:00Z', end_at: '2026-09-23T10:58:00Z', source: 'updates' },
    { component: 'Pages', start_at: '2026-09-23T11:00:00Z', end_at: '2026-09-23T11:30:00Z', source: 'updates' },
    { component: 'Pages', start_at: '2026-09-23T12:00:00Z', end_at: '2026-09-23T12:10:00Z', source: 'updates' },
  ],
};

test('uses the component window instead of the longer incident window', () => {
  assert.deepEqual(iso(componentWindows.forIncident(incident, 'API Requests')), [
    ['2026-09-23T10:11:00.000Z', '2026-09-23T10:58:00.000Z'],
  ]);
});

test('returns every window when a component recovered and degraded again', () => {
  assert.equal(componentWindows.forIncident(incident, 'Pages').length, 2);
});

test('falls back to the incident window for a component with no window of its own', () => {
  assert.deepEqual(iso(componentWindows.forIncident(incident, 'Actions')), [
    ['2026-09-23T10:11:00.000Z', '2026-09-24T04:55:00.000Z'],
  ]);
});

test('falls back to the incident window for data without component_windows', () => {
  const legacy = { downtime_start: '2026-01-01T10:00:00Z', downtime_end: '2026-01-01T11:00:00Z' };
  assert.deepEqual(iso(componentWindows.forIncident(legacy, 'Actions')), [
    ['2026-01-01T10:00:00.000Z', '2026-01-01T11:00:00.000Z'],
  ]);
});

test('ignores empty, inverted and invalid windows', () => {
  const broken = {
    downtime_start: '2026-01-01T10:00:00Z',
    downtime_end: '2026-01-01T09:00:00Z',
    component_windows: [
      { component: 'Actions', start_at: '2026-01-01T10:00:00Z', end_at: '2026-01-01T10:00:00Z' },
      { component: 'Actions', start_at: 'nope', end_at: '2026-01-01T10:00:00Z' },
    ],
  };
  assert.deepEqual(componentWindows.forIncident(broken, 'Actions'), []);
});
