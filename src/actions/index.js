// Реестр действий. LLM видит только name/description/parameters, а реализацию «как» знает код.
import movement from './movement.js';
import gathering from './gathering.js';
import crafting from './crafting.js';
import building from './building.js';
import interaction from './interaction.js';
import agentic from './agentic.js';
import { ActionError } from './util.js';

export const ACTIONS = [...movement, ...gathering, ...crafting, ...building, ...interaction, ...agentic];
const byName = new Map(ACTIONS.map((a) => [a.name, a]));

/** Схемы инструментов в нейтральном формате для llm/router. */
export function toolSchemas() {
  return ACTIONS.map(({ name, description, parameters }) => ({ name, description, parameters }));
}

/** Действия, которые не двигают бота и могут идти параллельно с фоновыми режимами. */
const PASSIVE = new Set(['inspect_surroundings', 'find_block', 'get_recipe', 'create_plan', 'update_plan_step', 'finish_plan', 'remember', 'save_location', 'equip', 'eat', 'wait']);

export async function runAction(pal, name, args) {
  const action = byName.get(name);
  if (!action) return { ok: false, result: `Неизвестное действие ${name}` };
  if (!PASSIVE.has(name) && name !== 'stop') pal.prepareForAction(name);
  const t0 = Date.now();
  try {
    const result = await action.run(pal, args || {});
    return { ok: true, result: String(result), ms: Date.now() - t0 };
  } catch (e) {
    const msg = e instanceof ActionError ? e.message : `Ошибка: ${e.message}`;
    return { ok: false, result: msg, ms: Date.now() - t0 };
  }
}
