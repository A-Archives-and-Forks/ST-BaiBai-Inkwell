/**
 * 楼层一键截图。
 *
 * 流程:
 * 1. 用 ST 的 messageFormatting 把楼层原文按「深度 0」重渲染 —— 把 messageId 冒充成
 *    最后一条非系统消息的索引,让只在最新楼层生效的美化正则(minDepth/maxDepth)全部应用;
 * 2. 克隆真实楼层节点(保留头像/名字/主题样式),换入重渲染的正文;
 * 3. 酒馆助手渲染的 iframe(TH-message--楼层--序号,同源无 sandbox)逐个抓成图片,
 *    按顺序替换正文里的前端代码块;
 * 4. 挂进主文档的屏外容器(借 #chat 的主题选择器),snapdom 栅格化成 PNG 下载。
 */
import { getContext, type STContext, type STMessage } from '@/st/context';
import type { SnapdomFn } from '@/vendor/snapdom.js';

/* snapdom 约 150kB,只在第一次截图时按需加载,不进主包 */
let snapdomPromise: Promise<SnapdomFn> | null = null;
let warmedUp = false;

function loadSnapdom(): Promise<SnapdomFn> {
  snapdomPromise ??= import('@/vendor/snapdom.js').then(module => {
    // 后台预热字体/背景图缓存:字体内联是截图耗时大头,预热后后续截图直接命中缓存
    if (!warmedUp) {
      warmedUp = true;
      void module.preCache(document.body, { embedFonts: true }).catch(() => undefined);
    }
    return module.snapdom;
  });
  return snapdomPromise;
}

export interface FloorShotOutcome {
  /** 楼层里检测到的前端代码块数量 */
  frontendBlocks: number;
  /** 成功以 iframe 实况合成进截图的数量 */
  iframesCaptured: number;
  /** 楼层节点是否在聊天 DOM 里(不在则用模板兜底,且无法抓 iframe) */
  floorInDom: boolean;
  suggestedName: string;
}

/** 与酒馆助手 is_frontend.ts 相同的判定:含这三个片段之一的代码块会被渲染成 iframe */
export function isFrontendCode(code: string): boolean {
  return code.includes('html>') || code.includes('<head>') || code.includes('<body');
}

/**
 * 深度 0 的替身 messageId:ST 的正则深度 = 该消息在「非系统消息」序列里倒数第几条。
 * 返回最后一条非系统消息的索引;找不到(全是隐藏楼层)时退回楼层自身。
 */
export function depthZeroProxyId(chat: Pick<STMessage, 'is_system'>[], floor: number): number {
  for (let index = chat.length - 1; index >= 0; index--) {
    if (!chat[index]?.is_system) return index;
  }
  return floor;
}

/** 文件名里去掉 Windows/浏览器不容许的字符 */
export function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim() || 'floor';
}

export function buildShotFilename(floor: number, speaker: string, now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${sanitizeFilename(speaker)}-楼层${floor}-${stamp}.png`;
}

/** 沿 .mes → #chat → body 找第一个不透明背景色,截图垫底避免透明 PNG */
function resolveBackground(start: Element | null): string {
  let node: Element | null = start;
  while (node) {
    const color = getComputedStyle(node).backgroundColor;
    if (color && color !== 'transparent' && !/rgba\([^)]*,\s*0\)\s*$/.test(color)) return color;
    node = node.parentElement;
  }
  const tint = getComputedStyle(document.body).getPropertyValue('--SmartThemeBlurTintColor').trim();
  return tint || '#1f1f27';
}

function getDisplayText(message: STMessage): string {
  const display = message.extra?.['display_text'];
  return typeof display === 'string' && display ? display : message.mes;
}

/** 深度 0 重渲染;老版本 ST 没有 messageFormatting 时返回 null(走所见即所得兜底) */
function renderAtDepthZero(context: STContext, floor: number): string | null {
  const format = context.messageFormatting;
  const message = context.chat[floor];
  if (typeof format !== 'function' || !message) return null;
  try {
    return format(
      getDisplayText(message),
      message.name,
      message.is_system === true,
      message.is_user === true,
      depthZeroProxyId(context.chat, floor),
    );
  } catch {
    return null;
  }
}

function queryLiveMes(floor: number): HTMLElement | null {
  return document.querySelector<HTMLElement>(`#chat .mes[mesid="${floor}"]`);
}

