// Туториал «Как запустить pal'а в игре»: отдельные гайды для Java и Bedrock.
// Подставляет актуальные значения (имя бота, адрес) и умеет сам выставить настройки.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Внутри APK (Android WebView) — показываем шаги для телефона
export const IN_APK = /; wv\)/.test(navigator.userAgent) || /Android/.test(navigator.userAgent);

const code = (c) => `<span class="cmd"><code>${esc(c)}</code><button type="button" class="copy" data-copy="${esc(c)}" title="Скопировать">⧉</button></span>`;

function steps(list) {
  return `<ol class="tsteps">${list.filter(Boolean).map((s) => `<li>${s}</li>`).join('')}</ol>`;
}

function javaGuide(ctx) {
  const { pal, versions: v } = ctx;
  return `
  <div class="card tutor-card">
    <h3>☕ Minecraft Java Edition</h3>
    <p class="ver">✅ Поддерживаемые версии: <b>Java ${esc(v.java.min)} – ${esc(v.java.max)}</b></p>
    <p class="hint">Java — это версия для ПК из официального лаунчера. На телефонах Java нет: из APK можно подключить pal'а только к Java-серверу или к ПК в той же сети.</p>
    ${IN_APK ? '<p class="note">📱 Ты в приложении на телефоне. Если сам играешь на телефоне — тебе нужен гайд <b>Bedrock</b> (вкладка выше).</p>' : ''}

    <h4>1. Ключ нейросети</h4>
    ${steps([
    'Открой <b>Настройки → Нейросеть</b>.',
    'Вставь API-ключ у нужного провайдера (OpenAI, Claude, Gemini, OpenRouter…) и нажми <b>Проверить</b>. Без ключа можно взять бесплатную локальную Ollama.',
    'Выбери этот провайдер в поле <b>Активный провайдер</b> и нажми <b>Сохранить настройки</b>.',
  ])}

    <h4>2. Открой мир для бота</h4>
    <p><b>Вариант А — одиночный мир</b> (самый простой):</p>
    ${steps([
    'Запусти Minecraft Java и зайди в свой мир.',
    'Нажми <b>Esc → Открыть для сети</b> (Open to LAN). По желанию включи «Разрешить читы».',
    'Нажми <b>Открыть мир для сети</b> — в чате появится «Локальный сервер запущен на порту <b>XXXXX</b>». Запомни этот порт: <b>он меняется при каждом открытии</b>.',
  ])}
    <p><b>Вариант Б — свой сервер</b> (Paper/Vanilla):</p>
    ${steps([
    `В <code>server.properties</code> поставь ${code('online-mode=false')}, чтобы бот зашёл без лицензии. Либо оставь <code>true</code>, выбери в MyPal «Авторизация: microsoft» и дай боту отдельный аккаунт.`,
    'Если включён whitelist — добавь бота: ' + code(`/whitelist add ${pal}`),
    'Хочешь играть вместе с друзьями с телефонов? Поставь на сервер плагины <b>Geyser + Floodgate</b>: Bedrock-игроки зайдут на Java-сервер, а pal будет работать в полном режиме.',
  ])}

    <h4>3. Настрой MyPal</h4>
    ${steps([
    'Нажми кнопку ниже или в <b>Настройках → Minecraft</b> выбери <b>Издание: Java</b>.',
    `<b>Хост</b>: <code>localhost</code>, если MyPal запущен на том же ПК, что и игра. Иначе — IP компьютера с игрой (например <code>192.168.1.5</code>). ${IN_APK ? 'С телефона <code>localhost</code> не подойдёт — нужен IP ПК в той же Wi-Fi сети.' : ''}`,
    '<b>Порт</b>: число из чата (вариант А) или порт сервера (обычно <code>25565</code>). <b>Версия</b>: оставь пустой — определится сама.',
    'Во вкладке <b>Pals</b> впиши свой ник в поле <b>Хозяин</b> — тогда pal будет отвечать на все твои сообщения, а не только когда к нему обращаются по имени.',
  ])}
    <div class="row">
      <label>Порт из чата/сервера <input id="tjPort" type="number" placeholder="например 54321" value="${esc(ctx.javaPort)}"></label>
      <label>Хост <input id="tjHost" value="${esc(ctx.javaHost)}"></label>
      <button type="button" data-apply="java">Настроить Java автоматически</button>
    </div>

    <h4>4. Запусти pal'а</h4>
    ${steps([
    `На вкладке <b>Дашборд</b> нажми <b>Подключить</b> у ${esc(pal)}. Через пару секунд он появится в мире и поздоровается.`,
    `Напиши в игровой чат: ${code(`${pal}, иди ко мне`)}`,
    `Ещё примеры: ${code(`${pal}, следуй за мной`)} ${code(`${pal}, нарубь 10 брёвен`)} ${code(`${pal}, построй дом с подвалом`)} ${code(`${pal}, запомни, это наш дом`)} ${code('стоп')}`,
  ])}

    <h4>Выживание или креатив</h4>
    <p>Бот сам замечает свой режим (<code>/gamemode</code>) и ведёт себя по-разному. В <b>выживании</b> он добывает и крафтит сам, перед стройкой собирает материалы, ест и защищается. В <b>креативе</b> берёт любые блоки из инвентаря креатива и строит сразу, без добычи. Переключить: ${code(`/gamemode creative ${pal}`)} ${code(`/gamemode survival ${pal}`)}</p>

    <h4>Не работает?</h4>
    <ul class="tfaq">
      <li><b>«Outdated server/client», «unsupported protocol»</b> — MyPal поддерживает Java ${esc(v.java.min)} – ${esc(v.java.max)}. Проверь версию мира (видна в лаунчере) и при необходимости укажи её в Настройках → Minecraft → Версия.</li>
      <li><b>«Connection refused» / ECONNREFUSED</b> — неверный порт или мир не открыт для сети. Открой мир заново и возьми новый порт.</li>
      <li><b>Кикает «You are not white-listed» / «Failed to verify username»</b> — добавь бота в whitelist или поставь <code>online-mode=false</code>.</li>
      <li><b>Не отвечает в чате</b> — обратись по имени (<code>${esc(pal)}, …</code>) или впиши свой ник в «Хозяин». Проверь ключ в Настройках (кнопка «Проверить»).</li>
      <li><b>Pal подключён с другого устройства</b> — разреши Java в брандмауэре Windows для частной сети.</li>
    </ul>
  </div>`;
}

