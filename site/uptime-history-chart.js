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

const isUptimeHistoryDowntime = (impact) => (impact || 'none') !== 'maintenance';

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
  if (!series.length) return '';

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
    return (
      `<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="4" ` +
      `fill="var(${colorVar})" style="stroke: var(--card); stroke-width: 1.5"/>` +
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

  parts.push(
    `<text x="${marginLeft}" y="38" font-size="20" font-weight="600" ` +
      `fill="var(--ink)" font-family="var(--display, 'Space Grotesk', sans-serif)">` +
      `GitHub Platform &#8212; 90-day rolling uptime</text>`,
  );
  parts.push(
    `<text x="${marginLeft}" y="58" font-size="12" fill="var(--muted)">` +
      `${formatUptimeHistoryDate(startDate)} &#8594; ${formatUptimeHistoryDate(endDate)} &#183; ` +
      `non-maintenance downtime, merged windows</text>`,
  );

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

  parts.push('</svg>');
  return parts.join('');
};

const renderUptimeHistoryChart = (windowEntries, rangeEnd, options = {}) => {
  const projectStartMs = options.projectStartUTC ?? PROJECT_START_UTC;
  const endMs = rangeEnd instanceof Date ? rangeEnd.getTime() : Number(rangeEnd);

  const intervals = collectUptimeHistoryIntervals(windowEntries);
  const series = computeUptimeHistorySeries(intervals, projectStartMs, endMs);
  const lifetimeUptime = computeLifetimeUptime(intervals, projectStartMs, endMs);

  const targetSelector = options.percentTarget || '#uptimePercentAll';
  const captionSelector = options.captionTarget || '#uptimeHistoryCaption';
  const chartSelector = options.chartTarget || '#uptimeHistoryImage';

  const target = document.querySelector(targetSelector);
  if (target) {
    target.textContent = `${lifetimeUptime.toFixed(2)}% lifetime uptime`;
  }

  const caption = document.querySelector(captionSelector);
  if (caption) {
    caption.textContent =
      `90-day rolling uptime since the project began on ${formatUptimeHistoryDate(
        new Date(projectStartMs),
      )}. Lifetime uptime: ${lifetimeUptime.toFixed(2)}%.`;
  }

  const chartContainer = document.querySelector(chartSelector);
  if (chartContainer) {
    chartContainer.innerHTML = buildUptimeHistorySVG(series);
  }

  return { lifetimeUptime, series };
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
