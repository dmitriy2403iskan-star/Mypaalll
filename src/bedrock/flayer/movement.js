// Движение Bedrock-бота без команд: физика (prismarine-physics, как в Mineflayer) + пакеты движения + A*.
import { createRequire } from 'node:module';
import vec3pkg from 'vec3';

const require = createRequire(import.meta.url);
const Vec3 = vec3pkg.Vec3 || vec3pkg;
const EYE = 1.62;
const JAVA_PHYSICS_VERSION = '1.20.4'; // данные Java-версии нужны только для форм блоков и констант физики

// ---------------------------------------------------------------- мир для физики (Bedrock-блок → Java-блок с формой)
class PhysicsWorld {
  constructor(world) {
    this.world = world;
    this.jreg = require('prismarine-registry')(JAVA_PHYSICS_VERSION);
    this.JBlock = require('prismarine-block')(this.jreg);
    this.cache = new Map();
  }

  javaBlock(kind) {
    if (!this.cache.has(kind)) this.cache.set(kind, this.jreg.blocksByName[kind].defaultState);
    return this.JBlock.fromStateId(this.cache.get(kind), 0);
  }

  getBlock(pos) {
    const b = this.world.blockAt(pos.x, pos.y, pos.z);
    let kind = 'air';
    if (!b) kind = 'stone'; // незагруженный чанк — не проваливаемся
    else if (/water/.test(b.name)) kind = 'water';
    else if (/lava/.test(b.name)) kind = 'lava';
    else if (/ladder|vine/.test(b.name)) kind = 'ladder';
    else if (/web/.test(b.name)) kind = 'cobweb';
    else if (b.solid) kind = 'stone';
    const jb = this.javaBlock(kind);
    jb.position = new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));
    return jb;
  }
}

// ---------------------------------------------------------------- пакет движения под конкретную версию
export function authInputBuilder(version) {
  const md = require('minecraft-data')(`bedrock_${version}`);
  const t = md.protocol.types;
  const fields = t.packet_player_auth_input?.[1] || [];
  const inputField = fields.find((f) => f.name === 'input_data');
  const asArray = Array.isArray(inputField?.type) && inputField.type[0] === 'array';
  const names = new Set(fields.map((f) => f.name));
  return (s) => {
    const flags = s.flags || [];
    const input_data = asArray ? flags : Object.fromEntries(flags.map((f) => [f, true]));
    const p = {
      pitch: s.pitch, yaw: s.yaw, position: s.position, move_vector: s.moveVector, head_yaw: s.yaw,
      input_data, input_mode: 'mouse', play_mode: 'normal', interaction_model: 'crosshair',
      interact_rotation: { x: s.pitch, z: s.yaw }, gaze_direction: undefined,
      tick: BigInt(s.tick), delta: s.delta,
      transaction: null, item_stack_request: null, vehicle_rotation: null, predicted_vehicle: null,
      block_action: s.blockActions?.length ? s.blockActions : (asArray ? null : undefined),
      analogue_move_vector: s.moveVector, camera_orientation: s.cameraOrientation, raw_move_vector: s.moveVector,
    };
    for (const k of Object.keys(p)) if (!names.has(k)) delete p[k];
    return p;
  };
}

// ---------------------------------------------------------------- поиск пути A*
export function findPath(world, start, goal, { range = 1, maxNodes = 4000 } = {}) {
  const solid = (x, y, z) => { const b = world.blockAt(x, y, z); return !b || b.solid; };
  // вода проходима (мелководье, реки — физика сама плывёт), лава — нет
  const free = (x, y, z) => { const b = world.blockAt(x, y, z); return b && !b.solid && !/lava|fire/.test(b.name); };
  const wet = (x, y, z) => /water/.test(world.blockAt(x, y, z)?.name || '');
  const standable = (x, y, z) => free(x, y, z) && free(x, y + 1, z) && (solid(x, y - 1, z) || wet(x, y, z) || wet(x, y - 1, z));
  const key = (x, y, z) => `${x},${y},${z}`;
  const h = (x, y, z) => Math.hypot(x - goal.x, (y - goal.y) * 1.5, z - goal.z);
  const s = { x: Math.floor(start.x), y: Math.floor(start.y), z: Math.floor(start.z) };
  const open = [{ ...s, g: 0, f: h(s.x, s.y, s.z), parent: null }];
  const seen = new Map([[key(s.x, s.y, s.z), 0]]);
  let best = open[0];
  let n = 0;
  while (open.length && n++ < maxNodes) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
    const cur = open.splice(bi, 1)[0];
    if (h(cur.x, cur.y, cur.z) < h(best.x, best.y, best.z)) best = cur;
    if (Math.hypot(cur.x - goal.x, cur.z - goal.z) <= range && Math.abs(cur.y - goal.y) <= 1.5) return rebuild(cur);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      for (const dy of [0, 1, -1, -2, -3]) {
        const x = cur.x + dx; const y = cur.y + dy; const z = cur.z + dz;
        if (!standable(x, y, z)) continue;
        if (dy === 1 && !free(cur.x, cur.y + 2, cur.z)) continue; // прыжок — нужен потолок
        if (dx && dz && (!free(cur.x + dx, cur.y, cur.z) || !free(cur.x, cur.y, cur.z + dz))) continue; // не срезаем углы
        if (dy < 0) { let ok = true; for (let k = 0; k > dy; k--) if (!free(x, cur.y + k, z) || !free(x, cur.y + k + 1, z)) ok = false; if (!ok) continue; }
        const g = cur.g + (dx && dz ? 1.414 : 1) + (dy > 0 ? 0.6 : 0) + (dy < 0 ? -dy * 0.3 : 0) + (wet(x, y, z) ? 2 : 0);
        const k = key(x, y, z);
        if (seen.has(k) && seen.get(k) <= g) continue;
        seen.set(k, g);
        open.push({ x, y, z, g, f: g + h(x, y, z), parent: cur });
        break; // одна высота на направление
      }
    }
  }
  return { path: rebuild(best).path, partial: true };

  function rebuild(node) {
    const path = [];
    for (let p = node; p; p = p.parent) path.unshift({ x: p.x, y: p.y, z: p.z });
    return { path, partial: false };
  }
}

