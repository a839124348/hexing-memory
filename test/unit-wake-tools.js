/**
 * unit-wake-tools.js — 唤醒轮：只读 + 追加，拒绝删除/覆盖/执行任务
 */
const { decideWakeTool } = require('../src/wake_tools');

let pass = 0;
const fails = [];
const check = (n, c, d) => {
  if (c) { pass++; console.log('PASS ' + n); }
  else { fails.push(n + (d ? ' | ' + d : '')); console.log('FAIL ' + n + (d ? ' | ' + d : '')); }
};

const allow = (name, args) => decideWakeTool(name, args).allow;
const deny = (name, args) => !decideWakeTool(name, args).allow;

check('读文件允许', allow('read', {}));
check('搜索允许', allow('grep', {}));
check('联网读允许', allow('web_search', {}));
check('memory_search 允许', allow('memory_search', {}));
check('memory_common 允许', allow('memory_common', {}));
check('memory_draft 读取允许', allow('memory_draft', {}));
check('memory_chain list 允许', allow('memory_chain', { action: 'list' }));
check('memory_chain get 允许', allow('memory_chain', { action: 'get' }));
check('memory_chain append 允许', allow('memory_chain', { action: 'append' }));
check('memory_chain create 允许', allow('memory_chain', { action: 'create' }));
check('memory_chain header 拒绝', deny('memory_chain', { action: 'header' }));
check('memory_chain delete 拒绝', deny('memory_chain', { action: 'delete' }));
check('memory_topic list 允许', allow('memory_topic', { action: 'list' }));
check('memory_topic add 允许', allow('memory_topic', { action: 'add' }));
check('memory_topic close 拒绝', deny('memory_topic', { action: 'close' }));
check('memory_topic merge 拒绝', deny('memory_topic', { action: 'merge' }));
check('memory_write 追加允许', allow('memory_write', {}));
check('memory_manual read 允许', allow('memory_manual', { action: 'read' }));
check('memory_manual ack 拒绝', deny('memory_manual', { action: 'ack' }));
check('memory_identity get 允许', allow('memory_identity', { action: 'get' }));
check('memory_identity update 拒绝', deny('memory_identity', { action: 'update' }));
check('memory_onboarding status 允许', allow('memory_onboarding', { action: 'status' }));
check('memory_onboarding save 拒绝', deny('memory_onboarding', { action: 'save' }));
check('bash 拒绝', deny('bash', {}));
check('write 拒绝', deny('write', {}));
check('edit 拒绝', deny('edit', {}));
check('schedule_create 拒绝', deny('schedule_create', {}));
check('memory_wake 拒绝', deny('memory_wake', { action: 'enable' }));
check('memory_backfill 拒绝', deny('memory_backfill', { action: 'start' }));
check('subagent 拒绝', deny('subagent', {}));
check('未知工具默认拒绝', deny('some_new_tool', {}));

console.log('');
console.log('结果：' + pass + '/' + (pass + fails.length) + ' 通过');
if (fails.length) { console.log('失败：'); fails.forEach((x) => console.log('  ' + x)); process.exit(1); }
