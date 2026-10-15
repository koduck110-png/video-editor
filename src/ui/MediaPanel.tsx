import { useEffect, useRef, useState } from 'react';
import { addAssetToTimeline, addText, applyFilter, applyTransition, deleteAsset } from '../model/actions';
import { DEFAULT_TEXT_STYLE, TEXT_PRESETS, TextStyle } from '../model/defaults';
import { getClip } from '../model/ops';
import { useEditor } from '../model/store';
import { Asset, formatTime } from '../model/types';
import { ACCEPT, importFiles } from '../media/assets';
import { requestPersistentStorage } from '../persist/autosave';
import { FILTER_PRESETS, TRANSITIONS } from '../render/effects';
import { ensureFont, fontStack } from '../render/fonts';

export const ASSET_DRAG_TYPE = 'application/x-video-editor-asset';

const KIND_LABEL: Record<Asset['kind'], string> = { video: '動画', image: '画像', audio: '音楽' };
const KIND_ICON: Record<Asset['kind'], string> = { video: '🎬', image: '🖼', audio: '🎵' };

function MediaItem({ asset }: { asset: Asset }) {
  const ready = asset.status === 'ready';
  return (
    <div
      className={`media-item ${asset.status}`}
      draggable={ready}
      onDragStart={(e) => {
        e.dataTransfer.setData(ASSET_DRAG_TYPE, asset.id);
        e.dataTransfer.effectAllowed = 'copy';
      }}
      onDoubleClick={() => ready && addAssetToTimeline(asset)}
      title={ready ? 'タイムラインへドラッグ、またはダブルクリックで追加' : asset.error ?? '読み込み中…'}
      data-testid="media-item"
    >
      <div className="media-thumb" style={asset.thumbnail ? { backgroundImage: `url(${asset.thumbnail})` } : undefined}>
        {asset.status === 'loading' && <div className="spinner" />}
        {asset.status === 'error' && <span>{asset.error ?? '読み込めませんでした'}</span>}
        {ready && !asset.thumbnail && <span>{KIND_ICON[asset.kind]}</span>}
        {ready && (
          <span className="media-badge">
            {KIND_LABEL[asset.kind]}
            {asset.kind !== 'image' && ` ${formatTime(asset.duration, false)}`}
          </span>
        )}
        {ready && (
          <button
            className="media-add"
            onClick={(e) => {
              e.stopPropagation();
              addAssetToTimeline(asset);
            }}
            title="タイムラインに追加"
            data-testid="media-add"
          >
            ＋追加
          </button>
        )}
        <button
          className="media-del"
          onClick={(e) => {
            e.stopPropagation();
            deleteAsset(asset);
          }}
          title="素材を一覧から消す"
        >
          ×
        </button>
      </div>
      <div className="media-name">{asset.name}</div>
    </div>
  );
}

function MediaTab() {
  const inputRef = useRef<HTMLInputElement>(null);
  const assets = useEditor((s) => s.assets);
  const order = useEditor((s) => s.assetOrder);
  return (
    <>
      <div className="media-drop">
        動画・画像・音楽を
        <br />
        ここにドラッグ＆ドロップ
        <br />
        <button className="primary" onClick={() => inputRef.current?.click()} data-testid="import-button">
          ＋ ファイルを読み込む
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT}
          hidden
          data-testid="file-input"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            if (files.length) {
              requestPersistentStorage();
              void importFiles(files);
            }
          }}
        />
      </div>
      <div className="media-grid">
        {order.map((id) => assets[id] && <MediaItem key={id} asset={assets[id]} />)}
      </div>
    </>
  );
}