// ---------------------------------------------------------------- контроллер движения
export class Movement {
  constructor(body, world) {
    this.body = body;
    this.world = world;
    this.client = body.client;
    const { Physics, PlayerState } = require('prismarine-physics');
    this.PlayerState = PlayerState;
    this.pworld = new PhysicsWorld(world);
    this.physics = Physics(this.pworld.jreg, this.pworld);
    this.fake = {
      version: JAVA_PHYSICS_VERSION,
      entity: { position: new Vec3(0, 0, 0), velocity: new Vec3(0, 0, 0), onGround: false, yaw: 0, pitch: 0, attributes: {}, effects: {} },
      jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
      inventory: { slots: [] },
    };
    this.controls = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
    this.tick = 0;
    this.path = [];
    this.goal = null;
    this.follow = null;
    this.handledTeleport = false;
    this.blockActions = []; // действия с блоками (ломание) — уходят в ближайшем player_auth_input
    this.build = null;
    this.timer = null;
    this.stuck = 0;
  }

  start(startGame) {
    this.build = authInputBuilder(this.body.version);
    this.tick = Number(startGame?.current_tick ?? 0);
    this.authority = startGame?.movement_authority || 'server';
    const p = this.body.entity?.position;
    if (p) this.fake.entity.position = new Vec3(p.x, p.y, p.z);
    this.client.on('move_player', (pk) => {
      if (String(pk.runtime_id) !== String(this.body.runtimeId)) return;
      this.fake.entity.position = new Vec3(pk.position.x, pk.position.y - EYE, pk.position.z);
      this.fake.entity.velocity = new Vec3(0, 0, 0);
      this.handledTeleport = true;
    });
    this.client.on('correct_player_move_prediction', (pk) => {
      this.fake.entity.position = new Vec3(pk.position.x, pk.position.y - EYE, pk.position.z);
      if (pk.delta) this.fake.entity.velocity = new Vec3(pk.delta.x, pk.delta.y, pk.delta.z);
      this.corrections = (this.corrections || 0) + 1;
    });
    // новые серверы (1.21.20+) держат игрока неподвижным, пока клиент не сообщит о конце загрузочного экрана
    try {
      const t = require('minecraft-data')(`bedrock_${this.body.version}`).protocol.types;
      if (t.packet_serverbound_loading_screen) {
        this.client.queue('serverbound_loading_screen', { type: 1 }); // начало
        setTimeout(() => { try { this.client.queue('serverbound_loading_screen', { type: 2 }); } catch { /* */ } }, 300); // конец
      }
    } catch { /* нет данных версии */ }
    this.timer = setInterval(() => this.onTick(), 50);
  }

  stop() { clearInterval(this.timer); this.timer = null; }

  get position() { return this.fake.entity.position; }

  /** Повернуться к точке (радианы в соглашении Mineflayer). */
  lookAt(target) {
    const p = this.fake.entity.position;
    const dx = target.x - p.x; const dz = target.z - p.z; const dy = target.y - (p.y + EYE);
    this.fake.entity.yaw = Math.atan2(-dx, -dz);
    this.fake.entity.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  }

  clearControls() { for (const k of Object.keys(this.controls)) this.controls[k] = false; }

  setGoal(goal) {
    this.goal = goal;
    this.path = [];
    this.repathAt = 0;
    if (!goal) this.clearControls();
  }

