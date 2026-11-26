// E2E для Bedrock: тестовый сервер на bedrock-protocol ↔ BedrockBody (чистый JS RakNet).
// Проверяет: подключение, чат в обе стороны, команды и ответы на них. Запуск: node test/bedrock-e2e.mjs [версия]
import { loadBedrockProtocol } from '../src/bedrock/protocol.js';
import { BedrockBody } from '../src/bedrock/body.js';

const version = process.argv[2] || undefined;
const bp = loadBedrockProtocol();
const port = 19200 + Math.floor(Math.random() * 500);
const server = bp.createServer({ host: '127.0.0.1', port, offline: true, ...(version ? { version } : {}) });
const results = {};
const done = (code) => { console.log(JSON.stringify(results, null, 1)); process.exit(code); };
setTimeout(() => { results.timeout = true; done(1); }, 30000);

server.on('connect', (client) => {
  client.on('join', () => {
    results.serverJoin = client.getUserData?.().displayName || true;
    setTimeout(() => client.write('text', {
      needs_translation: false, category: 'authored', type: 'chat', source_name: 'Steve', message: 'Alex, привет!',
      xuid: '', platform_chat_id: '', has_filtered_message: false, filtered_message: '',
    }), 300);
  });
  client.on('packet', (pk) => {
    const { name, params } = pk.data;
    if (name === 'text') results.botSaid = params.message;
    if (name === 'command_request') {
      results.command = params.command;
      results.commandVersion = params.version;
      client.write('command_output', {
        origin: params.origin, output_type: 'all', success_count: 1,
        output: [{ message_id: 'commands.tp.success', success: true, parameters: ['Alex', '1', '2', '3'] }],
        has_data: false, data_set: '',
      });
    }
  });
});

const body = new BedrockBody({ username: 'Alex', host: '127.0.0.1', port, auth: 'offline', version });
body.on('error', (e) => { results.error = e.message; });
body.on('chat', async (from, msg) => {
  results.botHeard = `${from}: ${msg}`;
  body.chat('Привет, Steve!');
  const r = await body.command('tp @s 1 2 3');
  results.commandResult = r;
  setTimeout(() => done(results.botSaid && r.success && r.output.includes('commands.tp.success') ? 0 : 1), 500);
});
