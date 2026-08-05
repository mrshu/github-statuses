const PROJECT_START_UTC = Date.UTC(2022, 5, 11);
const UPTIME_HISTORY_WINDOW_DAYS = 90;
const UPTIME_HISTORY_ONE_DAY_MS = 86400000;
const UPTIME_HISTORY_WINDOW_MS = UPTIME_HISTORY_WINDOW_DAYS * UPTIME_HISTORY_ONE_DAY_MS;

const UPTIME_HISTORY_LAYOUT = {
  width: 1200,
  height: 480,
  marginLeft: 64,
  marginRight: 32,
  marginTop: 78,
  marginBottom: 64,
};

const uptimeHistoryDateFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

const formatUptimeHistoryDate = (value) =>
  uptimeHistoryDateFormatter.format(value instanceof Date ? value : new Date(value));

// Delegates to app.js's countsAsDowntime so the two views can never disagree about
// what counts as downtime. Resolved at call time: app.js loads after this file but
// always before render() is invoked.
const isUptimeHistoryDowntime = (impact) => countsAsDowntime(impact || 'none');

const toUptimeHistoryMs = (value) =>
  value instanceof Date ? value.getTime() : new Date(value).getTime();

const collectUptimeHistoryIntervals = (entries) =>
  entries
    .filter((entry) => isUptimeHistoryDowntime(entry.impact))
    .map((entry) => [toUptimeHistoryMs(entry.start), toUptimeHistoryMs(entry.end)])
    .filter(
      ([entryStart, entryEnd]) =>
        Number.isFinite(entryStart) && Number.isFinite(entryEnd) && entryEnd > entryStart,
    )
    .sort((a, b) => a[0] - b[0]);

const computeUptimeHistorySeries = (intervals, startMs, endMs) => {
  const series = [];
  for (let dayStart = startMs; dayStart < endMs; dayStart += UPTIME_HISTORY_ONE_DAY_MS) {
    const windowEnd = dayStart + UPTIME_HISTORY_ONE_DAY_MS;
    const windowStart = windowEnd - UPTIME_HISTORY_WINDOW_MS;

    let downtimeMs = 0;
    let mergedStart = -1;
    let mergedEnd = -1;
    for (let i = 0; i < intervals.length; i += 1) {
      const [entryStart, entryEnd] = intervals[i];
      if (entryEnd <= windowStart) continue;
      if (entryStart >= windowEnd) break;
      const clipStart = entryStart > windowStart ? entryStart : windowStart;
      const clipEnd = entryEnd < windowEnd ? entryEnd : windowEnd;
      if (clipEnd <= clipStart) continue;
      if (mergedStart < 0) {
        mergedStart = clipStart;
        mergedEnd = clipEnd;
      } else if (clipStart <= mergedEnd) {
        if (clipEnd > mergedEnd) mergedEnd = clipEnd;
      } else {
        downtimeMs += mergedEnd - mergedStart;
        mergedStart = clipStart;
        mergedEnd = clipEnd;
      }
    }
    if (mergedStart >= 0) downtimeMs += mergedEnd - mergedStart;

    const uptime = Math.max(0, 1 - downtimeMs / UPTIME_HISTORY_WINDOW_MS) * 100;
    series.push({ time: dayStart, uptime });
  }
  return series;
};

const computeLifetimeUptime = (intervals, startMs, endMs) => {
  let downtimeMs = 0;
  let mergedStart = -1;
  let mergedEnd = -1;
  for (let i = 0; i < intervals.length; i += 1) {
    const [entryStart, entryEnd] = intervals[i];
    if (entryEnd <= startMs) continue;
    if (entryStart >= endMs) break;
    const clipStart = entryStart > startMs ? entryStart : startMs;
    const clipEnd = entryEnd < endMs ? entryEnd : endMs;
    if (clipEnd <= clipStart) continue;
    if (mergedStart < 0) {
      mergedStart = clipStart;
      mergedEnd = clipEnd;
    } else if (clipStart <= mergedEnd) {
      if (clipEnd > mergedEnd) mergedEnd = clipEnd;
    } else {
      downtimeMs += mergedEnd - mergedStart;
      mergedStart = clipStart;
      mergedEnd = clipEnd;
    }
  }
  if (mergedStart >= 0) downtimeMs += mergedEnd - mergedStart;

  const totalMs = Math.max(1, endMs - startMs);
  return Math.max(0, 1 - downtimeMs / totalMs) * 100;
};

