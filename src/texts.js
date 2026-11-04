// Textos (español de España). Juego gratuito: el usuario elige el resultado,
// luego ve qué eligieron los modelos de IA; tras el partido, marcador Tú vs IA.
// Sin premios ni operadores de apuestas dentro del bot.

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function fmtTime(ms, tz) {
  const d = new Date(ms);
  const date = new Intl.DateTimeFormat('es-ES', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(d);
  const time = new Intl.DateTimeFormat('es-ES', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  return `${date} · ${time}`;
}

const outcomeLabel = (m, side) => (side === 'home' ? m.home : side === 'away' ? m.away : 'Empate');
const score = (u) => `Tú ${u.score_user} – ${u.score_ai} IA`;

module.exports = {
  esc,
  outcomeLabel,

  intro: () =>
    '<b>Bienvenido al Palco Privado.</b>\n\n' +
    'Aquí no te regalamos pronósticos: los haces tú. Elige cómo acaban los partidos de LaLiga y Champions y después verás qué eligieron nuestros modelos de IA y por qué.\n\n' +
    'Tras cada partido: acierto o fallo, tu racha y el marcador <b>Tú vs IA</b>. Gratis.',

  question: (m, i, n, tz) =>
    `⚽ <b>${n > 1 ? `Partido ${i + 1} de ${n}: ` : ''}${esc(m.home)} – ${esc(m.away)}</b>\n` +
    `${m.competition ? esc(m.competition) + ' · ' : ''}🕒 ${fmtTime(m.startsAt, tz)}\n\n¿Cómo acaba?`,

  noSlate: () => 'Ahora mismo no hay partidos abiertos. Te avisamos cuando salga la próxima jornada.',
  allPicked: () => 'Ya has elegido todos los partidos abiertos. Te avisamos con cada resultado.',
  locked: () => '⛔ Este partido ya está cerrado: empieza en menos de 5 minutos.',
  already: (m, p) => `Ya elegiste <b>${esc(outcomeLabel(m, p.pick))}</b> en este partido. Un pronóstico por partido.`,

  reveal(m, pick) {
    const why = m.models.find((x) => x.side === m.consensus && x.rationale)?.rationale || '';
    const head = pick === m.consensus
      ? `✅ Coincides con la IA: <b>${esc(outcomeLabel(m, pick))}</b>.`
      : `🔥 Te la juegas. Elegiste <b>${esc(outcomeLabel(m, pick))}</b> — ${m.agree} de ${m.total} modelos van con <b>${esc(outcomeLabel(m, m.consensus))}</b>.`;
    return `${head}${why ? `\n\nEl motivo principal de la IA: ${esc(why)}` : ''}\n\nEl resultado llega cuando termine el partido.`;
  },

  graded(m, p, u, rank) {
    const you = p.correct ? '✅ Acertaste' : '❌ Esta vez no';
    const ai = p.ai_correct ? 'la IA acertó' : 'la IA falló';
    const lines = [
      `<b>${esc(m.home)} ${esc(m.result.score || '')} ${esc(m.away)}</b>`.replace(/\s+/g, ' '),
      `${you} · ${ai}`,
      '',
      `Marcador: <b>${score(u)}</b>`,
      `Racha: ${u.streak}${u.best_streak > u.streak ? ` (mejor: ${u.best_streak})` : ''}`,
    ];
    if (rank) lines.push(`Esta semana: #${rank.rank} de ${rank.of}`);
    return lines.join('\n');
  },

  // WhatsApp ask + consent (GDPR): explicit, specific, with opt-out and privacy link.
  waAsk: (cfg) =>
    '📲 <b>¿Te mandamos el pick de la IA por WhatsApp?</b>\n\n' +
    'Antes de cada partido grande: alineaciones confirmadas y lo que dicen los modelos. Máximo un mensaje al día.\n\n' +
    `<i>Al pulsar «Acepto» confirmas que tienes 18 años o más y aceptas recibir por WhatsApp pronósticos de fútbol y comunicaciones comerciales de ${esc(cfg.companyName)}. ` +
    'Puedes darte de baja cuando quieras escribiendo /baja aquí o «BAJA» por WhatsApp.' +
    (cfg.privacyUrl ? ` Política de privacidad: ${esc(cfg.privacyUrl)}` : '') + '</i>',

  waHowShare: () =>
    'Perfecto. Pulsa el botón para compartir tu número de Telegram, o escribe aquí el número que usas en WhatsApp (por ejemplo 612 345 678).',
  waInvalid: () => 'Ese número no parece válido. Escríbelo con prefijo, por ejemplo +34 612 345 678, o pulsa «Compartir mi número».',
  waNotYours: () => 'Ese contacto no es tuyo. Comparte tu propio número o escríbelo aquí.',
  waSaved: (phone, cfg) =>
    `✅ Guardado: <b>${esc(phone)}</b>. Te escribiremos por WhatsApp antes de los partidos grandes.\n\n` +
    '¿Tu WhatsApp es otro número? Escríbelo aquí y lo cambiamos.' +
    (cfg.communityUrl ? `\n\nMientras tanto, la comunidad está en ${esc(cfg.communityLabel)}.` : ''),
  waLater: () => 'Sin problema. Sigue jugando — el marcador Tú vs IA se actualiza con cada partido.',
  waCancelled: () => 'Cancelado. No guardamos ningún número.',
  optout: () => 'Hecho: hemos borrado tu número y no recibirás mensajes por WhatsApp. El juego sigue disponible aquí.',
  optoutNone: () => 'No tenemos ningún número tuyo guardado.',

  daily: (n) => `🗓️ <b>${n} partido${n === 1 ? '' : 's'}</b> abiertos para pronosticar. ¿Le ganas otra vez a la IA?`,

  top(rows, me) {
    if (!rows.length) return '🏆 <b>Top del palco esta semana</b>\n\nTodavía no hay pronósticos resueltos esta semana.';
    const medal = ['🥇', '🥈', '🥉'];
    const lines = rows.map((r, i) =>
      `${medal[i] || `${i + 1}.`} ${esc(r.first_name || (r.username ? '@' + r.username : 'Jugador'))} — ${r.wins}/${r.graded}`);
    return `🏆 <b>Top del palco esta semana</b> (aciertos / resueltos)\n\n${lines.join('\n')}` +
      (me ? `\n\nTú: #${me.rank} de ${me.of} con ${me.wins} aciertos` : '') +
      '\n\nSin premios: solo para presumir.';
  },

  me: (u, n) => `<b>${score(u)}</b>\nRacha: ${u.streak} · mejor ${u.best_streak}\nPronósticos: ${n}`,

  btn: {
    start: '▶️ Empezar',
    next: '➡️ Siguiente partido',
    slate: '🗓️ Partidos abiertos',
    top: '🏆 Top semanal',
    me: '📊 Mi marcador',
    accept: '✅ Acepto (18+)',
    later: 'Ahora no',
    share: '📱 Compartir mi número',
    cancel: 'Cancelar',
    community: (label) => `👥 ${label}`,
  },
};
