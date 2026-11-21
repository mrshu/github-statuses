const assert = require('node:assert/strict');
const test = require('node:test');

const productFilter = require('../site/product-filter.js');

const PRODUCTS = ['Git Operations', 'Webhooks', 'Actions', 'Pages'];
const BASE = 'https://mrshu.github.io/github-statuses/';

const memoryStorage = (initial = {}) => {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = String(value);
    },
    removeItem: (key) => {
      delete data[key];
    },
  };
};

test('defaults to every product', () => {
  assert.deepEqual(productFilter.read(BASE, PRODUCTS, memoryStorage()), PRODUCTS);
});

test('reads a shared link, ignoring unknown slugs', () => {
  assert.deepEqual(
    productFilter.read(`${BASE}?products=actions,git-operations,nope`, PRODUCTS, memoryStorage()),
    ['Git Operations', 'Actions'],
  );
});

test('falls back to every product when nothing valid is selected', () => {
  assert.deepEqual(productFilter.read(`${BASE}?products=nope`, PRODUCTS, memoryStorage()), PRODUCTS);
});

test('the link beats what the browser remembers', () => {
  const storage = memoryStorage({ 'github-statuses:products': 'pages' });
  assert.deepEqual(productFilter.read(`${BASE}?products=actions`, PRODUCTS, storage), ['Actions']);
  assert.deepEqual(productFilter.read(BASE, PRODUCTS, storage), ['Pages']);
});

test('survives storage that throws', () => {
  const storage = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
    removeItem: () => {
      throw new Error('blocked');
    },
  };
  assert.deepEqual(productFilter.read(BASE, PRODUCTS, storage), PRODUCTS);
  const history = { state: null, replaceState: () => {} };
  productFilter.sync(['Pages'], PRODUCTS, BASE, history, storage);
});

test('sync writes the URL and storage, keeping other URL state', () => {
  const replacements = [];
  const history = { state: { kept: true }, replaceState: (...args) => replacements.push(args) };
  const storage = memoryStorage();

  productFilter.sync(['Pages', 'Actions'], PRODUCTS, `${BASE}?view=all#uptime`, history, storage);

  assert.deepEqual(replacements, [
    [{ kept: true }, '', '/github-statuses/?view=all&products=actions%2Cpages#uptime'],
  ]);
  assert.equal(storage.data['github-statuses:products'], 'actions,pages');
});

test('selecting everything clears the URL parameter and storage', () => {
  const replacements = [];
  const history = { state: null, replaceState: (...args) => replacements.push(args) };
  const storage = memoryStorage({ 'github-statuses:products': 'pages' });

  productFilter.sync(PRODUCTS, PRODUCTS, `${BASE}?products=pages&view=all`, history, storage);

  assert.deepEqual(replacements, [[null, '', '/github-statuses/?view=all']]);
  assert.deepEqual(storage.data, {});
});

test('a URL written by sync reads back to the same selection', () => {
  const replacements = [];
  const history = { state: null, replaceState: (...args) => replacements.push(args) };
  productFilter.sync(['Webhooks', 'Pages'], PRODUCTS, BASE, history, memoryStorage());
  const href = `https://mrshu.github.io${replacements[0][2]}`;
  assert.deepEqual(productFilter.read(href, PRODUCTS, memoryStorage()), ['Webhooks', 'Pages']);
});

test('includes: untagged incidents count only while everything is selected', () => {
  assert.equal(productFilter.includes([], PRODUCTS, PRODUCTS), true);
  assert.equal(productFilter.includes(undefined, PRODUCTS, PRODUCTS), true);
  assert.equal(productFilter.includes(['Visit www'], PRODUCTS, PRODUCTS), true);
  assert.equal(productFilter.includes([], ['Pages'], PRODUCTS), false);
  assert.equal(productFilter.includes(['Visit www'], ['Pages'], PRODUCTS), false);
});

test('includes: matches when any tagged component is selected', () => {
  assert.equal(productFilter.includes(['Actions', 'Pages'], ['Pages'], PRODUCTS), true);
  assert.equal(productFilter.includes(['Actions'], ['Pages'], PRODUCTS), false);
});

test('labels', () => {
  assert.equal(productFilter.label(PRODUCTS, PRODUCTS), 'All GitHub Platform');
  assert.equal(productFilter.label(PRODUCTS.slice(1), PRODUCTS), '3 GitHub Products');
  assert.equal(productFilter.label(['Actions', 'Pages'], PRODUCTS), '2 GitHub Products');
  assert.equal(productFilter.label(['Actions'], PRODUCTS), 'Actions');
});
