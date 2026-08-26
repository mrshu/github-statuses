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
