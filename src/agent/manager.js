// Управление несколькими Pal'ами одновременно.
import { EventEmitter } from 'node:events';
import { pals as palsDb } from '../db.js';
import { Pal } from './pal.js';

class PalManager extends EventEmitter {
  constructor() {
    super();
    this.running = new Map();
  }

  get(id) {
    id = Number(id);
    if (!this.running.has(id)) {
      const pal = new Pal(id);
      for (const ev of ['log', 'chat']) pal.on(ev, (e) => this.emit(ev, e));
      pal.on('status', () => this.emit('status', pal.state()));
      pal.on('tasks', () => this.emit('tasks', { palId: id }));
      // чтобы pal не реагировал на сообщения хозяина, явно адресованные другому pal'у
      pal.mentionsOtherPal = (msg) => palsDb.list().some((p) => p.id !== id && msg.toLowerCase().includes(p.name.toLowerCase()));
      this.running.set(id, pal);
    }
    return this.running.get(id);
  }

  states() {
    return palsDb.list().map((p) => (this.running.has(p.id) ? this.running.get(p.id).state() : { id: p.id, name: p.name, status: 'offline' }));
  }

  /** Профиль изменён в UI — подхватываем без перезапуска (имя применится при следующем подключении). */
  refresh(id) { this.running.get(Number(id))?.reloadProfile(); }

  remove(id) {
    const pal = this.running.get(Number(id));
    if (pal) { pal.disconnect(); this.running.delete(Number(id)); }
  }
}

export const manager = new PalManager();
