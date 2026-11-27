// Реестр действий. LLM видит только name/description/parameters, а реализацию «как» знает код.
import movement from './movement.js';
import gathering from './gathering.js';
import crafting from './crafting.js';
import building from './building.js';
import interaction from './interaction.js';
import agentic from './agentic.js';
import bedrock from '../bedrock/actions.js';
import { ActionError } from './util.js';
import { actionAllowed, blockedReason } from '../agent/modes.js';

export const ACTIONS = [...movement, ...gathering, ...crafting, ...building, ...interaction, ...agentic];
// Bedrock: свои действия через команды + общие «мыслительные» (память, планы, рецепты)
const SHARED = new Set(['get_recipe', 'plan_crafting', 'list_variants', 'create_plan', 'update_plan_step', 'finish_plan', 'remember', 'wait']);
export const BEDROCK_ACTIONS = [...bedrock, ...agentic.filter((a) => SHARED.has(a.name))];

const javaByName = new Map(ACTIONS.map((a) => [a.name, a]));
const bedrockByName = new Map(BEDROCK_ACTIONS.map((a) => [a.name, a]));

export const actionsFor = (pal) => (pal?.edition === 'bedrock' ? BEDROCK_ACTIONS : ACTIONS);

/** Схемы инструментов в нейтральном формате для llm/router. */
export function toolSchemas(pal) {
  // нейросеть видит только то, что можно делать в текущем игровом режиме
  return actionsFor(pal)
    .filter((a) => !pal || actionAllowed(a.name, pal.gameMode, pal.edition))
    .map(({ name, description, parameters }) => ({ name, description, parameters }));
}

/** Действия, которые не двигают бота и могут идти параллельно с фоновыми режимами. */
const PASSIVE = new Set(['inspect_surroundings', 'find_block', 'get_recipe', 'create_plan', 'update_plan_step', 'finish_plan', 'remember', 'save_location', 'equip', 'eat', 'wait']);

export async function runAction(pal, name, args) {
  const action = (pal?.edition === 'bedrock' ? bedrockByName : javaByName).get(name);
  if (!action) return { ok: false, result: `Неизвестное действие ${name}` };
  if (pal?.bot && !actionAllowed(name, pal.gameMode, pal.edition)) return { ok: false, result: blockedReason(name, pal.gameMode) };
  if (pal.edition !== 'bedrock' && !PASSIVE.has(name) && name !== 'stop') pal.prepareForAction(name);
  const t0 = Date.now();
  try {
    const result = await action.run(pal, args || {});
    return { ok: true, result: String(result), ms: Date.now() - t0 };
  } catch (e) {
    const msg = e instanceof ActionError ? e.message : `Ошибка: ${e.message}`;
    return { ok: false, result: msg, ms: Date.now() - t0 };
  }
}