  /** Дойти до точки: Promise, который завершается по прибытии или с ошибкой. */
  goto(target, range = 1.5, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      this.setGoal({ ...target, range, resolve, reject, started, timeoutMs });
    });
  }

  onTick() {
    const ent = this.fake.entity;
    if (!this.world.loaded(ent.position.x, ent.position.z)) { this.send(); return; }
    this.drive();
    const state = new this.PlayerState(this.fake, this.controls);
    this.physics.simulatePlayer(state, this.pworld);
    state.apply(this.fake);
    if (this.body.entity) this.body.entity.position = { x: ent.position.x, y: ent.position.y, z: ent.position.z };
    this.send();
  }

  drive() {
    this.clearControls();
    const g = this.follow ? this.followTarget() : this.goal;
    if (!g) return;
    const pos = this.fake.entity.position;
    const dist = Math.hypot(g.x - pos.x, g.z - pos.z);
    if (dist <= (g.range ?? 1.5) && Math.abs(g.y - pos.y) < 2) {
      if (this.goal && !this.follow) { const done = this.goal; this.goal = null; done.resolve?.(); }
      this.path = [];
      return;
    }
    if (this.goal && Date.now() - this.goal.started > this.goal.timeoutMs) {
      const failed = this.goal; this.goal = null; failed.reject?.(new Error('Не успел дойти (таймаут)')); return;
    }
    // пересчёт пути раз в секунду или когда путь кончился
    if (!this.path.length || Date.now() > (this.repathAt || 0)) {
      const r = findPath(this.world, pos, g, { range: g.range ?? 1.5 });
      this.path = r.path.slice(1);
      this.repathAt = Date.now() + 1000;
      if (!this.path.length && r.partial && this.goal) {
        const failed = this.goal; this.goal = null; failed.reject?.(new Error('Пути нет')); return;
      }
    }
    let next = this.path[0];
    while (next && Math.hypot(next.x + 0.5 - pos.x, next.z + 0.5 - pos.z) < 0.35 && Math.abs(next.y - pos.y) < 1) { this.path.shift(); next = this.path[0]; }
    const aim = next ? { x: next.x + 0.5, y: next.y, z: next.z + 0.5 } : g;
    this.lookAt({ x: aim.x, y: pos.y + EYE, z: aim.z });
    this.controls.forward = true;
    this.controls.sprint = Math.hypot(aim.x - pos.x, aim.z - pos.z) > 4;
    // прыжок: ступенька, упёрлись в стену или плывём (держимся на поверхности)
    if ((next && next.y > Math.floor(pos.y)) || this.fake.entity.isCollidedHorizontally || this.fake.entity.isInWater) this.controls.jump = true;
  }

  followTarget() {
    const p = this.body.findPlayer?.(this.follow.player);
    if (!p?.position) return null;
    return { x: p.position.x, y: p.position.y, z: p.position.z, range: this.follow.distance ?? 2.5 };
  }

  send() {
    const ent = this.fake.entity;
    this.tick++;
    const yawDeg = ((Math.PI - ent.yaw) * 180 / Math.PI + 360) % 360;
    const yaw = yawDeg > 180 ? yawDeg - 360 : yawDeg;
    const pitch = -ent.pitch * 180 / Math.PI;
    const c = this.controls;
    const moveVector = { x: (c.left ? 1 : 0) - (c.right ? 1 : 0), z: (c.forward ? 1 : 0) - (c.back ? 1 : 0) };
    const flags = [];
    if (c.forward) flags.push('up');
    if (c.back) flags.push('down');
    if (c.left) flags.push('left');
    if (c.right) flags.push('right');
    if (c.jump) flags.push('jump_down', 'jumping', 'want_up', 'start_jumping');
    if (c.sprint) flags.push('sprinting', 'sprint_down');
    if (this.handledTeleport) { flags.push('handled_teleport'); this.handledTeleport = false; }
    const blockActions = this.blockActions.splice(0);
    if (blockActions.length) flags.push('block_action');
    const position = { x: ent.position.x, y: ent.position.y + EYE, z: ent.position.z };
    try {
      if (this.authority === 'client') {
        this.client.queue('move_player', {
          runtime_id: this.body.runtimeId, position, pitch, yaw, head_yaw: yaw, mode: 'normal', on_ground: ent.onGround,
          ridden_runtime_id: 0, tick: BigInt(this.tick),
        });
      } else {
        const rad = (yawDeg * Math.PI) / 180;
        this.client.queue('player_auth_input', this.build({
          pitch, yaw, position, moveVector, flags, tick: this.tick, blockActions,
          delta: { x: ent.velocity.x, y: ent.velocity.y, z: ent.velocity.z },
          cameraOrientation: { x: -Math.sin(rad), y: 0, z: Math.cos(rad) },
        }));
      }
    } catch (e) {
      if (!this.sendError) { this.sendError = e.message; this.body.emit('error', new Error(`движение: ${e.message}`)); }
    }
  }
}
