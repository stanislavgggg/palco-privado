/* Palco Privado mini app. Vanilla JS, no build step.
   All data goes through /api with Telegram initData in a header; the server validates it. */
(function () {
  'use strict';

  const tg = window.Telegram && window.Telegram.WebApp;
  const initData = tg ? tg.initData : '';
  const $ = (id) => document.getElementById(id);
  let state = null;

  if (tg) {
    tg.ready();
    tg.expand();
    try { tg.setHeaderColor('#0a281f'); tg.setBackgroundColor('#0a281f'); } catch (e) { /* older clients */ }
  }

  // ---------- API ----------
  async function call(path, body) {
    const res = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: Object.assign({ 'X-Telegram-Init-Data': initData }, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 409 && res.status !== 400) throw Object.assign(new Error('http'), { status: res.status, data });
    return Object.assign({ httpStatus: res.status }, data);
  }

  // ---------- helpers ----------
  const fmt = (ms, tz) => {
    const d = new Date(ms);
    const day = new Intl.DateTimeFormat('es-ES', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(d);
    const time = new Intl.DateTimeFormat('es-ES', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
    return `${day}, ${time}`;
  };
  const label = (m, side) => (side === 'home' ? m.home : side === 'away' ? m.away : 'Empate');
  const haptic = (t) => { try { tg && tg.HapticFeedback.notificationOccurred(t); } catch (e) { /* noop */ } };
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

  function showStatus(text) {
    const s = $('status');
    s.textContent = text || '';
    s.hidden = !text;
  }

  // ---------- render ----------
  function renderHeader() {
    const u = state.user;
    $('scoreUser').textContent = u.scoreUser;
    $('scoreAi').textContent = u.scoreAi;
    const st = $('streak');
    if (u.streak > 0) {
      st.textContent = `Racha: ${u.streak} acierto${u.streak === 1 ? '' : 's'} seguido${u.streak === 1 ? '' : 's'}`;
      st.hidden = false;
    } else st.hidden = true;
    $('companyName').textContent = state.companyName;
  }

  function fillReveal(box, m, myPick, reveal) {
    box.textContent = '';
    if (!reveal) { box.hidden = true; return; }
    const head = el('p');
    if (reveal.sameAsAi) {
      head.append('Coincides con la IA: ', el('span', 'ai', label(m, reveal.aiPick)), '.');
    } else {
      head.append(`Te la juegas con ${label(m, myPick)}. ${reveal.agree} de ${reveal.total} modelos van con `,
        el('span', 'ai', label(m, reveal.aiPick)), '.');
    }
    box.append(head);
    if (reveal.reason) box.append(el('p', 'why', `Su motivo: ${reveal.reason}`));
    box.append(el('p', 'why', 'El resultado llega cuando termine el partido.'));
    box.hidden = false;
  }

  function ticketFor(m) {
    const node = $('ticketTpl').content.firstElementChild.cloneNode(true);
    node.querySelector('.ticket__comp').textContent = m.competition || 'Fútbol';
    const time = node.querySelector('.ticket__time');
    time.textContent = fmt(m.startsAt, state.timeZone);
    time.dateTime = new Date(m.startsAt).toISOString();
    node.querySelector('.ticket__home').textContent = m.home;
    node.querySelector('.ticket__away').textContent = m.away;
    const btns = node.querySelectorAll('.pick');
    btns[0].textContent = m.home;
    btns[2].textContent = m.away;
    const stub = node.querySelector('.ticket__stub span');
    const reveal = node.querySelector('.ticket__reveal');

    function paint(myPick, rv) {
      btns.forEach((b) => {
        b.setAttribute('aria-pressed', String(b.dataset.pick === myPick));
        b.disabled = Boolean(myPick) || m.locked;
        b.toggleAttribute('data-ai', Boolean(rv) && b.dataset.pick === rv.aiPick);
      });
      node.classList.toggle('is-picked', Boolean(myPick));
      node.classList.toggle('is-locked', m.locked && !myPick);
      stub.textContent = myPick ? label(m, myPick).slice(0, 14) : m.locked ? 'Cerrado' : 'Tu pick';
      fillReveal(reveal, m, myPick, rv);
    }
    paint(m.myPick, m.reveal);

    btns.forEach((b) => b.addEventListener('click', async () => {
      if (b.disabled) return;
      btns.forEach((x) => { x.disabled = true; });
      try {
        const r = await call('/api/pick', { matchId: m.id, pick: b.dataset.pick });
        if (r.status === 'locked') { m.locked = true; paint(null, null); showStatus('Este partido ya está cerrado.'); haptic('warning'); return; }
        if (r.status === 'invalid') { showStatus('Este partido ya no está disponible.'); await load(); return; }
        m.myPick = r.myPick; m.reveal = r.reveal;
        node.classList.add('is-stamping');
        paint(r.myPick, r.reveal);
        haptic('success');
        state.user.picks += r.status === 'ok' ? 1 : 0;
        renderOptIns();
      } catch (e) {
        paint(null, null);
        showStatus('No se pudo guardar. Comprueba la conexión e inténtalo otra vez.');
      }
    }));
    return node;
  }

  function renderMatches() {
    const box = $('matches');
    box.textContent = '';
    if (!state.matches.length) {
      const e = el('div', 'empty');
      e.append(el('strong', null, 'No hay partidos abiertos ahora mismo'), 'Vuelve antes de la próxima jornada de LaLiga o Champions.');
      box.append(e);
      return;
    }
    state.matches.forEach((m) => box.append(ticketFor(m)));
  }

  function renderOptIns() {
    const picked = state.user.picks > 0;
    $('pmCard').hidden = state.pmAllowed || !picked || !(tg && tg.requestWriteAccess);
    const wa = state.wa;
    $('waForm').hidden = wa.saved || !picked;
    $('waSaved').hidden = !wa.saved;
    if (wa.saved) $('waPhoneMasked').textContent = wa.phone;
  }

  function renderHistory() {
    const list = $('history');
    list.textContent = '';
    if (!state.history.length) {
      const e = el('li', 'empty');
      e.append(el('strong', null, 'Aún no tienes pronósticos'), 'Elige un resultado en Partidos y aquí verás cómo acaba.');
      list.append(e);
      return;
    }
    state.history.forEach((h) => {
      const li = el('li');
      li.append(el('span', 'teams', `${h.home} – ${h.away}`), el('span', 'score', h.graded ? (h.score || 'Final') : 'Pendiente'));
      const line = el('p', 'line');
      line.append(`Tú: ${label(h, h.myPick)} `);
      if (h.graded) line.append(el('span', h.correct ? 'hit' : 'miss', h.correct ? '(acierto)' : '(fallo)'));
      line.append('   IA: ', el('span', 'ai', label(h, h.aiPick)), ' ');
      if (h.graded) line.append(el('span', h.aiCorrect ? 'hit' : 'miss', h.aiCorrect ? '(acierto)' : '(fallo)'));
      li.append(line);
      list.append(li);
    });
  }

  async function renderTop() {
    const list = $('top');
    list.textContent = '';
    $('topMe').textContent = '';
    try {
      const r = await call('/api/top');
      if (!r.rows.length) {
        const e = el('li', 'empty');
        e.append(el('strong', null, 'Todavía no hay resultados esta semana'), 'El top se llena cuando terminan los primeros partidos.');
        list.append(e);
      }
      r.rows.forEach((row, i) => {
        const li = el('li', row.me ? 'me' : '');
        li.append(el('span', 'pos', String(i + 1)), el('span', null, row.name), el('span', 'wins', `${row.wins}/${row.graded}`));
        list.append(li);
      });
      if (r.me) $('topMe').textContent = `Vas el ${r.me.rank}.º de ${r.me.of} con ${r.me.wins} aciertos.`;
    } catch (e) {
      showStatus('No se pudo cargar el top.');
    }
  }

  function render() {
    renderHeader();
    renderMatches();
    renderOptIns();
    renderHistory();
  }

  // ---------- tabs ----------
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    ['matches', 'history', 'top'].forEach((t) => { $(`panel-${t}`).hidden = t !== b.dataset.tab; });
    showStatus('');
    if (b.dataset.tab === 'top') renderTop();
  }));

  // ---------- WhatsApp form ----------
  const waCheck = () => { $('waSubmit').disabled = !($('waAdult').checked && $('waConsent').checked && $('waPhone').value.trim().length >= 9); };
  ['waAdult', 'waConsent'].forEach((id) => $(id).addEventListener('change', waCheck));
  $('waPhone').addEventListener('input', waCheck);

  $('waForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const err = $('waError');
    err.hidden = true;
    $('waSubmit').disabled = true;
    try {
      const r = await call('/api/wa', { phone: $('waPhone').value, adult: $('waAdult').checked, consent: $('waConsent').checked });
      if (r.error === 'invalid_phone') { err.textContent = 'Ese número no parece válido. Escríbelo con prefijo, por ejemplo +34 612 345 678.'; err.hidden = false; waCheck(); return; }
      if (r.error) { err.textContent = 'Marca las dos casillas para activar los avisos.'; err.hidden = false; waCheck(); return; }
      state.wa = { saved: true, phone: r.phone };
      haptic('success');
      renderOptIns();
    } catch (e) {
      err.textContent = 'No se pudo guardar. Inténtalo otra vez.';
      err.hidden = false;
      waCheck();
    }
  });

  $('waOptout').addEventListener('click', async () => {
    try {
      await call('/api/wa/optout', {});
      state.wa = { saved: false, phone: null, optedOut: true };
      $('waPhone').value = ''; $('waAdult').checked = false; $('waConsent').checked = false; waCheck();
      renderOptIns();
      showStatus('Hecho: hemos borrado tu número. No recibirás mensajes por WhatsApp.');
    } catch (e) {
      showStatus('No se pudo completar la baja. Inténtalo otra vez.');
    }
  });

  // ---------- Telegram write access ----------
  $('pmBtn').addEventListener('click', () => {
    if (!tg || !tg.requestWriteAccess) return;
    tg.requestWriteAccess(async (granted) => {
      if (!granted) return;
      try { await call('/api/pm', { allowed: true }); } catch (e) { /* non-blocking */ }
      state.pmAllowed = true;
      renderOptIns();
      showStatus('Listo: te avisaremos aquí en Telegram con cada resultado.');
    });
  });

  // ---------- boot ----------
  async function load() {
    if (!initData) {
      showStatus('Abre Palco Privado desde Telegram para jugar.');
      $('matches').textContent = '';
      return;
    }
    try {
      state = await call('/api/state');
      render();
    } catch (e) {
      showStatus(e.status === 401 ? 'La sesión ha caducado. Cierra y vuelve a abrir la app desde Telegram.' : 'No se pudieron cargar los partidos. Inténtalo en un momento.');
    }
  }
  load();
})();