const buildUptimeHistorySVG = (series, layout = UPTIME_HISTORY_LAYOUT) => {
  if (!series.length) return { markup: '', geometry: null };

  const { width, height, marginLeft, marginRight, marginTop, marginBottom } = layout;
  const plotW = width - marginLeft - marginRight;
  const plotH = height - marginTop - marginBottom;

  const xMin = series[0].time;
  const xMax = series[series.length - 1].time;
  const xSpan = Math.max(1, xMax - xMin);

  let dataMin = 100;
  for (let i = 0; i < series.length; i += 1) {
    if (series[i].uptime < dataMin) dataMin = series[i].uptime;
  }
  const yMin = Math.max(0, Math.min(85, Math.floor(dataMin / 5) * 5 - 5));
  const yMax = 100;
  const ySpan = yMax - yMin;

  const xAt = (time) => marginLeft + ((time - xMin) / xSpan) * plotW;
  const yAt = (value) => {
    const clamped = Math.min(yMax, Math.max(yMin, value));
    return marginTop + (1 - (clamped - yMin) / ySpan) * plotH;
  };

  const baselineY = marginTop + plotH;
  const points = series
    .map((point) => `${xAt(point.time).toFixed(2)},${yAt(point.uptime).toFixed(2)}`)
    .join(' ');
  const areaD =
    `M ${xAt(series[0].time).toFixed(2)},${baselineY.toFixed(2)} ` +
    series
      .map((point) => `L ${xAt(point.time).toFixed(2)},${yAt(point.uptime).toFixed(2)}`)
      .join(' ') +
    ` L ${xAt(series[series.length - 1].time).toFixed(2)},${baselineY.toFixed(2)} Z`;

  const yTicks = [];
  for (let tick = 100; tick >= yMin - 1e-9; tick -= 5) yTicks.push(tick);

  const startDate = new Date(xMin);
  const endDate = new Date(xMax);
  const xTicks = [];
  for (let year = startDate.getUTCFullYear(); year <= endDate.getUTCFullYear(); year += 1) {
    const candidate = Date.UTC(year, 0, 1);
    if (candidate >= xMin && candidate <= xMax) xTicks.push({ year, time: candidate });
  }

  const lastPoint = series[series.length - 1];
  let minPoint = series[0];
  let maxPoint = series[0];
  for (let i = 1; i < series.length; i += 1) {
    if (series[i].uptime < minPoint.uptime) minPoint = series[i];
    if (series[i].uptime > maxPoint.uptime) maxPoint = series[i];
  }

  const labelAnchor = (time) => {
    const x = xAt(time);
    if (x > marginLeft + plotW - 110) return { anchor: 'end', dx: -8 };
    if (x < marginLeft + 110) return { anchor: 'start', dx: 8 };
    return { anchor: 'middle', dx: 0 };
  };

  const annotate = (point, label, colorVar, dy) => {
    const cx = xAt(point.time);
    const cy = yAt(point.uptime);
    const { anchor, dx } = labelAnchor(point.time);
    const marker =
      `<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="4" ` +
      `fill="var(${colorVar})" style="stroke: var(--card); stroke-width: 1.5"/>`;
    // On narrow layouts these labels collide, and the stat strip above already
    // reports the same three figures. Keep the markers, drop the text.
    if (layout.compact) return marker;
    return (
      marker +
      `<text x="${(cx + dx).toFixed(2)}" y="${(cy + dy).toFixed(2)}" ` +
      `font-size="12" font-weight="600" text-anchor="${anchor}" ` +
      `fill="var(${colorVar})">${label}</text>`
    );
  };

  const lastColor = lastPoint.uptime < 99 ? '--major' : '--operational';

  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" ` +
      `preserveAspectRatio="xMidYMid meet" role="img" ` +
      `aria-label="GitHub Platform 90-day rolling uptime since project start">`,
  );

  parts.push(
    '<defs>' +
      '<linearGradient id="uptimeHistoryArea" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="var(--operational)" stop-opacity="0.32"/>' +
      '<stop offset="100%" stop-color="var(--operational)" stop-opacity="0"/>' +
      '</linearGradient>' +
      '<linearGradient id="uptimeHistoryStroke" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="var(--operational)"/>' +
      '<stop offset="55%" stop-color="var(--minor)"/>' +
      '<stop offset="100%" stop-color="var(--major)"/>' +
      '</linearGradient>' +
      '</defs>',
  );

  // No title or subtitle inside the SVG: the panel heading says "All-time uptime"
  // above it and the caption carries the date range and methodology below it, both at
  // real body-text size. Dropping them returns ~50px of vertical space to the plot.

  for (let i = 0; i < yTicks.length; i += 1) {
    const yv = yTicks[i];
    const gy = yAt(yv);
    const isEdge = yv === 100 || yv === yMin;
    const dash = isEdge ? '' : ' stroke-dasharray="3 4"';
    parts.push(
      `<line x1="${marginLeft}" y1="${gy.toFixed(2)}" ` +
        `x2="${marginLeft + plotW}" y2="${gy.toFixed(2)}" ` +
        `stroke="var(--border)" stroke-width="1"${dash} opacity="0.85"/>`,
    );
    parts.push(
      `<text x="${marginLeft - 10}" y="${(gy + 4).toFixed(2)}" font-size="12" ` +
        `text-anchor="end" fill="var(--muted)">${yv.toFixed(0)}%</text>`,
    );
  }

  parts.push(
    `<line x1="${marginLeft}" y1="${baselineY.toFixed(2)}" ` +
      `x2="${marginLeft + plotW}" y2="${baselineY.toFixed(2)}" ` +
      `stroke="var(--ink)" stroke-width="1" opacity="0.6"/>`,
  );

  for (let i = 0; i < xTicks.length; i += 1) {
    const tick = xTicks[i];
    const gx = xAt(tick.time);
    parts.push(
      `<line x1="${gx.toFixed(2)}" y1="${baselineY.toFixed(2)}" ` +
        `x2="${gx.toFixed(2)}" y2="${(baselineY + 6).toFixed(2)}" ` +
        `stroke="var(--ink)" stroke-width="1" opacity="0.6"/>`,
    );
    parts.push(
      `<text x="${gx.toFixed(2)}" y="${(baselineY + 22).toFixed(2)}" ` +
        `font-size="12" text-anchor="middle" fill="var(--muted)">${tick.year}</text>`,
    );
  }

  parts.push(
    `<text x="${xAt(xMin).toFixed(2)}" y="${(baselineY + 42).toFixed(2)}" ` +
      `font-size="11" text-anchor="start" fill="var(--muted)">` +
      `start: ${formatUptimeHistoryDate(startDate)}</text>`,
  );
  parts.push(
    `<text x="${xAt(xMax).toFixed(2)}" y="${(baselineY + 42).toFixed(2)}" ` +
      `font-size="11" text-anchor="end" fill="var(--muted)">` +
      `today: ${formatUptimeHistoryDate(endDate)}</text>`,
  );

  parts.push(`<path d="${areaD}" fill="url(#uptimeHistoryArea)" stroke="none"/>`);

  if (yMin <= 99 && 99 <= yMax) {
    const ry = yAt(99);
    parts.push(
      `<line x1="${marginLeft}" y1="${ry.toFixed(2)}" ` +
        `x2="${marginLeft + plotW}" y2="${ry.toFixed(2)}" ` +
        `stroke="var(--major)" stroke-width="1" stroke-dasharray="4 4" opacity="0.55"/>`,
    );
    parts.push(
      `<text x="${(marginLeft + plotW - 6).toFixed(2)}" y="${(ry - 6).toFixed(2)}" ` +
        `font-size="11" text-anchor="end" fill="var(--major)" opacity="0.85">` +
        `99% (&#8220;two nines&#8221;)</text>`,
    );
  }

  parts.push(
    `<polyline points="${points}" fill="none" ` +
      `stroke="url(#uptimeHistoryStroke)" stroke-width="2" ` +
      `stroke-linejoin="round" stroke-linecap="round"/>`,
  );

  parts.push(
    annotate(
      maxPoint,
      `peak: ${maxPoint.uptime.toFixed(2)}% (${formatUptimeHistoryDate(maxPoint.time)})`,
      '--operational',
      -12,
    ),
  );
  if (Math.abs(minPoint.time - lastPoint.time) > 7 * UPTIME_HISTORY_ONE_DAY_MS) {
    parts.push(
      annotate(
        minPoint,
        `low: ${minPoint.uptime.toFixed(2)}% (${formatUptimeHistoryDate(minPoint.time)})`,
        '--major',
        18,
      ),
    );
  }
  parts.push(annotate(lastPoint, `today: ${lastPoint.uptime.toFixed(2)}%`, lastColor, -12));

  // Cursor layer, moved by the interaction code rather than re-rendered.
  parts.push(
    `<g class="uptime-cursor" opacity="0">` +
      `<line class="uptime-cursor-line" x1="0" y1="${marginTop}" x2="0" y2="${(marginTop + plotH).toFixed(2)}" ` +
      `stroke="var(--muted)" stroke-width="1" stroke-dasharray="3 3"/>` +
      `<circle class="uptime-cursor-dot" r="5" fill="var(--accent)" ` +
      `style="stroke: var(--card); stroke-width: 2"/>` +
      `</g>`,
  );

  parts.push('</svg>');
  return {
    markup: parts.join(''),
    geometry: { marginLeft, marginTop, plotW, plotH, xMin, xSpan, yMin, yMax, width, height },
  };
};

