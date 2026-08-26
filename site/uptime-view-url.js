const uptimeViewUrl = (() => {
  const DEFAULT_VIEW = '90d';
  const ALL_TIME_VIEW = 'all';

  const read = (href) => {
    const view = new URL(href).searchParams.get('view');
    return view === ALL_TIME_VIEW ? ALL_TIME_VIEW : DEFAULT_VIEW;
  };

  const sync = (view, href, history) => {
    const url = new URL(href);
    if (view === ALL_TIME_VIEW) {
      url.searchParams.set('view', ALL_TIME_VIEW);
    } else {
      url.searchParams.delete('view');
    }
    history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
  };

  return { read, sync };
})();

if (typeof module !== 'undefined') {
  module.exports = uptimeViewUrl;
}
