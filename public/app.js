(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  const state = {
    cfg: null, es: null, jobId: null, finished: true,
    total: 0, ok: 0, fail: 0, results: [], groups: new Map(), dots: [],
  };

  /* ---------------- API ---------------- */
  async function api(path, opts = {}) {
    const res = await fetch(path, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
    let data = null;
    try { data = await res.json(); } catch (_) { /* kosong */ }
    if (!res.ok) {
      if (res.status === 401 && state.cfg && state.cfg.authRequired) showLogin();
      const err = new Error((data && data.error) || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  /* ---------------- Tampilan ---------------- */
  const views = { login: $('#view-login'), ping: $('#view-ping'), history: $('#view-history') };
  function show(name) {
    for (const [k, v] of Object.entries(views)) v.hidden = k !== name;
    $$('#tabs button').forEach((b) => {
      if (b.dataset.tab === name) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    if (name === 'history') loadHistory();
  }
  function showLogin() {
    closeStream();
    $('#tabs').hidden = true; $('#logout').hidden = true;
    show('login');
    $('#password').focus();
  }
  function showApp() {
    $('#tabs').hidden = false;
    $('#logout').hidden = !state.cfg.authRequired;
    show('ping');
  }

  /* ---------------- Init ---------------- */
  async function init() {
    try { state.cfg = await api('/api/config'); }
    catch (e) { document.body.textContent = 'Tidak dapat terhubung ke server.'; return; }

    const cats = $('#cats');
    state.cfg.categories.forEach((c) => {
      const lab = el('label', 'chip');
      const inp = el('input');
      inp.type = 'checkbox'; inp.value = c.id; inp.name = 'cat';
      if (c.id === 'general') inp.checked = true;
      lab.append(inp, el('span', '', c.label));
      cats.append(lab);
    });

    if (state.cfg.authRequired && !state.cfg.authed) { showLogin(); return; }
    showApp();
    updateCount();

    const saved = sessionStorage.getItem('spm_job');
    if (saved) connect(saved);
  }

  /* ---------------- Login ---------------- */
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#login-error'); err.hidden = true;
    try {
      await api('/api/login', { method: 'POST', body: JSON.stringify({ password: $('#password').value }) });
      $('#password').value = '';
      state.cfg.authed = true;
      showApp();
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  });
  $('#logout').addEventListener('click', async () => {
    try { await api('/api/logout', { method: 'POST', body: '{}' }); } catch (_) {}
    state.cfg.authed = false;
    sessionStorage.removeItem('spm_job');
    showLogin();
  });
  $$('#tabs button').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));

  /* ---------------- Form ---------------- */
  function parseUrls() {
    return [...new Set($('#urls').value.split(/\s+/).map((s) => s.trim()).filter(Boolean))];
  }
  function updateCount() {
    const n = parseUrls().length, max = state.cfg ? state.cfg.maxUrls : 20;
    const c = $('#url-count');
    c.textContent = `${n} / ${max} URL`;
    c.style.color = n > max ? 'var(--fail)' : '';
  }
  $('#urls').addEventListener('input', updateCount);

  function formError(msg) {
    const e = $('#form-error');
    e.textContent = msg || ''; e.hidden = !msg;
  }

  $('#ping-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    formError('');
    const keyword = $('#keyword').value.trim();
    const urls = parseUrls();
    const categories = $$('#cats input:checked').map((i) => i.value);
    if (!keyword) return formError('Kata kunci / judul wajib diisi.');
    if (!urls.length) return formError('Masukkan minimal satu URL.');
    if (urls.length > state.cfg.maxUrls) return formError(`Maksimal ${state.cfg.maxUrls} URL per proses.`);
    const bad = urls.find((u) => !/^https?:\/\/[^\s/]+\.[^\s/]+/i.test(u));
    if (bad) return formError(`URL tidak valid: ${bad.slice(0, 80)}`);
    if (!categories.length) return formError('Pilih minimal satu kategori.');

    const btn = $('#submit');
    btn.disabled = true;
    try {
      const r = await api('/api/ping', {
        method: 'POST',
        body: JSON.stringify({ keyword, urls, categories, indexnowKey: $('#indexnow').value.trim() }),
      });
      sessionStorage.setItem('spm_job', r.jobId);
      connect(r.jobId);
    } catch (ex) {
      formError(ex.message);
      btn.disabled = false;
    }
  });

  /* ---------------- Live stream ---------------- */
  function closeStream() {
    if (state.es) { state.es.close(); state.es = null; }
  }

  function resetLive() {
    state.total = 0; state.ok = 0; state.fail = 0;
    state.results = []; state.groups = new Map(); state.dots = [];
    $('#grid').replaceChildren();
    $('#groups').replaceChildren();
    $('#groups').dataset.f = 'all';
    setFilter('all');
    renderStats();
  }

  function connect(jobId) {
    closeStream();
    state.jobId = jobId; state.finished = false;
    resetLive();
    $('#live-empty').hidden = true;
    $('#live-body').hidden = false;
    $('#live-title').textContent = 'Menghubungkan';
    $('#cancel').hidden = false; $('#cancel').disabled = false;
    $('#csv').hidden = true;
    $('#submit').disabled = true;

    const es = new EventSource(`/api/jobs/${jobId}/stream`);
    state.es = es;
    es.addEventListener('start', (e) => onStart(JSON.parse(e.data)));
    es.addEventListener('result', (e) => onResult(JSON.parse(e.data)));
    es.addEventListener('done', (e) => { onDone(JSON.parse(e.data)); es.close(); });
    es.onerror = () => {
      if (state.finished) return;
      if (es.readyState === EventSource.CLOSED) {
        $('#live-title').textContent = 'Koneksi terputus atau proses sudah kedaluwarsa';
        finishUi();
      } else {
        $('#live-title').textContent = 'Menyambung ulang';
      }
    };
  }

  function onStart(d) {
    state.total = d.total;
    $('#live-title').textContent = 'Mengirim ping';
    for (let i = 0; i < d.total; i++) {
      const dot = el('i', 'dot');
      state.dots.push(dot);
    }
    $('#grid').append(...state.dots);

    d.urls.forEach((u, i) => {
      const det = el('details', 'grp');
      if (d.urls.length <= 2 || i === 0) det.open = true;
      const sum = el('summary');
      const label = el('span', 'u', u); label.title = u;
      const badge = el('span', 'badge', '0 / 0');
      sum.append(label, badge);
      const rows = el('div', 'rows');
      det.append(sum, rows);
      $('#groups').append(det);
      state.groups.set(u, { rows, badge, ok: 0, total: 0 });
    });
    d.tasks.forEach((t) => { state.groups.get(t.url).total++; });
    for (const g of state.groups.values()) g.badge.textContent = `0 / ${g.total}`;
    renderStats();
  }

  function onResult(d) {
    if (state.results[d.idx]) return; // cegah duplikat saat reconnect
    state.results[d.idx] = d;
    const ok = d.status === 'success';
    if (ok) state.ok++; else state.fail++;

    const dot = state.dots[d.idx];
    if (dot) dot.className = 'dot ' + (ok ? 'ok' : 'fail');

    const g = state.groups.get(d.url);
    if (g) {
      if (ok) g.ok++;
      g.badge.textContent = `${g.ok} / ${g.total}`;
      const row = el('div', 'row');
      row.dataset.s = d.status;
      row.append(
        el('span', 'st', ok ? '✓ Berhasil' : '✕ Gagal'),
        el('span', 'svc', d.service),
        el('span', 'ms', `${d.ms} ms`),
      );
      if (d.message) row.append(el('span', 'msg', d.message));
      g.rows.append(row);
    }
    renderStats();
  }

  function onDone(s) {
    const sec = (s.durationMs / 1000).toFixed(1);
    $('#live-title').textContent = s.cancelled
      ? `Dibatalkan (${s.done} dari ${s.total} terkirim)`
      : `Selesai: ${s.success} berhasil, ${s.failed} gagal dalam ${sec} dtk`;
    finishUi();
    $('#csv').hidden = state.results.length === 0;
  }

  function finishUi() {
    state.finished = true;
    sessionStorage.removeItem('spm_job');
    $('#cancel').hidden = true;
    $('#submit').disabled = false;
  }

  function renderStats() {
    $('#n-ok').textContent = state.ok;
    $('#n-fail').textContent = state.fail;
    $('#n-total').textContent = state.total;
    const pct = state.total ? Math.round(((state.ok + state.fail) / state.total) * 100) : 0;
    $('#bar-fill').style.width = pct + '%';
    $('.bar').setAttribute('aria-valuenow', String(pct));
  }

  $('#cancel').addEventListener('click', async () => {
    $('#cancel').disabled = true;
    try { await api(`/api/jobs/${state.jobId}/cancel`, { method: 'POST', body: '{}' }); } catch (_) {}
  });

  /* ---------------- Filter ---------------- */
  function setFilter(f) {
    $('#groups').dataset.f = f;
    $$('.filters button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.f === f)));
  }
  $$('.filters button').forEach((b) => b.addEventListener('click', () => setFilter(b.dataset.f)));

  /* ---------------- CSV ---------------- */
  function csvCell(v) {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // cegah CSV injection
    return '"' + s.replace(/"/g, '""') + '"';
  }
  $('#csv').addEventListener('click', () => {
    const lines = [['url', 'layanan', 'status', 'ms', 'pesan'].join(',')];
    state.results.filter(Boolean).forEach((r) => {
      lines.push([r.url, r.service, r.status, r.ms, r.message].map(csvCell).join(','));
    });
    const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = el('a');
    a.href = URL.createObjectURL(blob);
    a.download = `shadow-pingmax-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  /* ---------------- Riwayat ---------------- */
  async function loadHistory() {
    const box = $('#history-list');
    box.replaceChildren(el('p', 'muted', 'Memuat'));
    try {
      const list = await api('/api/history');
      box.replaceChildren();
      if (!list.length) {
        box.append(el('p', 'muted', 'Belum ada riwayat. Proses ping yang selesai akan tersimpan di sini.'));
        return;
      }
      list.forEach((h) => {
        const det = el('details', 'hist');
        const sum = el('summary');
        const k = el('span', 'k', h.keyword);
        k.append(el('span', 'when', new Date(h.createdAt).toLocaleString('id-ID')));
        sum.append(k, el('span', 'res', `${h.success} / ${h.total} berhasil`));
        const inner = el('div', 'inner');
        h.perUrl.forEach((p) => {
          const r = el('div');
          r.append(el('span', '', p.url), el('span', '', `${p.success} / ${p.success + p.failed}`));
          inner.append(r);
        });
        const again = el('button', 'btn ghost', 'Pakai lagi di form');
        again.type = 'button';
        again.addEventListener('click', () => {
          $('#keyword').value = h.keyword;
          $('#urls').value = h.urls.join('\n');
          $$('#cats input').forEach((i) => { i.checked = h.categories.includes(i.value); });
          updateCount();
          show('ping');
          window.scrollTo({ top: 0 });
        });
        inner.append(again);
        det.append(sum, inner);
        box.append(det);
      });
    } catch (ex) {
      box.replaceChildren(el('p', 'error', ex.message));
    }
  }

  init();
})();