// The chart used to be drawn into a fixed 1200x480 viewBox and then scaled down by
// CSS to whatever the panel was wide. At 660px that is a 0.55x scale, so 12px axis
// labels reached the screen at 6.6px; on a phone the scale was 0.275x and they
// arrived at 3.3px. Sizing the viewBox to the measured container instead keeps the
// scale at 1, so declared font sizes are the sizes users actually get.
const layoutForWidth = (width) => {
  const compact = width < 560;
  return {
    width,
    height: Math.round(Math.min(Math.max(width * (compact ? 0.78 : 0.42), 300), 460)),
    marginLeft: compact ? 44 : 60,
    marginRight: compact ? 16 : 28,
    marginTop: compact ? 20 : 26,
    marginBottom: compact ? 48 : 58,
    compact,
  };
};

const nearestUptimePoint = (series, geometry, clientX, svgEl) => {
  const box = svgEl.getBoundingClientRect();
  const scale = box.width / geometry.width;
  const localX = (clientX - box.left) / scale;
  const ratio = (localX - geometry.marginLeft) / geometry.plotW;
  const clamped = Math.min(1, Math.max(0, ratio));
  const index = Math.round(clamped * (series.length - 1));
  return { index, point: series[index] };
};

// Clicking a point scopes the incident timeline to the 90-day window that produced
// it, turning "there is a dip in May 2026" into the incidents that caused it.
const focusTimelineOn = (point) => {
  const from = document.querySelector('[data-range-from]');
  const to = document.querySelector('[data-range-to]');
  if (!from || !to) return false;
  const end = new Date(point.time);
  const start = new Date(point.time - (UPTIME_HISTORY_WINDOW_DAYS - 1) * UPTIME_HISTORY_ONE_DAY_MS);
  const iso = (d) => d.toISOString().slice(0, 10);
  from.value = iso(start);
  to.value = iso(end);
  to.dispatchEvent(new Event('change', { bubbles: true }));
  const timeline = document.getElementById('incidentTimeline');
  if (timeline) timeline.closest('.panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  return true;
};

const attachUptimeHistoryInteraction = (container, series, geometry) => {
  const svgEl = container.querySelector('svg');
  const cursor = svgEl && svgEl.querySelector('.uptime-cursor');
  const line = cursor && cursor.querySelector('.uptime-cursor-line');
  const dot = cursor && cursor.querySelector('.uptime-cursor-dot');
  const tooltip = container.parentElement?.querySelector('.uptime-history-tooltip');
  if (!svgEl || !cursor || !tooltip) return;

  const xAt = (time) => geometry.marginLeft + ((time - geometry.xMin) / geometry.xSpan) * geometry.plotW;
  let active = -1;

  const hide = () => {
    active = -1;
    cursor.setAttribute('opacity', '0');
    tooltip.classList.remove('active');
    tooltip.setAttribute('aria-hidden', 'true');
  };

  const show = (index) => {
    const point = series[index];
    if (!point) return;
    active = index;
    const cx = xAt(point.time);
    const box = svgEl.getBoundingClientRect();
    const scale = box.width / geometry.width;

    line.setAttribute('x1', cx.toFixed(2));
    line.setAttribute('x2', cx.toFixed(2));
    const clamped = Math.min(geometry.yMax, Math.max(geometry.yMin, point.uptime));
    const cy =
      geometry.marginTop +
      (1 - (clamped - geometry.yMin) / (geometry.yMax - geometry.yMin)) * geometry.plotH;
    dot.setAttribute('cx', cx.toFixed(2));
    dot.setAttribute('cy', cy.toFixed(2));
    cursor.setAttribute('opacity', '1');

    const windowStart = new Date(point.time - (UPTIME_HISTORY_WINDOW_DAYS - 1) * UPTIME_HISTORY_ONE_DAY_MS);
    tooltip.innerHTML =
      `<div class="tooltip-date">${formatUptimeHistoryDate(point.time)}</div>` +
      `<div class="tooltip-summary"><strong>${point.uptime.toFixed(2)}%</strong>` +
      `<span>over the 90 days from ${formatUptimeHistoryDate(windowStart)}</span></div>` +
      `<div class="tooltip-related">Click to list these incidents</div>`;
    tooltip.classList.add('active');
    tooltip.setAttribute('aria-hidden', 'false');

    const left = Math.min(Math.max(cx * scale, 110), box.width - 110);
    const top = cy * scale;
    // Above the point by default, but flip below rather than escaping the chart and
    // covering the stat strip.
    const below = top - tooltip.offsetHeight - 16 < 0;
    tooltip.classList.toggle('below', below);
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  };

  const onMove = (event) => {
    const { index } = nearestUptimePoint(series, geometry, event.clientX, svgEl);
    if (index !== active) show(index);
  };

  svgEl.addEventListener('pointermove', onMove);
  svgEl.addEventListener('pointerdown', onMove);
  svgEl.addEventListener('pointerleave', hide);
  svgEl.addEventListener('click', () => {
    if (active >= 0) focusTimelineOn(series[active]);
  });

  // Replacing innerHTML discards the old SVG along with its listeners, but the
  // container survives every redraw. Publish the current controller and bind the
  // container-level handlers exactly once, or each resize would stack another
  // closure still holding the detached SVG and the previous geometry.
  container.uptimeCursor = {
    show,
    hide,
    lastIndex: () => series.length - 1,
    activeIndex: () => active,
    pointAt: (index) => series[index],
  };

  container.tabIndex = 0;
  if (container.dataset.cursorBound === 'true') return;
  container.dataset.cursorBound = 'true';

  container.addEventListener('focus', () => {
    const c = container.uptimeCursor;
    c.show(c.lastIndex());
  });
  container.addEventListener('blur', () => container.uptimeCursor.hide());
  container.addEventListener('keydown', (event) => {
    const c = container.uptimeCursor;
    const step = event.shiftKey ? 30 : 1;
    const current = c.activeIndex();
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      const base = current < 0 ? c.lastIndex() : current;
      const next = base + (event.key === 'ArrowRight' ? step : -step);
      c.show(Math.min(c.lastIndex(), Math.max(0, next)));
    } else if (event.key === 'Enter' && current >= 0) {
      event.preventDefault();
      focusTimelineOn(c.pointAt(current));
    } else if (event.key === 'Escape') {
      c.hide();
    }
  });
};

