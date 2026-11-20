const assert = require('node:assert/strict');
const { Database } = require('../database/db');
const { SceneRepairService } = require('../utils/scene-repair-service');

async function run() {
  const database = Object.create(Database.prototype);
  const queries = [];
  database.executeQuery = async (sql, params) => {
    queries.push({ sql, params });
    if (sql.startsWith('INSERT INTO production_operation_locks')) return { changes: 1 };
    return { changes: 1 };
  };
  assert.equal(await database.acquireProductionOperationLock('p1', 'owner-a', 1000), true);
  const upsert = queries.find(item => item.sql.startsWith('INSERT INTO'));
  assert.match(upsert.sql, /ON CONFLICT\(production_id\) DO UPDATE/);
  assert.match(upsert.sql, /expires_at <= \?/);
  assert.match(upsert.sql, /owner = \?/);
  assert.equal(await database.renewProductionOperationLock('p1', 'owner-a', 5000), true);
  assert.match(queries.at(-1).sql, /UPDATE production_operation_locks/);
  assert.match(queries.at(-1).sql, /expires_at > \\?/);
  assert.deepEqual(queries.at(-1).params.slice(1), ['p1', 'owner-a', queries.at(-1).params[3]]);
  await database.releaseProductionOperationLock('p1', 'owner-a');
  assert.match(queries.at(-1).sql, /WHERE production_id = \? AND owner = \?/);

  const blockedDb = {
    acquireProductionOperationLock: async () => false,
    releaseProductionOperationLock: async () => { throw new Error('must not release another owner lock'); }
  };
  const blocked = new SceneRepairService(blockedDb, {}, { dataRoot: '/tmp' });
  await assert.rejects(
    blocked.rebuild('p2'),
    error => error.code === 'SCENE_REBUILD_IN_PROGRESS' && error.status === 409
  );
  assert.equal(blocked.activeRebuilds.has('p2'), false, 'local lock is cleared when DB lease is held elsewhere');

  let released = false;
  const ownedDb = {
    acquireProductionOperationLock: async () => true,
    releaseProductionOperationLock: async (_id, owner) => { released = owner.length > 0; }
  };
  const owned = new SceneRepairService(ownedDb, {}, { dataRoot: '/tmp' });
  owned.rebuildUnlocked = async () => 'ok';
  assert.equal(await owned.rebuild('p3'), 'ok');
  assert.equal(released, true, 'owned DB lease is released after work');
  assert.equal(owned.activeRebuilds.has('p3'), false);

  process.stdout.write('Production operation lock tests passed\\n');
}

run().catch(error => {
  process.stderr.write(`Production operation lock tests failed: ${error.stack || error.message}\\n`);
  process.exitCode = 1;
});
