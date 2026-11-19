/**
 * dsh-chat 客户端壳（浏览器侧）。
 *
 * 只做三件事，不碰聊天逻辑：
 *   1. 向 sidebarRightTabs 注册一个「页类型」dsh-chat；
 *   2. 向 sidebar.right.pane.tab 注册这个类型的**内容**——一个 iframe，指向
 *      `{origin}/chat?embed=1`（真正的界面、状态、数据库全在那个页面里）；
 *   3. 在左侧栏页脚（sidebar.footer.action）放一个按钮，点它 openTab('dsh-chat')。
 *
 * 注册形状照抄官方内置面板 @deepseek-ai/dsh-client-ui-sidebar-browser：
 *   inject = ["slots","locale","sidebarRight","sidebarRightTabs"]
 *   ctx.sidebarRightTabs.register({ id, kind, keepMounted, title, guide })
 *   ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({ name, key, locale }, Body))
 * 官方那个面板的内容也是 iframe（同文件里出现 16 次），所以这不是绕路。
 *
 * 无构建步骤：服务端按原样下发本文件（package.json exports["./client"]），
 * 用 React.createElement 而不是 JSX，因此不需要 bundler。
 */
window.__ModuleLoader__.load({
  id: '@lamefox/dsh-chat',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const h = React.createElement;

    /** 页类型的 kind 与注册 id（kind 是显式打开时用的名字，id 是槽位分发的键）。 */
    const KIND = 'dsh-chat';
    /** 宿主路由，与 lib/index.js 的 cfg.path 默认值一致；改配置时两处同步。 */
    const EMBED_PATH = '/chat';
    /** 文案命名空间。 */
    const NS = 'dshChat';
    /** 左侧栏页脚槽位（由 dsh-client-ui-sidebar 的工厂声明）。 */
    const SLOT_FOOTER = 'sidebar.footer.action';

    const zh = {
      tabTitle: '对话',
      actionLabel: '对话',
      actionHint: '在右侧打开 dsh-chat 对话窗口',
      guideTitle: '对话',
      guideDesc: '在右侧栏打开 dsh-chat 聊天窗口',
      frameTitle: 'dsh-chat 对话',
    };
    const en = {
      tabTitle: 'Chat',
      actionLabel: 'Chat',
      actionHint: 'Open the dsh-chat window on the right',
      guideTitle: 'Chat',
      guideDesc: 'Open the dsh-chat chat window in the right sidebar',
      frameTitle: 'dsh-chat',
    };

    /** 内嵌地址：同源 + 插件路由 + embed 标记（页面据此隐藏自带的侧栏和顶栏）。 */
    function embedUrl() {
      const base = typeof location !== 'undefined' ? location.origin : '';
      return `${base}${EMBED_PATH}?embed=1`;
    }

    const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs'];

    /** 注册失败必须只影响本插件：宿主把 apply 抛错记成 fiber failed，整个界面会停在启动失败页。 */
    function step(name, run) {
      try {
        return run();
      } catch (error) {
        console.error(`[dsh-chat] 客户端集成步骤失败：${name}`, error);
        return undefined;
      }
    }

    function apply(ctx) {
      try {
        mount(ctx);
      } catch (error) {
        console.error('[dsh-chat] 客户端集成整体失败，已跳过（独立 /chat 页面不受影响）', error);
      }
    }

    function mount(ctx) {
      // 老版本宿主没有这两个服务时安静退场：独立 /chat 页面仍然可用。
      if (!ctx.sidebarRight || !ctx.sidebarRightTabs) {
        console.warn('[dsh-chat] 宿主缺少 sidebarRight/sidebarRightTabs，客户端集成已跳过；请直接访问 ' + EMBED_PATH);
        return;
      }

      step('copy', () =>
      ctx.effect(
        () =>
          ctx.locale.register(NS, {
            zh,
            en,
          }),
        'dsh-chat: copy',
      ),
      );

      const t = (key) => {
        try {
          const value = ctx.locale.bind(NS)(key);
          if (typeof value === 'string' && value) return value;
        } catch {
          /* 回落到中文，缺文案不该让面板炸掉 */
        }
        return zh[key] ?? key;
      };

      // ── 1. 页类型 ───────────────────────────────────────────────────────────
      // 不声明 patterns：这是「按 kind 打开的页」，不是地址解析器。
      step('tab type', () =>
        ctx.effect(
          () =>
            ctx.sidebarRightTabs.register({
            id: KIND,
            kind: KIND,
            multiple: false,
            keepMounted: true,
            priority: 'extension',
            title: () => t('tabTitle'),
            guide: [
              {
                id: KIND,
                order: 40,
                title: () => t('guideTitle'),
                description: () => t('guideDesc'),
              },
              ],
            }),
          'dsh-chat: tab type',
        ),
      );

      // ── 2. 面板内容 ─────────────────────────────────────────────────────────
      function ChatFrame() {
        return h('iframe', {
          className: 'dsh-chat-frame',
          src: embedUrl(),
          title: t('frameTitle'),
          // 同源页面：剪贴板（复制/粘贴）与下载需要这两个权限。
          allow: 'clipboard-write; clipboard-read',
          style: {
            display: 'block',
            width: '100%',
            height: '100%',
            border: '0',
            background: 'transparent',
          },
        });
      }

      step('pane body', () =>
        ctx.slots.inject('sidebar.right.pane.tab', () =>
          ctx.slots.register(
            {
              name: 'sidebar.right.pane.tab',
              key: KIND,
              locale: NS,
            },
            ChatFrame,
          ),
        ),
      );

      // ── 3. 左侧栏页脚入口 ───────────────────────────────────────────────────
      const openChat = () => {
        try {
          ctx.sidebarRight.openTab(KIND);
        } catch (error) {
          console.error('[dsh-chat] 打开对话面板失败', error);
        }
      };

      /** 声明还没出现时 register 会抛 "not declared"；这种情况返回 null，让调用方稍后重试。 */
      function registerFooter(target, component) {
        try {
          return target.slots.register(
            { name: SLOT_FOOTER, id: KIND, order: 10, locale: NS },
            component,
          );
        } catch (error) {
          if (String(error && error.message).includes('is not declared')) return null;
          throw error;
        }
      }

      function FooterAction(props) {
        const wide = props !== undefined && props !== null && props.wide === true;
        return h(
          'button',
          {
            type: 'button',
            className: 'dsh-chat-action',
            title: t('actionHint'),
            'aria-label': t('actionLabel'),
            onClick: openChat,
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              width: '100%',
              padding: wide ? '6px 8px' : '6px',
              justifyContent: wide ? 'flex-start' : 'center',
              background: 'transparent',
              border: '0',
              borderRadius: '6px',
              color: 'inherit',
              font: 'inherit',
              cursor: 'pointer',
            },
          },
          h(
            'svg',
            {
              viewBox: '0 0 24 24',
              width: 18,
              height: 18,
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 1.7,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
              'aria-hidden': 'true',
            },
            h('path', { d: 'M21 11.5a8.4 8.4 0 0 1-9 8.4 9.6 9.6 0 0 1-3.3-.6L3 21l1.7-5.2A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4z' }),
          ),
          wide ? h('span', { style: { fontSize: '13px' } }, t('actionLabel')) : null,
        );
      }

      // 槽位由 dsh-client-ui-sidebar 的工厂声明，而它和本插件可能落在不同启动批次：
      // 注册太早会抛 "not declared"。这里按退避重试，等声明出现。
      step('footer action', () =>
        ctx.effect(() => {
          const backoff = [60, 200, 600, 1500, 3000];
          let attempt = 0;
          let timer = null;
          let disposer = null;

          const tryRegister = () => {
            timer = null;
            disposer = registerFooter(ctx, FooterAction);
            if (disposer) return;
            if (attempt >= backoff.length) {
              console.warn(
                `[dsh-chat] ${SLOT_FOOTER} 始终未声明，侧栏按钮已跳过；独立页面 ${EMBED_PATH} 仍然可用`,
              );
              return;
            }
            timer = setTimeout(tryRegister, backoff[attempt++]);
          };

          tryRegister();

          return () => {
            if (timer) clearTimeout(timer);
            if (typeof disposer === 'function') disposer();
          };
        }, 'dsh-chat: footer action'),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