const renderUptimeHistoryChart = (windowEntries, rangeEnd, options = {}) => {
  const projectStartMs = options.projectStartUTC ?? PROJECT_START_UTC;
  const endMs = rangeEnd instanceof Date ? rangeEnd.getTime() : Number(rangeEnd);

  const intervals = collectUptimeHistoryIntervals(windowEntries);
  const series = computeUptimeHistorySeries(intervals, projectStartMs, endMs);
  const lifetimeUptime = computeLifetimeUptime(intervals, projectStartMs, endMs);

  const captionSelector = options.captionTarget || '#uptimeHistoryCaption';
  const chartSelector = options.chartTarget || '#uptimeHistoryImage';

  // Only the methodology is left. The start date is already on the x-axis as
  // "start: Jun 11, 2022", the lifetime figure is in the stat strip, and the hover
  // hint is redundant with the crosshair cursor and the container's aria-label.
  const caption = document.querySelector(captionSelector);
  if (caption) {
    caption.textContent = '90-day rolling window · non-maintenance downtime, merged windows';
  }

  const chartContainer = document.querySelector(chartSelector);
  if (chartContainer && series.length) {
    // clientWidth includes the container's padding; feeding that back as the viewBox
    // width leaves the SVG 8px wider than its box, which resizes it and retriggers
    // the observer. Measure the content box instead. The all-time tabpanel is hidden
    // on first render, so guard the zero (and the negative it becomes once padding is
    // subtracted) -- the ResizeObserver redraws at the real width once it is shown.
    const contentWidth = () => {
      const cs = window.getComputedStyle(chartContainer);
      const inner =
        chartContainer.clientWidth - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0);
      return inner > 0 ? Math.round(inner) : UPTIME_HISTORY_LAYOUT.width;
    };
    // Track the width actually drawn rather than the last width measured. The two can
    // desync -- a redraw deferred to the next frame may run after another resize, or
    // fall back when the container measures zero -- and comparing against the measured
    // value can then suppress the redraw that would have corrected it.
    let drawnWidth = -1;
    let correcting = false;
    const draw = () => {
      const width = contentWidth();
      const layout = options.layout || layoutForWidth(width);
      const { markup, geometry } = buildUptimeHistorySVG(series, layout);
      chartContainer.innerHTML = markup;
      drawnWidth = layout.width;
      attachUptimeHistoryInteraction(chartContainer, series, geometry);

      // A draw can land while the container measures zero (hidden panel, mid-layout
      // reflow) and fall back to the default width. Nothing resizes afterwards, so the
      // observer would never fire again to correct it -- re-check once instead.
      if (correcting) {
        correcting = false;
        return;
      }
      window.requestAnimationFrame(() => {
        if (Math.abs(contentWidth() - drawnWidth) < 8) return;
        correcting = true;
        draw();
      });
    };
    draw();

    // The tabpanel is hidden on first render, so the reveal — not a resize — is what
    // must trigger the real draw. setView calls this directly rather than trusting the
    // observer, which some engines collect when nothing holds a reference to it.
    chartContainer.redrawUptimeHistory = draw;

    if (typeof ResizeObserver === 'function' && !chartContainer.uptimeResizeObserver) {
      // Keep the reference: an unreferenced ResizeObserver is collectable in WebKit,
      // which silently stops the redraws.
      const observer = new ResizeObserver(() => {
        if (Math.abs(contentWidth() - drawnWidth) < 8) return;
        window.requestAnimationFrame(draw);
      });
      chartContainer.uptimeResizeObserver = observer;
      observer.observe(chartContainer);
    }
  }

  // The extremes are already found while annotating the chart; hand them back so the
  // panel does not have to walk the series again.
  let peak = series[0];
  let low = series[0];
  for (let i = 1; i < series.length; i += 1) {
    if (series[i].uptime > peak.uptime) peak = series[i];
    if (series[i].uptime < low.uptime) low = series[i];
  }

  return { lifetimeUptime, series, peak, low, latest: series[series.length - 1] };
};

var UptimeHistoryChart = {
  render: renderUptimeHistoryChart,
  computeUptimeHistorySeries,
  computeLifetimeUptime,
  collectDowntimeIntervals: collectUptimeHistoryIntervals,
  buildSVG: buildUptimeHistorySVG,
  formatUTCDate: formatUptimeHistoryDate,
  PROJECT_START_UTC,
  WINDOW_DAYS: UPTIME_HISTORY_WINDOW_DAYS,
};
