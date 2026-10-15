// 文字のフォント。Google Fonts から読み込む（文字の形のデータを受け取るだけで、動画などは送らない）

export const SYSTEM_GOTHIC =
  "'Hiragino Kaku Gothic ProN','Hiragino Sans','Yu Gothic UI','Yu Gothic','Meiryo','Noto Sans JP','Noto Sans CJK JP',sans-serif";

export interface FontDef {
  id: string;
  name: string;
  /** Google Fonts のフォント名（なければパソコンに入っているフォントを使う） */
  web?: string;
  /** Google Fonts に頼む太さ（省略時は標準のみ） */
  weights?: string;
  fallback?: string;
}

export const FONTS: FontDef[] = [
  { id: 'gothic', name: 'ゴシック（標準）' },
  { id: 'noto', name: 'Noto Sans', web: 'Noto Sans JP', weights: 'wght@400;700;900' },
  { id: 'mincho', name: '明朝', web: 'Noto Serif JP', weights: 'wght@400;700', fallback: "'Yu Mincho','Hiragino Mincho ProN',serif" },
  { id: 'maru', name: '丸ゴシック', web: 'Zen Maru Gothic', weights: 'wght@400;700' },
  { id: 'mplus', name: 'Mプラス丸', web: 'M PLUS Rounded 1c', weights: 'wght@400;800' },
  { id: 'kosugi', name: 'こすぎ丸', web: 'Kosugi Maru' },
  { id: 'dela', name: '極太ゴシック', web: 'Dela Gothic One' },
  { id: 'potta', name: 'ぽってり', web: 'Potta One' },
  { id: 'reggae', name: 'レゲエ', web: 'Reggae One' },
  { id: 'rocknroll', name: 'ロックンロール', web: 'RocknRoll One' },
  { id: 'stick', name: 'ステッキ', web: 'Stick' },
  { id: 'yusei', name: '手書き風', web: 'Yusei Magic' },
  { id: 'hachi', name: 'はちまるポップ', web: 'Hachi Maru Pop' },
  { id: 'kaisei', name: '装飾明朝', web: 'Kaisei Decol', weights: 'wght@400;700' },
  { id: 'dot', name: 'ドット', web: 'DotGothic16' },
];

export function getFont(id: string): FontDef {
  return FONTS.find((f) => f.id === id) ?? FONTS[0];
}

/** canvas の font に使う名前の並び */
export function fontStack(id: string): string {
  const f = getFont(id);
  if (!f.web) return SYSTEM_GOTHIC;
  return `'${f.web}',${f.fallback ?? ''}${f.fallback ? ',' : ''}${SYSTEM_GOTHIC}`;
}

const linked = new Set<string>();
/** スタイルシートの読み込みが終わったフォント */
const sheetReady = new Set<string>();
const loaded = new Map<string, Promise<boolean>>();

function linkStylesheet(f: FontDef): void {
  if (!f.web || linked.has(f.id)) return;
  linked.add(f.id);
  const fam = f.web.replace(/ /g, '+') + (f.weights ? `:${f.weights}` : '');
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?family=${fam}&display=swap`;
  document.head.appendChild(link);
}

function waitStylesheet(f: FontDef): Promise<void> {
  // スタイルシートが読み込まれるまで待つ（最大 5 秒）
  return new Promise((resolve) => {
    const link = [...document.querySelectorAll<HTMLLinkElement>('link[rel=stylesheet]')].find((l) =>
      l.href.includes(`family=${f.web!.replace(/ /g, '+')}`),
    );
    if (!link || link.sheet) return resolve();
    const done = () => resolve();
    link.addEventListener('load', done, { once: true });
    link.addEventListener('error', done, { once: true });
    setTimeout(done, 5000);
  });
}

/**
 * フォントを使えるようにする。読み込めたら true。
 * text にはその文字（日本語のフォントは文字ごとに分けて配られるため）
 */
export function ensureFont(id: string, bold: boolean, text: string): Promise<boolean> {
  const f = getFont(id);
  if (!f.web) return Promise.resolve(true);
  const key = `${id}|${bold ? 'b' : 'n'}|${text}`;
  const existing = loaded.get(key);
  if (existing) return existing;
  linkStylesheet(f);
  const p = (async () => {
    try {
      await waitStylesheet(f);
      sheetReady.add(f.id);
      const spec = `${bold ? 'bold ' : ''}48px '${f.web}'`;
      await Promise.race([document.fonts.load(spec, text || 'あ'), new Promise((r) => setTimeout(r, 8000))]);
      return document.fonts.check(spec, text || 'あ');
    } catch {
      return false;
    }
  })();
  loaded.set(key, p);
  return p;
}

/** すでに読み込みが終わっているか（終わっていなければ読み込みを始める） */
export function isFontReady(id: string, bold: boolean, text: string, onReady: () => void): boolean {
  const f = getFont(id);
  if (!f.web) return true;
  const spec = `${bold ? 'bold ' : ''}48px '${f.web}'`;
  linkStylesheet(f);
  try {
    // スタイルシートがまだのときは check() が「読み込むものがない＝true」を返すので先に確かめる
    if (sheetReady.has(f.id) && document.fonts.check(spec, text || 'あ')) return true;
  } catch {
    /* 無視 */
  }
  void ensureFont(id, bold, text).then(() => onReady());
  return false;
}
