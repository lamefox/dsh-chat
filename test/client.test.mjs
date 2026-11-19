import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

const SOURCE_PATH = fileURLToPath(new URL('../lib/client.js', import.meta.url));
const SOURCE = readFileSync(SOURCE_PATH, 'utf8');

/** 在沙箱里执行客户端 bundle，拿到 exports（不启动 React，只验注册行为）。 */
function loadExports() {
  const React = { createElement: (type, props, ...children) => ({ type, props, children }) };
  const require = (name) => {
    if (name === 'react') return React;
    throw new Error(`unexpected require: ${name}`);
  };
  let captured = null;
  const sandbox = {
    window: { __ModuleLoader__: { load: (entry) => (captured = entry) } },
    location: { origin: 'http://127.0.0.1:3099' },
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
  };
  runInContext(SOURCE, createContext(sandbox));
  assert.ok(captured, '客户端 bundle 必须调用 __ModuleLoader__.load');
  return { entry: captured, exports: captured.factory(require) };
}

/** 记录每次调用、可配置抛错的假 ctx。 */
function fakeCtx(options = {}) {
  const calls = { register: [], effect: 0, tabs: 0 };
  const ctx = {
    effect(fn, label) {
      calls.effect += 1;
      calls.effectLabel = label;
      const disposer = fn();
      return typeof disposer === 'function' ? disposer : () => {};
    },
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: {
      inject(name, fn) {
        return fn();
      },
      register(config, component) {
        calls.register.push({ name: config.name, id: config.id, component });
        if (options.registerThrows && config.name === 'sidebar.footer.action') {
          throw new Error(options.registerThrows);
        }
        return () => {};
      },
    },
    sidebarRightTabs: {
      register: () => {
        calls.tabs += 1;
        return () => {};
      },
    },
    sidebarRight: { openTab: () => {} },
  };
  return { ctx, calls };
}

test('bundle 声明了宿主需要的入口形状', () => {
  const { entry, exports } = loadExports();
  assert.equal(entry.id, '@lamefox/dsh-chat');
  assert.equal(typeof exports.apply, 'function');
  assert.deepEqual(JSON.parse(JSON.stringify(exports.inject)), ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs']);
});

test('三个注册点都注册到了正确的槽位', () => {
  const { exports } = loadExports();
  const { ctx, calls } = fakeCtx();
  exports.apply(ctx);
  assert.equal(calls.tabs, 1, '必须注册一个 sidebarRightTabs 页类型');
  const names = calls.register.map((call) => call.name);
  assert.ok(names.includes('sidebar.right.pane.tab'), '必须注册右侧面板内容');
  assert.ok(names.includes('sidebar.footer.action'), '必须注册左侧栏入口');
});

test('宿主没有 sidebarRight 服务时安静退场', () => {
  const { exports } = loadExports();
  const applied = [];
  exports.apply({ ...fakeCtx().ctx, sidebarRight: undefined });
  applied.push('no-throw');
  assert.deepEqual(applied, ['no-throw']);
});

test('任一注册抛错都不冒泡（否则宿主整页停在启动失败卡片）', () => {
  const { exports } = loadExports();
  const { ctx } = fakeCtx({ registerThrows: 'boom' });
  assert.doesNotThrow(() => exports.apply(ctx));
});

test('槽位未声明时按退避重试，而不是直接放弃', async () => {
  const { exports } = loadExports();
  const { ctx, calls } = fakeCtx({
    registerThrows: 'slot "sidebar.footer.action" is not declared (a parent entry\'s children table must declare it)',
  });
  exports.apply(ctx);
  const first = calls.register.filter((call) => call.name === 'sidebar.footer.action').length;
  assert.equal(first, 1, '第一次尝试应当已经发生');

  await new Promise((resolve) => setTimeout(resolve, 150));
  const later = calls.register.filter((call) => call.name === 'sidebar.footer.action').length;
  assert.ok(later > first, `退避应当触发重试（首次 ${first} 次，150ms 后 ${later} 次）`);
});