/** 文字のデザインの見本（CSS でだいたいの見た目を出す） */
function TextSample({ style }: { style: TextStyle }) {
  const css: React.CSSProperties = {
    fontFamily: fontStack(style.fontFamily),
    fontWeight: style.bold ? 700 : 400,
    fontStyle: style.italic ? 'italic' : 'normal',
    color: style.color,
    WebkitTextStroke: style.strokeWidth > 0 ? `${Math.min(4, style.strokeWidth / 3)}px ${style.strokeColor}` : undefined,
    paintOrder: 'stroke fill',
    background: style.bgOpacity > 0 ? style.bgColor : undefined,
    padding: style.bgOpacity > 0 ? '0 6px' : undefined,
    borderRadius: 4,
    textShadow:
      style.shadowBlur > 0 || style.shadowDistance > 0
        ? `${style.shadowDistance / 3}px ${style.shadowDistance / 3}px ${style.shadowBlur / 3}px ${style.shadowColor}`
        : undefined,
  };
  return (
    <span className="text-sample" style={css}>
      あア字
    </span>
  );
}

function TextTab() {
  useEffect(() => {
    // 見本の表示に使うフォントを読み込んでおく
    for (const p of TEXT_PRESETS) {
      const st = { ...DEFAULT_TEXT_STYLE, ...p.style };
      void ensureFont(st.fontFamily, st.bold, 'あア字');
    }
  }, []);
  return (
    <>
      <p className="tab-hint">押すと、白い線の位置に文字が入ります。</p>
      <div className="preset-grid">
        {TEXT_PRESETS.map((p) => {
          const st = { ...DEFAULT_TEXT_STYLE, ...p.style };
          return (
            <button key={p.id} className="preset-card" onClick={() => addText(p.style)} data-testid={`text-preset-${p.id}`}>
              <div className="preset-visual dark">
                <TextSample style={st} />
              </div>
              <span>{p.name}</span>
            </button>
          );
        })}
      </div>
    </>
  );
}

function TransitionTab() {
  const selTrans = useEditor((s) => s.selectedTransitionClipId);
  const current = useEditor((s) => (selTrans ? getClip(s.project, selTrans)?.transitionIn?.type : undefined));
  return (
    <>
      <p className="tab-hint">
        すき間なく並んだクリップのつなぎ目にある「⇄」を押して選び、ここから効果を選んでください。クリップを選んでいる場合はその前のつなぎ目に付きます。
      </p>
      <div className="preset-grid">
        {TRANSITIONS.map((t) => (
          <button
            key={t.type}
            className={`preset-card${current === t.type ? ' active' : ''}`}
            onClick={() => applyTransition(t.type)}
            data-testid={`transition-${t.type}`}
          >
            <div className="preset-visual trans">{t.icon}</div>
            <span>{t.name}</span>
          </button>
        ))}
      </div>
    </>
  );
}

function FilterTab() {
  const current = useEditor((s) => {
    const c = s.selectedClipId ? getClip(s.project, s.selectedClipId) : undefined;
    return c?.type === 'media' ? c.filter.id : undefined;
  });
  return (
    <>
      <p className="tab-hint">映像（動画・画像）のクリップを選んでから押してください。強さは右の「調整」で変えられます。</p>
      <div className="preset-grid">
        {FILTER_PRESETS.map((f) => (
          <button
            key={f.id}
            className={`preset-card${current === f.id ? ' active' : ''}`}
            onClick={() => applyFilter(f.id)}
            data-testid={`filter-${f.id}`}
          >
            <div className="preset-visual" style={{ background: f.swatch }} />
            <span>{f.name}</span>
          </button>
        ))}
      </div>
    </>
  );
}

type Tab = 'media' | 'text' | 'transition' | 'filter';

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'media', label: '素材', icon: '🎞' },
  { id: 'text', label: '文字', icon: 'T' },
  { id: 'transition', label: 'トランジション', icon: '⇄' },
  { id: 'filter', label: 'フィルター', icon: '🎨' },
];

export function MediaPanel() {
  const [tab, setTab] = useState<Tab>('media');
  return (
    <section className="panel left-panel">
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`tab${tab === t.id ? ' active' : ''}`}
            onClick={() => setTab(t.id)}
            data-testid={`left-tab-${t.id}`}
          >
            <span className="tab-icon">{t.icon}</span>
            {t.label}
          </button>
        ))}
      </div>
      <div className="panel-body">
        {tab === 'media' && <MediaTab />}
        {tab === 'text' && <TextTab />}
        {tab === 'transition' && <TransitionTab />}
        {tab === 'filter' && <FilterTab />}
      </div>
    </section>
  );
}
