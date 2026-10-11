import { useRef } from 'react';
import { addAssetToTimeline } from '../model/actions';
import { useEditor } from '../model/store';
import { Asset, formatTime } from '../model/types';
import { ACCEPT, importFiles } from '../media/assets';

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
      <div
        className="media-thumb"
        style={asset.thumbnail ? { backgroundImage: `url(${asset.thumbnail})` } : undefined}
      >
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
            title="タイムラインの最後に追加"
            data-testid="media-add"
          >
            ＋追加
          </button>
        )}
      </div>
      <div className="media-name">{asset.name}</div>
    </div>
  );
}

export function MediaPanel() {
  const inputRef = useRef<HTMLInputElement>(null);
  const assets = useEditor((s) => s.assets);
  const order = useEditor((s) => s.assetOrder);
  return (
    <section className="panel">
      <div className="panel-title">素材</div>
      <div className="panel-body">
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
              if (files.length) void importFiles(files);
            }}
          />
        </div>
        <div className="media-grid">
          {order.map((id) => (
            <MediaItem key={id} asset={assets[id]} />
          ))}
        </div>
      </div>
    </section>
  );
}
