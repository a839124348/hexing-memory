/**
 * unit-service.js — 向量服务生命周期（注入 fake，不占端口）
 */
const { EventEmitter } = require('events');
const { createEmbedService } = require('../src/service');

let pass = 0;
const fails = [];
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fails.push(name + (detail ? ' → ' + detail : '')); console.log('FAIL ' + name + (detail ? ' → ' + detail : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeChild() {
  const e = new EventEmitter();
  e.pid = 123;
  e.killed = false;
  e.kill = () => { e.killed = true; e.emit('exit', 0, null); };
  return e;
}

(async () => {
  // 1. 服务已健康：复用，不拉起，不杀别人的
  {
    let spawned = 0;
    const svc = createEmbedService({
      url: 'http://fake', cmd: 'x',
      healthCheck: async () => ({ ok: true }),
      spawnChild: () => { spawned++; return makeChild(); },
      sleep: async () => {},
    });
    const r = await svc.start();
    check('健康时复用', r.ok === true && r.owned === false);
    check('健康时不拉起', spawned === 0);
    await svc.stop();
  }

  // 2. 服务没起 + 有命令：拉起并等健康
  {
    let up = false, spawned = 0, children = [];
    const svc = createEmbedService({
      url: 'http://fake', cmd: 'x', pollMs: 1, attempts: 5,
      healthCheck: async () => ({ ok: up }),
      spawnChild: () => { spawned++; up = true; const c = makeChild(); children.push(c); return c; },
      sleep,
    });
    const r = await svc.start();
    check('不健康时拉起', r.ok === true && r.owned === true && spawned === 1);
    await svc.stop();
    check('退出时杀掉自己拉起的', children[0].killed === true);
  }

  // 3. 没命令也没服务：不阻塞，返回 no-cmd
  {
    let spawned = 0;
    const svc = createEmbedService({
      url: 'http://fake', cmd: '',
      healthCheck: async () => ({ ok: false }),
      spawnChild: () => { spawned++; return makeChild(); },
    });
    const r = await svc.start();
    check('没命令返回 no-cmd', r.ok === false && r.reason === 'no-cmd');
    check('没命令不拉起', spawned === 0);
    await svc.stop();
  }

  // 4. 子进程退出后自动重启
  {
    let up = false, spawned = 0, children = [];
    const svc = createEmbedService({
      url: 'http://fake', cmd: 'x', pollMs: 1, attempts: 5,
      restartDelayMs: 20, maxRestartDelayMs: 50,
      healthCheck: async () => ({ ok: up }),
      spawnChild: () => { spawned++; up = true; const c = makeChild(); children.push(c); c.once('exit', () => { up = false; }); return c; },
      sleep,
    });
    await svc.start();
    check('重启前已拉起 1 次', spawned === 1);
    children[0].emit('exit', 1, null);
    await sleep(80);
    check('退出后自动重启', spawned >= 2, 'spawned=' + spawned);
    await svc.stop();
  }

  console.log('\n结果：' + pass + '/' + (pass + fails.length) + ' 通过');
  if (fails.length) { console.log('失败：\n' + fails.join('\n')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