function bedrockGuide(ctx) {
  const { pal, versions: v } = ctx;
  const sameDevice = IN_APK ? 'на этом же телефоне' : 'на этом же устройстве';
  return `
  <div class="card tutor-card">
    <h3>📱 Minecraft Bedrock (телефон, Windows, консоли)</h3>
    <p class="ver">✅ Поддерживаемые версии: <b>Bedrock ${esc(v.bedrock.min)} – ${esc(v.bedrock.max)}</b> (у Bedrock нет версии «1.16.5» — самая ранняя 1.16 это ${esc(v.bedrock.min)})</p>
    <p class="hint">В Bedrock pal действует командами (/tp, /fill, /setblock, /give): ходит за тобой, охраняет, строит дома, выдаёт предметы, выполняет команды. Копать и крафтить руками в Bedrock он не умеет. Нужен полный режим — используй Java-сервер с Geyser (см. гайд Java).</p>

    <h4>1. Ключ нейросети</h4>
    ${steps([
    'Открой <b>Настройки → Нейросеть</b>, вставь API-ключ и нажми <b>Проверить</b>.',
    'Выбери провайдера в поле <b>Активный провайдер</b> → <b>Сохранить настройки</b>.',
  ])}

    <h4>2. Аккаунт для бота</h4>
    ${steps([
    'Боту нужен <b>свой</b> бесплатный аккаунт Microsoft/Xbox: под твоим аккаунтом бот не зайдёт, ведь ты уже в игре. Заведи новый на <b>account.microsoft.com</b> — пары минут хватит.',
    'Зайди этим аккаунтом один раз на <b>xbox.com</b> и придумай тег игрока: так ник бота в игре будет нормальным.',
    'Если мир не пускает бота — <b>добавь его аккаунт в друзья</b> в Minecraft (Играть → Друзья → Добавить друга) и поставь в мире «Мультиплеер: Друзья».',
  ])}

    <h4>3. Подготовь мир</h4>
    ${steps([
    'В Minecraft: <b>Играть → карандаш ✏ у мира</b> (Изменить).',
    '<b>Игра → Читы: ВКЛ</b>. Без читов pal не сможет выполнять команды.',
    '<b>Мультиплеер → Многопользовательская игра: ВКЛ</b> и <b>Видно игрокам в LAN: ВКЛ</b>.',
    'Зайди в мир.' + (IN_APK ? ' Телефон должен быть подключён к <b>Wi-Fi</b>: без Wi-Fi Bedrock выключает LAN-игру, даже для бота на этом же телефоне.' : ''),
  ])}

    <h4>4. Настрой MyPal</h4>
    ${steps([
    `Нажми кнопку ниже: она выставит Bedrock, хост <code>127.0.0.1</code> (игра ${sameDevice}), порт <code>19132</code> и вход Microsoft.`,
    'Если мир открыт на <b>другом</b> устройстве — впиши его IP вместо <code>127.0.0.1</code> (в той же Wi-Fi сети).',
    'Играешь на <b>Realm</b>? Впиши имя Realm в Настройках и пригласи в Realm аккаунт бота.',
    'Во вкладке <b>Pals</b> впиши свой ник (тег Xbox) в поле <b>Хозяин</b>.',
  ])}
    <div class="row">
      <label>IP устройства с игрой <input id="tbHost" value="${esc(ctx.bedrockHost)}"></label>
      <label>Порт <input id="tbPort" type="number" value="${esc(ctx.bedrockPort)}"></label>
      <button type="button" data-apply="bedrock">Настроить Bedrock автоматически</button>
    </div>

    <h4>5. Первый вход бота (один раз)</h4>
    ${steps([
    `На <b>Дашборде</b> нажми <b>Подключить</b> у ${esc(pal)}.`,
    'Сверху появится баннер 🔑 с кодом. Открой ссылку <b>microsoft.com/link</b>, войди <b>аккаунтом бота</b> (не своим!) и введи код. Дальше бот будет входить сам.',
    IN_APK ? 'Переключись в Minecraft — MyPal продолжит работать в фоне (значок в шторке). <b>Не смахивай его из недавних приложений.</b>' : '',
  ])}

    <h4>6. Дай боту права оператора</h4>
    ${steps([
    `Когда бот появится в мире: <b>меню паузы → значок игроков → ${esc(pal)} → Оператор</b>.`,
    `Или командой в чате: ${code(`/op "${pal}"`)}`,
    'Без оператора бот будет отвечать, но не сможет ходить к тебе и строить.',
  ])}

    <h4>Выживание или креатив</h4>
    <p>Бот определяет свой режим. В <b>креативе</b> смело строит и выдаёт предметы командами. В <b>выживании</b> не раздаёт бесплатные вещи без твоей просьбы. Переключить: ${code(`/gamemode creative "${pal}"`)} ${code(`/gamemode survival "${pal}"`)}</p>

    <h4>7. Играй</h4>
    ${steps([
    `${code(`${pal}, иди ко мне`)} ${code(`${pal}, следуй за мной`)} ${code(`${pal}, охраняй меня`)}`,
    `${code(`${pal}, построй двухэтажный дом с подвалом`)} ${code(`${pal}, сделай день`)} ${code(`${pal}, дай мне 16 факелов`)} ${code('стоп')}`,
  ])}

    <h4>Не работает?</h4>
    <ul class="tfaq">
      <li><b>Висит «Подключаюсь…»</b> — проверь, что в мире включена «Многопользовательская игра» и «Видно в LAN», телефон в Wi-Fi, порт <code>19132</code>.</li>
      <li><b>Отключается сразу после входа</b> — добавь аккаунт бота в друзья (шаг 2). Если при входе по коду ты случайно вошёл <b>своим</b> аккаунтом — смени имя pal'а во вкладке Pals: бот попросит новый код, и войди уже аккаунтом бота.</li>
      <li><b>«Команды не сработали»</b> — нет читов в мире или у бота нет оператора (шаг 6).</li>
      <li><b>Разные версии / «Outdated client/server»</b> — MyPal поддерживает Bedrock ${esc(v.bedrock.min)} – ${esc(v.bedrock.max)}. Если игра новее — скачай свежий APK/обнови MyPal; если старее ${esc(v.bedrock.min)} — обнови игру.</li>
      ${IN_APK ? '<li><b>Бот пропадает, когда ты в игре</b> — Настройки телефона → Приложения → MyPal → Батарея → <b>Без ограничений</b> (на Xiaomi ещё включи «Автозапуск»).</li>' : ''}
      <li><b>Лимит нейросети закончился</b> — pal напишет об этом в чат и выйдет. Смени ключ в Настройках и снова нажми «Подключить».</li>
    </ul>
  </div>`;
}

