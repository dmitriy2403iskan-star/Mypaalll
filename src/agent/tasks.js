// Task Manager: у каждой задачи есть цель, шаги и статус.
// PENDING → RUNNING → (PAUSED) → COMPLETED | FAILED | CANCELLED
import { db, safeJson } from '../db.js';

export const STATUS = ['PENDING', 'RUNNING', 'PAUSED', 'FAILED', 'COMPLETED', 'CANCELLED'];

export class TaskManager {
  constructor(palId, onChange = () => {}) {
    this.palId = palId;
    this.onChange = onChange;
  }

  create(goal, steps = []) {
    // одновременно активна одна большая задача — старую ставим на паузу
    db.prepare("UPDATE tasks SET status='PAUSED', updated_at=datetime('now') WHERE pal_id=? AND status='RUNNING'").run(this.palId);
    const normalized = steps.map((s) => ({ name: typeof s === 'string' ? s : s.name, status: 'PENDING', note: '' }));
    if (normalized[0]) normalized[0].status = 'RUNNING';
    const id = db.prepare("INSERT INTO tasks (pal_id, goal, status, steps) VALUES (?,?,'RUNNING',?)")
      .run(this.palId, goal, JSON.stringify(normalized)).lastInsertRowid;
    this.onChange();
    return this.get(id);
  }

  get(id) {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ? AND pal_id = ?').get(id, this.palId);
    return row ? { ...row, steps: safeJson(row.steps, []) } : null;
  }

  current() {
    const row = db.prepare("SELECT * FROM tasks WHERE pal_id = ? AND status = 'RUNNING' ORDER BY id DESC LIMIT 1").get(this.palId);
    return row ? { ...row, steps: safeJson(row.steps, []) } : null;
  }

  list(limit = 50) {
    return db.prepare('SELECT * FROM tasks WHERE pal_id = ? ORDER BY id DESC LIMIT ?').all(this.palId, limit)
      .map((r) => ({ ...r, steps: safeJson(r.steps, []) }));
  }

  updateStep(taskId, stepIndex, status, note = '') {
    const t = this.get(taskId);
    if (!t) throw new Error(`Задача ${taskId} не найдена`);
    const step = t.steps[stepIndex];
    if (!step) throw new Error(`Шаг ${stepIndex} не найден`);
    step.status = status;
    if (note) step.note = note;
    // следующий PENDING-шаг становится RUNNING
    if (status === 'COMPLETED') {
      const next = t.steps.find((s) => s.status === 'PENDING');
      if (next) next.status = 'RUNNING';
    }
    let taskStatus = t.status;
    if (t.steps.every((s) => s.status === 'COMPLETED')) taskStatus = 'COMPLETED';
    if (status === 'FAILED') taskStatus = 'FAILED';
    this.save(t.id, taskStatus, t.steps);
    return this.get(t.id);
  }

  setStatus(taskId, status) {
    if (!STATUS.includes(status)) throw new Error(`Неверный статус ${status}`);
    const t = this.get(taskId);
    if (!t) throw new Error(`Задача ${taskId} не найдена`);
    if (status === 'RUNNING') {
      db.prepare("UPDATE tasks SET status='PAUSED' WHERE pal_id=? AND status='RUNNING' AND id<>?").run(this.palId, taskId);
    }
    this.save(t.id, status, t.steps);
    return this.get(t.id);
  }

  save(id, status, steps) {
    db.prepare("UPDATE tasks SET status=?, steps=?, updated_at=datetime('now') WHERE id=?").run(status, JSON.stringify(steps), id);
    this.onChange();
  }

  /** Короткое описание для контекста LLM. */
  summary() {
    const t = this.current();
    if (!t) return null;
    return {
      id: t.id,
      goal: t.goal,
      steps: t.steps.map((s, i) => `${i}. [${s.status}] ${s.name}${s.note ? ` — ${s.note}` : ''}`),
    };
  }
}
