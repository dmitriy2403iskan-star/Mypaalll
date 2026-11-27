// Reflex Engine — быстрый цикл без LLM: еда, защита, бегство, не утонуть.
// Работает параллельно «медленному» мозгу и не ждёт ответа нейросети.
import pathfinderPkg from 'mineflayer-pathfinder';
import { settings } from '../config.js';
import { isHostile } from '../minecraft/world.js';
import { eatBest } from '../actions/interaction.js';
import { findPlayer } from '../actions/util.js';
import { modeProfile } from '../agent/modes.js';

const { goals } = pathfinderPkg;

export class ReflexEngine {
  constructor(pal) {
    this.pal = pal;
    this.bot = pal.bot;
    this.eating = false;
    this.fighting = null;
    this.fleeingUntil = 0;
    this.lastHurt = 0;
    this.timer = setInterval(() => this.tick().catch((e) => pal.log('reflex', `ошибка: ${e.message}`)), 400);
    this.bot.on('entityHurt', (e) => { if (e === this.bot.entity) this.lastHurt = Date.now(); });
    this.bot.on('stoppedAttacking', () => { this.fighting = null; this.pal.resumeMode(); });
  }

  destroy() { clearInterval(this.timer); }

  cfg() { return settings.get().reflex; }

  nearestHostile(from, radius) {
    let best = null; let bestD = radius;
    for (const e of Object.values(this.bot.entities)) {
      if (!isHostile(e) || !e.position) continue;
      const d = e.position.distanceTo(from);
      if (d < bestD) { best = e; bestD = d; }
    }
    return best;
  }

  async tick() {
    const { bot } = this;
    if (!bot.entity || bot.health === undefined) return;
    const cfg = this.cfg();
    const me = bot.entity.position;
    // в креативе/наблюдателе нет урона и голода: есть и убегать не нужно, драться — только в режиме охраны
    const mp = modeProfile(bot.game?.gameMode).reflex;
    const guarding = this.pal.mode?.type === 'guard';

    // 1. Не утонуть
    if (cfg.avoidDrowning && bot.oxygenLevel !== undefined && bot.oxygenLevel < 12 && bot.entity.isInWater) {
      bot.setControlState('jump', true);
      setTimeout(() => bot.setControlState('jump', false), 600);
    }

    // 2. Бегство: мало здоровья или рядом крипер
    if (Date.now() < this.fleeingUntil) return;
    if (!mp.flee && !mp.defend && !mp.eat && !guarding) return;
    const hostile = this.nearestHostile(me, 16);
    const creeperClose = hostile?.name === 'creeper' && hostile.position.distanceTo(me) < 5;
    if (mp.flee && hostile && (creeperClose || (bot.health <= cfg.fleeHealth && hostile.position.distanceTo(me) < 10))) {
      this.pal.log('reflex', creeperClose ? 'Крипер рядом — отбегаю!' : `Мало здоровья (${Math.round(bot.health)}) — отступаю`);
      bot.pvp.stop();
      this.fighting = null;
      bot.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalFollow(hostile, 14)), true);
      this.fleeingUntil = Date.now() + 4000;
      setTimeout(() => { if (Date.now() >= this.fleeingUntil) this.pal.resumeMode(); }, 4100);
      return;
    }

    // 3. Самооборона / охрана
    if (cfg.selfDefense && !this.fighting && (mp.defend || guarding) && bot.game?.gameMode !== 'spectator') {
      const mode = this.pal.mode;
      const guardTarget = mode?.type === 'guard' ? findPlayer(bot, mode.player) : null;
      const center = guardTarget?.position || me;
      const radius = guardTarget ? 10 : (Date.now() - this.lastHurt < 3000 ? 8 : 4);
      const enemy = this.nearestHostile(center, radius);
      // атакуем, если: охрана, нас недавно ударили, или моб совсем рядом и мы не заняты важным
      if (enemy && enemy.name !== 'creeper' && (guardTarget || Date.now() - this.lastHurt < 3000 || !this.pal.busy)) {
        this.fighting = enemy;
        this.pal.log('reflex', `Атакую ${enemy.name}`);
        const weapon = bot.inventory.items().find((i) => i.name.endsWith('_sword')) || bot.inventory.items().find((i) => i.name.endsWith('_axe'));
        if (weapon) await bot.equip(weapon, 'hand').catch(() => {});
        bot.pvp.attack(enemy);
        return;
      }
    }

    // 4. Еда
    if (mp.eat && cfg.autoEat && !this.eating && !this.fighting && bot.food <= 14) {
      this.eating = true;
      try {
        const ate = await eatBest(bot);
        if (ate) this.pal.log('reflex', `Поел: ${ate}`);
      } catch { /* нет еды или помешали */ } finally {
        this.eating = false;
      }
    }
  }
}
