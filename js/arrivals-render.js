export function renderHeatmap(container, bins) {
  container.innerHTML = '';
  if (bins.length === 0) {
    container.innerHTML = '<div class="empty">表示可能な時間帯がありません</div>';
    return;
  }
  const maxPax = Math.max(1, ...bins.map(b => b.totalPax));
  for (const b of bins) {
    const row = document.createElement('div');
    row.className = 'heatmap-row' + (b.isPeak ? ' is-peak' : '');
    const widthPct = (b.totalPax / maxPax) * 100;
    const unknownNote = b.unknownCount > 0 ? ` (機材不明${b.unknownCount})` : '';
    row.innerHTML = `
      <span class="heatmap-time">${b.bin}</span>
      <span class="heatmap-bar" style="width:${widthPct}%"></span>
      <span class="heatmap-label">${b.totalPax}人 (${b.flightCount}便)${unknownNote}</span>
    `;
    container.appendChild(row);
  }
}

export function renderFlightList(container, flights) {
  container.innerHTML = '';
  if (flights.length === 0) {
    container.innerHTML = '<div class="empty">表示可能な便がありません</div>';
    return;
  }
  for (const f of flights) {
    const row = document.createElement('div');
    const isDelayed = f.status === '遅延';
    const isUnknown = f.aircraftCode === null;
    row.className = 'flight-row' + (isDelayed ? ' is-delayed' : '') + (isUnknown ? ' is-unknown' : '');
    const time = f.estimatedTime ?? f.scheduledTime ?? '--:--';
    const aircraft = f.aircraftCode ?? '機材不明';
    const pax = f.estimatedPax !== null ? `約${f.estimatedPax}人` : '推定不可';
    const factorNote = f.loadFactorSource === 'route'
      ? ` (路線実績 ${Math.round(f.loadFactor * 100)}%)`
      : f.loadFactorSource === 'default'
        ? ` (平均搭乗率 ${Math.round(f.loadFactor * 100)}%)`
        : '';
    const statusIcon = isDelayed ? ' ⚠' : '';
    row.innerHTML = `
      <div class="flight-line1">
        <span class="time">${time}</span>
        <span class="flight-no">${f.flightNumber}</span>
        <span class="from">${f.fromName}</span>
        <span class="aircraft">${aircraft}</span>
      </div>
      <div class="flight-line2">
        <span class="pax">${pax}</span>
        <span class="status">${f.status}${statusIcon}</span>
        <span class="factor">${factorNote}</span>
      </div>
    `;
    container.appendChild(row);
  }
}

export function renderUpdatedAt(container, updatedAt, totalUnknownAircraft) {
  const t = new Date(updatedAt);
  const minAgo = Math.floor((Date.now() - t.getTime()) / 60000);
  const stale = minAgo > 10;
  const hh = String(t.getHours()).padStart(2, '0');
  const mm = String(t.getMinutes()).padStart(2, '0');
  container.innerHTML = `
    <span class="updated">最終更新: ${hh}:${mm} (${minAgo}分前)${stale ? ' ⚠ データが古い' : ''}</span>
    <span class="unknown-stat">${totalUnknownAircraft > 0 ? `機材不明: ${totalUnknownAircraft}便` : ''}</span>
    <span class="source">データ出典: ODPT / 国交省統計</span>
  `;
  container.classList.toggle('is-stale', stale);
}
