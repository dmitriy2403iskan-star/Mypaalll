// Рефлексы Bedrock-бота — как ReflexEngine в Java: еда, самооборона, охрана игрока, бегство от крипера.
import { settings } from '../config.js';
import { modeProfile } from '../agent/modes.js';
import { isHostileType } from './flayer/entities.js';
import { fight, eatBest } from './handsActions.js';

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

export class BedrockReflex {
  constructor(pal) {
    this.pal = pal;
    this.body = pal.bot;
    this.lastHurt = 0;
    this.busy = false;
    this.onHurt = () => { this.lastHurt = Date.now(); };
    this.body.on('hurt', this.onHurt);
    this.timer = setInterval(() => this.tick().catch((e) => pal.log('reflex', `ошибка: ${e.message}`)), 500);
  }

  destroy() { clearInterval(this.timer); this.body.off('hurt', this.onHurt); }

  async tick() {
    const { body, pal } = this;
    if (this.busy || body.ended || !body.nativeReady || !body.movement || !body.hands) return;
    const cfg = settings.get().reflex || {};
    const mp = modeProfile(body.gameMode).reflex;
    const guarding = pal.mode?.type === 'guard';
    if (!mp.flee && !mp.defend && !mp.eat && !guarding) return;
    const me = body.movement.position;
    const hostile = (from, r) => body.entities.nearest(from, (e) => isHostileType(e.type), r);
    this.busy = true;
    try {
      // 1. Крипер рядом или мало здоровья — отбежать
      const near = hostile(me, 10);
      const creeper = near?.type === 'creeper' && dist(near.position, me) < 5;
      if (mp.flee && near && (creeper || (body.health <= (cfg.fleeHealth ?? 6) && dist(near.position, me) < 8))) {
        pal.log('reflex', creeper ? 'Крипер рядом — отбегаю!' : `Мало здоровья (${Math.round(body.health)}) — отступаю`);
        const dx = me.x - near.position.x; const dz = me.z - near.position.z; const l = Math.hypot(dx, dz) || 1;
        await body.goto({ x: me.x + (dx / l) * 10, y: me.y, z: me.z + (dz / l) * 10 }, 2, 4000).catch(() => {});
        return;
      }
      // 2. Самооборона и охрана
      if (cfg.selfDefense !== false && (mp.defend || guarding)) {
        const target = guarding ? body.findPlayer(pal.mode.player)?.position : null;
        const center = target || me;
        const radius = target ? 10 : (Date.now() - this.lastHurt < 3000 ? 8 : 4);
        const enemy = hostile(center, radius);
        if (enemy && enemy.type !== 'creeper' && (target || Date.now() - this.lastHurt < 3000 || !pal.busy)) {
          pal.log('reflex', `Атакую ${enemy.type}`);
          await fight(pal, enemy, { timeoutMs: 15000 });
          return;
        }
      }
      // 3. Еда
      if (mp.eat && cfg.autoEat !== false && body.food <= 14) {
        const ate = await eatBest(pal);
        if (ate) pal.log('reflex', `Поел: ${ate}`);
      }
    } finally {
      this.busy = false;
    }
  }
}
