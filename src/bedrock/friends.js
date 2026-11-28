// Вход в мир друга через Xbox (как вкладка «Друзья» в самой игре): адрес и порт не нужны.
// Условия: у бота свой аккаунт Microsoft, он в друзьях у хозяина мира, мир открыт для друзей.

const info = (s) => s?.customProperties || {};
const label = (s) => `${info(s).hostName || '?'} — «${info(s).worldName || '?'}» (${info(s).version || '?'})`;

/** Выбрать мир из списка миров друзей. friend — геймертег хозяина (можно пусто, если открыт один мир). */
export function pickFriendWorld(sessions, friend) {
  const norm = (v) => String(v ?? '').trim().toLowerCase();
  const wanted = norm(friend);
  const list = sessions || [];
  const found = wanted ? list.filter((s) => norm(info(s).hostName) === wanted) : list;
  if (found.length === 1) return found[0];
  const all = list.map(label).join('; ') || 'ни одного';
  if (!found.length) throw new Error(`Не нашёл мир друга «${friend}». Открытые миры друзей: ${all}`);
  throw new Error(`Найдено несколько миров. Укажи в настройках «Ник друга (хозяина мира)» точно, как в Xbox. Открытые миры: ${all}`);
}
