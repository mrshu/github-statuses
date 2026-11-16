const uptimeViewUrl = (() => {
  const DEFAULT_VIEW = '90d';
  const ALL_TIME_VIEW = 'all';
  const DEFAULT_WINDOW_DAYS = 90;

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

  const readWindow = (href) => {
    const days = Number(new URL(href).searchParams.get('window'));
    return Number.isInteger(days) && days > 0 ? days : DEFAULT_WINDOW_DAYS;
  };

  const syncWindow = (days, href, history) => {
    const url = new URL(href);
    if (days === DEFAULT_WINDOW_DAYS) {
      url.searchParams.delete('window');
    } else {
      url.searchParams.set('window', String(days));
    }
    history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
  };

  return { read, sync, readWindow, syncWindow };
})();

if (typeof module !== 'undefined') {
  module.exports = uptimeViewUrl;
}
