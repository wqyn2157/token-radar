/* Token Launch Radar: renders window.RADAR (written by main.ts as ../data.js). No fetch, no network. */
(function () {
  'use strict';
  var R = window.RADAR;
  if (!R) return;

  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function usd(n) {
    if (n == null) return '—';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
    return '$' + Math.round(n);
  }
  function pct(n) {
    if (n == null) return '<span class="flat">n/a</span>';
    var cls = n > 0.05 ? 'up' : n < -0.05 ? 'down' : 'flat';
    return '<span class="' + cls + '">' + (n >= 0 ? '+' : '') + n.toFixed(1) + '%</span>';
  }
  function mult(n) { return n == null ? '—' : n.toFixed(2) + 'x'; }
  function ageText(days) {
    if (days == null) return 'unknown';
    if (days < 60) return days + 'd';
    if (days < 730) return Math.round(days / 30.4) + ' mo';
    return (days / 365.25).toFixed(1) + ' yr';
  }

  /* header */
  el('subline').textContent =
    'Snapshot: ' + R.source + ' Board built by model ' + R.model_version + ': every figure below is derived from that one sealed snapshot.';
  el('stats').innerHTML =
    stat(R.scanned_size, 'protocols scanned') +
    stat(R.watchlist_size, 'watchlist covered') +
    stat(R.board_size, 'rows on the board') +
    stat(R.early_size, 'found below the floor') +
    stat(usd(R.total_implied_usd), 'total implied value') +
    stat(mult(R.global_median), 'market median multiple');
  function stat(b, s) { return '<div class="stat"><b>' + b + '</b><span>' + s + '</span></div>'; }
  el('footline').textContent =
    'Data: ' + R.source + ' Implied value model ' + R.model_version + '. Protocols whose token already trades are listed under "Already trading" and are never ranked here.';

  /* category multiples table */
  var catHtml = '<table><thead><tr><th>Category</th><th class="n">Tokenised peers</th><th class="n">Median mcap/TVL</th><th class="n">Multiple used</th></tr></thead><tbody>';
  R.categories.forEach(function (c) {
    catHtml += '<tr><td>' + esc(c.category) + '</td><td class="n">' + c.peers + '</td><td class="n">' + mult(c.median) + '</td><td class="n">' + mult(c.blended) + '</td></tr>';
  });
  catHtml += '</tbody></table>';
  el('catTable').innerHTML = catHtml;

  /* filter state, seeded from the URL so a view can be linked or photographed */
  var params = new URLSearchParams(location.search);
  var state = {
    q: params.get('q') || '',
    cat: params.get('cat') || '',
    chain: params.get('chain') || '',
    sort: params.get('sort') || 'rank',
    watch: params.get('watch') === '1',
    view: 'board'
  };
  var catSel = el('catSel'), chainSel = el('chainSel');
  var cats = [], chains = [];
  R.rows.forEach(function (r) {
    if (r.category && cats.indexOf(r.category) < 0) cats.push(r.category);
    r.chains.forEach(function (c) { if (chains.indexOf(c) < 0) chains.push(c); });
  });
  cats.sort(); chains.sort();
  cats.forEach(function (c) { catSel.insertAdjacentHTML('beforeend', '<option>' + esc(c) + '</option>'); });
  chains.forEach(function (c) { chainSel.insertAdjacentHTML('beforeend', '<option>' + esc(c) + '</option>'); });
  el('q').value = state.q;
  catSel.value = state.cat; chainSel.value = state.chain;
  el('sortSel').value = state.sort; el('watchOnly').checked = state.watch;

  function visibleRows() {
    var q = state.q.trim().toLowerCase();
    var rows = R.rows.filter(function (r) {
      if (state.watch && !r.watchlist) return false;
      if (state.cat && r.category !== state.cat) return false;
      if (state.chain && r.chains.indexOf(state.chain) < 0) return false;
      if (q && (r.name + ' ' + (r.category || '') + ' ' + r.slug).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var by = {
      rank: function (a, b) { return a.rank - b.rank; },
      tvl: function (a, b) { return b.tvl_usd - a.tvl_usd || a.rank - b.rank; },
      momentum: function (a, b) { return (b.change_7d == null ? -999 : b.change_7d) - (a.change_7d == null ? -999 : a.change_7d) || a.rank - b.rank; },
      age: function (a, b) { return (b.age_days == null ? -1 : b.age_days) - (a.age_days == null ? -1 : a.age_days) || a.rank - b.rank; },
      score: function (a, b) { return b.score - a.score || a.rank - b.rank; }
    };
    return rows.sort(by[state.sort] || by.rank);
  }

  function renderBoard() {
    var rows = visibleRows();
    el('rowCount').textContent = rows.length + ' of ' + R.board_size + ' protocols';
    el('boardEmpty').hidden = rows.length > 0;
    el('boardBody').innerHTML = rows.map(function (r) {
      return '<tr data-slug="' + esc(r.slug) + '">' +
        '<td class="num">' + r.rank + '</td>' +
        '<td><span class="pname">' + esc(r.name) + '</span>' + (r.watchlist ? '<span class="badge">WATCHLIST</span>' : '') +
        '<br><span class="pcat">' + esc(r.category || 'Uncategorised') + '</span></td>' +
        '<td class="scoreCell">' + r.score.toFixed(1) + '<div class="scoreBar"><i style="width:' + r.score.toFixed(1) + '%"></i></div></td>' +
        '<td class="num"><strong>' + usd(r.implied_value_usd) + '</strong></td>' +
        '<td class="num">' + usd(r.tvl_usd) + '</td>' +
        '<td class="num">' + pct(r.change_7d) + '</td>' +
        '<td class="num">' + r.chains.length + '</td>' +
        '<td class="num">' + ageText(r.age_days) + '</td></tr>';
    }).join('');
    Array.prototype.forEach.call(el('boardBody').querySelectorAll('tr'), function (tr) {
      tr.addEventListener('click', function () { location.hash = '#p/' + tr.getAttribute('data-slug'); });
    });
  }

  /* live view: the model's raw material, kept off the board */
  el('liveBody').innerHTML = R.live.map(function (r) {
    return '<tr><td><span class="pname">' + esc(r.name) + '</span><br><span class="pcat">' + esc(r.category || 'Uncategorised') + '</span></td>' +
      '<td class="num">' + usd(r.mcap_usd) + '</td><td class="num">' + usd(r.tvl_usd) + '</td>' +
      '<td class="num">' + mult(r.multiple) + '</td><td class="num">' + pct(r.change_7d) + '</td></tr>';
  }).join('');

  /* detail view */
  function factor(name, frac, val) {
    var w = Math.max(0, Math.min(1, frac)) * 100;
    return '<div class="factor"><span class="fname">' + name + '</span><span class="fbar"><i style="width:' + w.toFixed(1) + '%"></i></span><span class="fval">' + val + '</span></div>';
  }
  function openDetail(slug) {
    var r = null;
    R.rows.forEach(function (x) { if (x.slug === slug) r = x; });
    if (!r) { closeDetail(); return; }
    var m = r.model;
    var peerNote = m.peers > 0
      ? m.category + ' median ' + mult(m.category_median) + ' over ' + m.peers + ' peer' + (m.peers === 1 ? '' : 's') + ', shrunk toward the ' + mult(m.global_median) + ' market median'
      : 'no tokenised peer in the snapshot; the ' + mult(m.global_median) + ' market median applies';
    el('detailView').innerHTML =
      '<div class="card detail">' +
      '<button type="button" class="back" id="backBtn">← Back to the board</button>' +
      '<h2>' + esc(r.name) + (r.watchlist ? '<span class="badge">WATCHLIST</span>' : '') + '</h2>' +
      '<p class="dsub">Rank #' + r.rank + ' of ' + R.board_size + ' · ' + esc(r.category || 'Uncategorised') + ' · records no token in the snapshot' +
      (r.listed_at ? ' · tracked since ' + esc(r.listed_at) : '') + '</p>' +
      '<div class="dgrid">' +
      dstat(usd(r.implied_value_usd), 'implied launch value') +
      dstat(r.score.toFixed(1) + ' / 100', 'radar score') +
      dstat(usd(r.tvl_usd), 'TVL') +
      dstat(r.change_7d == null ? 'n/a' : (r.change_7d >= 0 ? '+' : '') + r.change_7d.toFixed(1) + '%', 'TVL, 7 days') +
      dstat(ageText(r.age_days), 'age with no token') +
      dstat(String(r.chains.length), 'chains') +
      '</div>' +
      (r.chains.length ? '<p class="muted runs">Runs on: ' + esc(r.chains.join(', ')) + '</p>' : '') +
      '<h3>How this value is built</h3><div class="factors">' +
      factor('Category multiple', m.multiple / 2.5, mult(m.multiple) + ' — ' + peerNote) +
      factor('Base value', Math.min(1, m.base_value_usd / Math.max(1, r.implied_value_usd)), usd(r.tvl_usd) + ' TVL × ' + mult(m.multiple) + ' = ' + usd(m.base_value_usd)) +
      factor('Momentum ×' + m.momentum_multiplier.toFixed(2), (m.momentum_multiplier - 0.7) / 0.9, (m.momentum_pct >= 0 ? '+' : '') + m.momentum_pct.toFixed(1) + '% TVL in 7 days, weighted 0.6') +
      factor('Maturity ×' + m.maturity_multiplier.toFixed(2), (m.maturity_multiplier - 0.8) / 0.35, ageText(r.age_days) + ' tracked with no token') +
      factor('Reach ×' + m.reach_multiplier.toFixed(2), (m.reach_multiplier - 1) / 0.25, m.chain_count + ' chain' + (m.chain_count === 1 ? '' : 's')) +
      '<div class="factor total"><span class="fname">Implied launch value</span><span></span><span class="fval">' + usd(r.implied_value_usd) + '</span></div>' +
      '</div>' +
      '<h3>Why it ranks here</h3><p class="why">' + esc(r.rationale) + '</p>' +
      '<h3>How to farm it</h3><ol class="plan">' +
      r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') +
      '</ol></div>';
    el('boardView').hidden = true;
    el('liveView').hidden = true;
    el('detailView').hidden = false;
    el('backBtn').addEventListener('click', function () { location.hash = ''; });
    window.scrollTo(0, 0);
  }
  function dstat(b, s) { return '<div class="dstat"><b>' + b + '</b><span>' + s + '</span></div>'; }
  function closeDetail() {
    el('detailView').hidden = true;
    showView(state.view);
  }

  /* views and tabs */
  function showView(view) {
    state.view = view;
    el('tabBoard').classList.toggle('on', view === 'board');
    el('tabLive').classList.toggle('on', view === 'live');
    el('boardView').hidden = view !== 'board';
    el('liveView').hidden = view !== 'live';
    el('detailView').hidden = true;
  }
  el('tabBoard').addEventListener('click', function () { showView('board'); });
  el('tabLive').addEventListener('click', function () { showView('live'); });

  function route() {
    var h = location.hash;
    if (h.indexOf('#p/') === 0) openDetail(decodeURIComponent(h.slice(3)));
    else closeDetail();
  }
  window.addEventListener('hashchange', route);

  /* controls */
  el('q').addEventListener('input', function (e) { state.q = e.target.value; renderBoard(); });
  catSel.addEventListener('change', function (e) { state.cat = e.target.value; renderBoard(); });
  chainSel.addEventListener('change', function (e) { state.chain = e.target.value; renderBoard(); });
  el('sortSel').addEventListener('change', function (e) { state.sort = e.target.value; renderBoard(); });
  el('watchOnly').addEventListener('change', function (e) { state.watch = e.target.checked; renderBoard(); });

  renderBoard();
  route();
})();
