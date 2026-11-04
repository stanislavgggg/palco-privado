const { Markup } = require('telegraf');
const T = require('./texts');

const kb = {
  question: (m) => Markup.inlineKeyboard([
    [Markup.button.callback(String(m.home).slice(0, 30), `pick:${m.id}:home`)],
    [Markup.button.callback('Empate', `pick:${m.id}:draw`)],
    [Markup.button.callback(String(m.away).slice(0, 30), `pick:${m.id}:away`)],
  ]),

  afterPick: (hasMore) => Markup.inlineKeyboard([
    hasMore ? [Markup.button.callback(T.btn.next, 'slate')] : [Markup.button.callback(T.btn.top, 'top')],
    [Markup.button.callback(T.btn.me, 'me')],
  ]),

  graded: () => Markup.inlineKeyboard([
    [Markup.button.callback(T.btn.slate, 'slate'), Markup.button.callback(T.btn.top, 'top')],
  ]),

  slate: () => Markup.inlineKeyboard([[Markup.button.callback(T.btn.slate, 'slate')]]),

  menu: () => Markup.inlineKeyboard([
    [Markup.button.callback(T.btn.slate, 'slate')],
    [Markup.button.callback(T.btn.top, 'top'), Markup.button.callback(T.btn.me, 'me')],
  ]),

  waAsk: () => Markup.inlineKeyboard([
    [Markup.button.callback(T.btn.accept, 'wa:yes')],
    [Markup.button.callback(T.btn.later, 'wa:later')],
  ]),

  // Reply keyboard: Telegram's native "share contact" button.
  waShare: () => Markup.keyboard([
    [Markup.button.contactRequest(T.btn.share)],
    [T.btn.cancel],
  ]).oneTime().resize(),

  removeReply: () => Markup.removeKeyboard(),

  community: (cfg) => (cfg.communityUrl
    ? Markup.inlineKeyboard([[Markup.button.url(T.btn.community(cfg.communityLabel), cfg.communityUrl)],
      [Markup.button.callback(T.btn.slate, 'slate')]])
    : kb.slate()),
};

module.exports = kb;