export function renderTutor(root, { settings, pals, versions, apiPut, onApplied }) {
  const s = settings || { minecraft: { bedrock: {} } };
  const pal = pals?.[0]?.name || 'Alex';
  let edition = root.dataset.edition || s.minecraft?.edition || (IN_APK ? 'bedrock' : 'java');
  const ctx = {
    pal,
    versions: versions || { java: { min: '1.16.5', max: '?' }, bedrock: { min: '1.16.201', max: '?' } },
    javaHost: s.minecraft?.host || 'localhost',
    javaPort: s.minecraft?.port || '',
    bedrockHost: s.minecraft?.bedrock?.host || '127.0.0.1',
    bedrockPort: s.minecraft?.bedrock?.port || 19132,
  };

  const draw = () => {
    root.dataset.edition = edition;
    root.innerHTML = `
      <div class="tutor-head">
        <h2>Как запустить pal'а в игре</h2>
        <p class="ver">✅ Поддерживаемые версии Minecraft: <b>Java ${esc(ctx.versions.java.min)} – ${esc(ctx.versions.java.max)}</b> · <b>Bedrock ${esc(ctx.versions.bedrock.min)} – ${esc(ctx.versions.bedrock.max)}</b></p>
        <p class="hint">Выбери, в какой Minecraft играешь. <b>Java</b> — ПК, официальный лаунчер. <b>Bedrock</b> — телефон, планшет, Windows (Microsoft Store), Xbox, PlayStation, Switch.</p>
        <div class="seg">
          <button type="button" data-ed="java" class="${edition === 'java' ? 'on' : ''}">☕ Java</button>
          <button type="button" data-ed="bedrock" class="${edition === 'bedrock' ? 'on' : ''}">📱 Bedrock</button>
        </div>
      </div>
      ${edition === 'java' ? javaGuide(ctx) : bedrockGuide(ctx)}
      <p class="hint" id="tutorMsg"></p>`;
  };

  root.onclick = async (e) => {
    const ed = e.target.closest('[data-ed]')?.dataset.ed;
    if (ed) { edition = ed; draw(); return; }
    const copy = e.target.closest('[data-copy]')?.dataset.copy;
    if (copy) {
      try { await navigator.clipboard.writeText(copy); e.target.textContent = '✓'; } catch { prompt('Скопируй команду:', copy); }
      setTimeout(() => { e.target.textContent = '⧉'; }, 1200);
      return;
    }
    const apply = e.target.closest('[data-apply]')?.dataset.apply;
    if (!apply) return;
    const patch = apply === 'java'
      ? { minecraft: { edition: 'java', host: root.querySelector('#tjHost').value.trim() || 'localhost', port: Number(root.querySelector('#tjPort').value) || 25565 } }
      : { minecraft: { edition: 'bedrock', bedrock: { host: root.querySelector('#tbHost').value.trim() || '127.0.0.1', port: Number(root.querySelector('#tbPort').value) || 19132, auth: 'microsoft' } } };
    try {
      await apiPut(patch);
      root.querySelector('#tutorMsg').textContent = `✓ Настроено: ${apply === 'java' ? `Java ${patch.minecraft.host}:${patch.minecraft.port}` : `Bedrock ${patch.minecraft.bedrock.host}:${patch.minecraft.bedrock.port}, вход Microsoft`}. Теперь нажми «Подключить» на дашборде.`;
      Object.assign(ctx, apply === 'java' ? { javaHost: patch.minecraft.host, javaPort: patch.minecraft.port } : { bedrockHost: patch.minecraft.bedrock.host, bedrockPort: patch.minecraft.bedrock.port });
      onApplied?.();
    } catch (err) {
      root.querySelector('#tutorMsg').textContent = `Ошибка: ${err.message}`;
    }
  };
  draw();
}
