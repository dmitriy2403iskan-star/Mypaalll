// Проверка урезанной копии для APK: «тело» Bedrock-бота должно создаваться на этих данных.
// Запуск из папки урезанной копии: node ../../scripts/check-mobile-body.mjs
import path from 'node:path';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const require = createRequire(path.join(root, 'package.json'));
const load = (f) => import(pathToFileURL(path.join(root, f)).href);
const { CURRENT_VERSION } = require('bedrock-protocol/src/options.js');
const { BedrockWorld } = await load('src/bedrock/flayer/world.js');
const { Movement, authInputBuilder } = await load('src/bedrock/flayer/movement.js');

const client = { on() {}, queue() {} };
const world = new BedrockWorld(client, CURRENT_VERSION);
assert.ok(world.registry.blockStates.length > 1000, 'список состояний блоков пуст');
for (const name of ['stone', 'dirt', 'sand']) assert.ok(world.registry.blocksByName[name], `нет блока ${name}`);
new Movement({ client }, world);
authInputBuilder(CURRENT_VERSION);
console.log(`Тело Bedrock ${CURRENT_VERSION}: данные на месте, состояний блоков ${world.registry.blockStates.length}`);
