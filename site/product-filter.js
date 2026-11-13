// Which GitHub products the visitor cares about. Everything here is pure (no DOM, no
// globals) so the selection rules can be unit-tested; app.js owns the rendering.
const productFilter = (() => {
  const PARAM = 'products';
  const STORAGE_KEY = 'github-statuses:products';

  const slugOf = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  // Unknown slugs are dropped, and an empty result falls back to "everything", so a
  // stale or hand-edited value can never leave the page with nothing selected.
  const parse = (value, products) => {
    if (!value) return products.slice();
    const wanted = new Set(value.split(',').map((slug) => slug.trim()));
    const selected = products.filter((product) => wanted.has(slugOf(product)));
    return selected.length ? selected : products.slice();
  };

  const isAll = (selected, products) => products.every((product) => selected.includes(product));

  // A shared link beats what this browser remembers, which beats the default.
  const read = (href, products, storage) => {
    const fromUrl = new URL(href).searchParams.get(PARAM);
    if (fromUrl) return parse(fromUrl, products);
    let stored = null;
    try {
      stored = storage ? storage.getItem(STORAGE_KEY) : null;
    } catch (error) {
      // Storage can throw when blocked (private mode, disabled cookies); that only
      // means the choice is not remembered.
    }
    return parse(stored, products);
  };

  const serialize = (selected, products) =>
    products
      .filter((product) => selected.includes(product))
      .map(slugOf)
      .join(',');

  // Selecting everything is the default, so it leaves no trace in the URL or storage.
  const sync = (selected, products, href, history, storage) => {
    const url = new URL(href);
    const all = isAll(selected, products);
    if (all) {
      url.searchParams.delete(PARAM);
    } else {
      url.searchParams.set(PARAM, serialize(selected, products));
    }
    history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
    try {
      if (!storage) return;
      if (all) storage.removeItem(STORAGE_KEY);
      else storage.setItem(STORAGE_KEY, serialize(selected, products));
    } catch (error) {
      // See read(): an unremembered choice is not worth surfacing.
    }
  };

  // Incidents with no tag (or only tags outside the product list) belong to the
  // platform as a whole, so they count only while every product is selected.
  const includes = (components, selected, products) => {
    if (isAll(selected, products)) return true;
    return (components || []).some((component) => selected.includes(component));
  };

  const label = (selected, products) => {
    if (isAll(selected, products)) return 'All GitHub Platform';
    if (selected.length === 1) return selected[0];
    return `${selected.length} GitHub Products`;
  };

  return { read, sync, includes, label, isAll, slugOf, parse };
})();

if (typeof module !== 'undefined') {
  module.exports = productFilter;
}
