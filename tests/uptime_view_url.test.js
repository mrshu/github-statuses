const assert = require('node:assert/strict');
const test = require('node:test');

let uptimeViewUrl = {};
try {
  uptimeViewUrl = require('../site/uptime-view-url.js');
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}

test('reads the all-time view from a permalink', () => {
  assert.equal(
    uptimeViewUrl.read?.('https://mrshu.github.io/github-statuses/?view=all'),
    'all',
  );
  assert.equal(
    uptimeViewUrl.read?.('https://mrshu.github.io/github-statuses/?view=unknown'),
    '90d',
  );
});

test('syncs tab changes while preserving other URL state', () => {
  const replacements = [];
  const history = {
    state: { retained: true },
    replaceState: (...args) => replacements.push(args),
  };

  uptimeViewUrl.sync?.(
    'all',
    'https://mrshu.github.io/github-statuses/?meta=compact#uptime',
    history,
  );
  uptimeViewUrl.sync?.(
    '90d',
    'https://mrshu.github.io/github-statuses/?meta=compact&view=all#uptime',
    history,
  );

  assert.deepEqual(replacements, [
    [{ retained: true }, '', '/github-statuses/?meta=compact&view=all#uptime'],
    [{ retained: true }, '', '/github-statuses/?meta=compact#uptime'],
  ]);
});

test('reads a rolling window from a permalink', () => {
  assert.equal(
    uptimeViewUrl.readWindow?.('https://mrshu.github.io/github-statuses/?view=all&window=30'),
    30,
  );
  assert.equal(
    uptimeViewUrl.readWindow?.('https://mrshu.github.io/github-statuses/?window=2.5'),
    90,
  );
  assert.equal(
    uptimeViewUrl.readWindow?.('https://mrshu.github.io/github-statuses/?window=0'),
    90,
  );
  assert.equal(uptimeViewUrl.readWindow?.('https://mrshu.github.io/github-statuses/'), 90);
  assert.equal(
    uptimeViewUrl.readWindow?.('https://mrshu.github.io/github-statuses/?window=abc'),
    90,
  );
});

test('syncs the rolling window while preserving other URL state', () => {
  const replacements = [];
  const history = {
    state: { retained: true },
    replaceState: (...args) => replacements.push(args),
  };

  uptimeViewUrl.syncWindow?.(
    30,
    'https://mrshu.github.io/github-statuses/?view=all&meta=compact#uptime',
    history,
  );
  uptimeViewUrl.syncWindow?.(
    90,
    'https://mrshu.github.io/github-statuses/?view=all&meta=compact&window=30#uptime',
    history,
  );

  assert.deepEqual(replacements, [
    [{ retained: true }, '', '/github-statuses/?view=all&meta=compact&window=30#uptime'],
    [{ retained: true }, '', '/github-statuses/?view=all&meta=compact#uptime'],
  ]);
});