/**
 * 兜底路径的头像解析,按 ST 自己的优先级:
 * force_avatar → 已渲染的同名同类楼层现抄 → 角色缩略图(仅 AI 楼层)。
 * 用户楼层的 persona 头像 context 上拿不到,靠「现抄」覆盖大多数场景。
 */
function resolveAvatarUrl(context: STContext, message: STMessage): string {
  if (typeof message.force_avatar === 'string' && message.force_avatar) {
    return message.force_avatar;
  }
  const isUser = message.is_user === true;
  const rendered = [...document.querySelectorAll<HTMLImageElement>('#chat .mes .avatar img')].find(
    img => {
      const mes = img.closest('.mes');
      return (
        !!img.getAttribute('src') &&
        mes?.getAttribute('is_user') === String(isUser) &&
        mes?.getAttribute('ch_name') === message.name
      );
    },
  );
  if (rendered) return rendered.getAttribute('src') ?? '';
  if (!isUser && typeof context.getThumbnailUrl === 'function') {
    const character = context.characters?.[Number(context.characterId)];
    if (character?.avatar && character.avatar !== 'none') {
      try {
        return context.getThumbnailUrl('avatar', character.avatar);
      } catch {
        return '';
      }
    }
  }
  return '';
}

/** 从消息模板造一个兜底 .mes(楼层未加载进 DOM 时用)。头像 src 由 ST 运行时注入,模板里是空的,必须自行解析补上 */
function buildMesFromTemplate(
  context: STContext,
  message: STMessage,
  floor: number,
): HTMLElement | null {
  const template = document.querySelector<HTMLElement>('#message_template .mes');
  if (!template) return null;
  const mes = template.cloneNode(true) as HTMLElement;
  mes.setAttribute('mesid', String(floor));
  mes.setAttribute('ch_name', message.name);
  mes.setAttribute('is_user', String(message.is_user === true));
  mes.setAttribute('is_system', String(message.is_system === true));
  const nameText = mes.querySelector('.ch_name .name_text');
  if (nameText) nameText.textContent = message.name;
  const img = mes.querySelector<HTMLImageElement>('.avatar img');
  if (img) {
    const avatar = resolveAvatarUrl(context, message);
    if (avatar) img.src = avatar;
    else img.closest('.mesAvatarWrapper')?.remove();
  }
  return mes;
}

/** 截图里没意义的交互控件,从克隆上剥掉 */
const STRIP_SELECTORS = [
  '.mes_buttons',
  '.mes_edit_buttons',
  '.for_checkbox',
  '.del_checkbox',
  '.swipe_left',
  '.swipeRightBlock',
  '.swipes-counter',
  '.mes_ghost',
].join(', ');

function stripInteractive(mes: HTMLElement): void {
  mes.querySelectorAll(STRIP_SELECTORS).forEach(el => el.remove());
  // 空的思维链折叠块(模板兜底时)也一并去掉
  const reasoning = mes.querySelector('.mes_reasoning_details');
  if (reasoning && !reasoning.querySelector('.mes_reasoning')?.textContent?.trim()) {
    reasoning.remove();
  }
}

interface LiveIframe {
  index: number;
  frame: HTMLIFrameElement;
}

/* 资源就绪的最长等待:超时后按当前状态开截,坏图/慢字体不至于卡死截图 */
const SETTLE_TIMEOUT_MS = 3000;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

/**
 * 截图前让克隆「安定」下来:
 * - 美化正则注入的 HTML 常带 opacity:0 起手的入场动画,离屏克隆刚挂载时动画在第 0 帧,
 *   直接开截会截到透明/位移状态 —— 注入样式把所有动画快进到最终帧(0s + forwards);
 * - 图片逐张 decode、字体等 fonts.ready,超时则放行;
 * - 最后等一帧 rAF 让上述样式生效。
 */
