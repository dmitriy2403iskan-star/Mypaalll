// Создание Mineflayer-бота с плагинами. Бот заходит на сервер как обычный игрок — мод на сервер не нужен.
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import collectBlockPkg from 'mineflayer-collectblock';
import pvpPkg from 'mineflayer-pvp';

const { pathfinder, Movements } = pathfinderPkg;

export function createBot({ username, host, port, version, auth }) {
  const bot = mineflayer.createBot({
    username,
    host,
    port: Number(port) || 25565,
    version: version || false,
    auth: auth || 'offline',
    hideErrors: false,
    checkTimeoutInterval: 60_000,
  });

  bot.loadPlugin(pathfinder);
  bot.loadPlugin(pvpPkg.plugin);
  bot.loadPlugin(collectBlockPkg.plugin);

  bot.once('spawn', () => {
    const moves = new Movements(bot);
    moves.allowParkour = true;
    moves.allowSprinting = true;
    moves.canDig = true;
    if ('canOpenDoors' in moves) moves.canOpenDoors = true; // чтобы не запереть себя в построенном доме
    // не ломать блоки, которые ломать не стоит
    for (const name of ['chest', 'crafting_table', 'furnace', 'bed', 'white_bed', 'red_bed', 'oak_door']) {
      const b = bot.registry.blocksByName[name];
      if (b) moves.blocksCantBreak.add(b.id);
    }
    bot.pathfinder.setMovements(moves);
    bot.defaultMovements = moves;
  });

  return bot;
}