async function settleClone(host: HTMLElement, clone: HTMLElement): Promise<void> {
  const style = document.createElement('style');
  style.textContent = [
    '[data-bby-shot] *,',
    '[data-bby-shot] *::before,',
    '[data-bby-shot] *::after {',
    '  animation-duration: 0s !important;',
    '  animation-delay: 0s !important;',
    '  animation-iteration-count: 1 !important;',
    '  animation-fill-mode: forwards !important;',
    '  transition: none !important;',
    '}',
  ].join('\n');
  host.appendChild(style);

  const images = [...clone.querySelectorAll('img')];
  for (const image of images) image.loading = 'eager';
  const ready = Promise.all([
    ...images.map(image => image.decode().catch(() => undefined)),
    document.fonts?.ready.then(() => undefined).catch(() => undefined) ?? Promise.resolve(),
  ]);
  await Promise.race([ready, delay(SETTLE_TIMEOUT_MS)]);
  await new Promise(resolve => requestAnimationFrame(resolve));
}

/** 真实楼层里酒馆助手已渲染的 iframe,按代码块序号排序 */
function collectLiveIframes(liveMes: HTMLElement | null, floor: number): LiveIframe[] {
  if (!liveMes) return [];
  const pattern = new RegExp(`^TH-message--${floor}--(\\d+)`);
  return [...liveMes.querySelectorAll<HTMLIFrameElement>('iframe')]
    .map(frame => {
      const match = frame.id.match(pattern);
      return match ? { index: Number(match[1]), frame } : null;
    })
    .filter((item): item is LiveIframe => !!item)
    .sort((left, right) => left.index - right.index);
}

/** 同源 iframe 的文档抓成图片,原位替换克隆里的代码块;失败就保留代码块原样 */
async function composeIframes(
  snapdom: SnapdomFn,
  mesText: HTMLElement,
  liveFrames: LiveIframe[],
): Promise<{ frontendBlocks: number; captured: number }> {
  const frontendPres = [...mesText.querySelectorAll('pre')].filter(pre =>
    isFrontendCode(pre.textContent ?? ''),
  );
  // 各 iframe 相互独立,并行抓取;字体照常内联(美化常用自定义字体),靠 snapdom 缓存提速
  const results = await Promise.all(
    frontendPres.map(async (pre, order) => {
      const live = liveFrames[order]?.frame;
      const root = live?.contentDocument?.body ?? null;
      if (!live || !root) return false;
      try {
        const canvas = await snapdom.toCanvas(root, {
          embedFonts: true,
          backgroundColor: null,
          compress: true,
        });
        const img = document.createElement('img');
        img.src = canvas.toDataURL('image/png');
        img.style.width = `${live.clientWidth || live.offsetWidth || 0}px` || '100%';
        img.style.height = 'auto';
        img.style.display = 'block';
        pre.replaceWith(img);
        return true;
      } catch {
        // 单个 iframe 抓取失败不拖垮整张截图,保留代码块
        return false;
      }
    }),
  );
  return {
    frontendBlocks: frontendPres.length,
    captured: results.filter(Boolean).length,
  };
}

/**
 * 截取指定楼层为 PNG blob。
 * 返回 blob 与统计信息;调用方负责下载与用户提示。
 */
/* 溢出补偿上限:防异常定位把画布撑到离谱的尺寸 */
const MAX_OVERFLOW_PX = 600;

/**
 * 量出克隆树里溢出 .mes 边界的部分。美化常把头像/装饰用绝对定位挪到
 * .mes 外,而 snapdom 只画目标元素的边界框,溢出内容会整块被裁掉。
 * 返回四边各需扩出多少像素。
 */
function measureOverflow(clone: HTMLElement): {
  top: number;
  right: number;
  bottom: number;
  left: number;
} {
  const base = clone.getBoundingClientRect();
  let top = 0;
  let right = 0;
  let bottom = 0;
  let left = 0;
  for (const el of clone.querySelectorAll<HTMLElement>('*')) {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    // fixed 元素坐标相对视口,在屏外容器里无意义;overflow 裁剪内的溢出画不出来,不补
    if (style.position === 'fixed') continue;
    const rect = el.getBoundingClientRect();
    if (!rect.width && !rect.height) continue;
    top = Math.max(top, base.top - rect.top);
    left = Math.max(left, base.left - rect.left);
    right = Math.max(right, rect.right - base.right);
    bottom = Math.max(bottom, rect.bottom - base.bottom);
  }
  const clamp = (value: number) => Math.min(Math.ceil(Math.max(0, value)), MAX_OVERFLOW_PX);
  return { top: clamp(top), right: clamp(right), bottom: clamp(bottom), left: clamp(left) };
}

export async function captureFloorShot(
  floor: number,
): Promise<{ blob: Blob; outcome: FloorShotOutcome }> {
  const context = getContext();
  const message = context?.chat?.[floor];
  if (!context || !message) throw new Error('楼层不存在');
  const snapdom = await loadSnapdom();

  const liveMes = queryLiveMes(floor);
  const clone = liveMes
    ? (liveMes.cloneNode(true) as HTMLElement)
    : buildMesFromTemplate(context, message, floor);
  if (!clone) throw new Error('无法构建楼层截图节点');
  stripInteractive(clone);

  const mesText = clone.querySelector<HTMLElement>('.mes_text');
  if (!mesText) throw new Error('楼层结构异常:找不到正文节点');

  // 深度 0 重渲染;拿不到管线时保留克隆现状(所见即所得),但去掉酒馆助手的包装层
  const rendered = renderAtDepthZero(context, floor);
  if (rendered != null) {
    mesText.innerHTML = rendered;
  } else {
    mesText.querySelectorAll('.TH-render').forEach(wrapper => {
      const pre = wrapper.querySelector('pre');
      if (pre) {
        pre.classList.remove('hidden!');
        wrapper.replaceWith(pre);
      } else {
        wrapper.remove();
      }
    });
  }

  const iframeStats = await composeIframes(snapdom, mesText, collectLiveIframes(liveMes, floor));

  // 屏外容器复用 #chat 的 id 与 class,让主题里 `#chat .mes` 系选择器全部命中。
  // 同 id 元素靠后,getElementById 仍解析到真实聊天区,不影响 ST 自身脚本。
  const realChat = document.getElementById('chat');
  const host = document.createElement('div');
  host.id = 'chat';
  host.setAttribute('data-bby-shot', '');
  if (realChat?.className) host.className = realChat.className;
  host.style.cssText = [
    'position:fixed',
    'left:-100000px',
    'top:0',
    `width:${realChat?.clientWidth || 800}px`,
    'pointer-events:none',
    'contain:layout',
  ].join(';');
  host.appendChild(clone);
  document.body.appendChild(host);

  try {
    await settleClone(host, clone);
    // 布局安定后量溢出:美化把头像等挪出 .mes 边界时,套一层等量内边距的
    // 外框并改截外框,把溢出部分收进画布
    const overflow = measureOverflow(clone);
    let shotTarget: HTMLElement = clone;
    if (overflow.top || overflow.right || overflow.bottom || overflow.left) {
      const frame = document.createElement('div');
      frame.style.cssText = [
        `padding:${overflow.top}px ${overflow.right}px ${overflow.bottom}px ${overflow.left}px`,
        'box-sizing:content-box',
        `width:${clone.getBoundingClientRect().width}px`,
      ].join(';');
      host.appendChild(frame);
      frame.appendChild(clone);
      shotTarget = frame;
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    const blob = await snapdom.toBlob(shotTarget, {
      embedFonts: true,
      backgroundColor: resolveBackground(realChat),
      scale: Math.min(window.devicePixelRatio || 1, 2),
      type: 'png',
    });
    return {
      blob,
      outcome: {
        frontendBlocks: iframeStats.frontendBlocks,
        iframesCaptured: iframeStats.captured,
        floorInDom: !!liveMes,
        suggestedName: buildShotFilename(floor, message.name),
      },
    };
  } finally {
    host.remove();
  }
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
