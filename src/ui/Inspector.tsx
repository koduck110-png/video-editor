import { deleteSelected } from '../model/actions';
import { getClip, updateTextClip } from '../model/ops';
import { commit, useEditor } from '../model/store';
import { MediaClip, TextClip, formatTime } from '../model/types';

function TextInspector({ clip }: { clip: TextClip }) {
  const update = (patch: Partial<TextClip>, key: string) =>
    commit((p) => updateTextClip(p, clip.id, patch), `${clip.id}:${key}`);
  return (
    <>
      <div className="field">
        <label htmlFor="text-input">文字</label>
        <textarea
          id="text-input"
          value={clip.text}
          onChange={(e) => update({ text: e.target.value }, 'text')}
          placeholder="ここに文字を入力"
          data-testid="text-input"
        />
      </div>
      <div className="field">
        <span className="field-label">大きさ</span>
        <div className="row">
          <input
            type="range"
            min={16}
            max={300}
            value={clip.fontSize}
            onChange={(e) => update({ fontSize: Number(e.target.value) }, 'fontSize')}
            aria-label="文字の大きさ"
          />
          <input
            type="number"
            min={8}
            max={600}
            value={clip.fontSize}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (v >= 8 && v <= 600) update({ fontSize: v }, 'fontSize');
            }}
            aria-label="文字の大きさ（数字）"
            data-testid="font-size"
          />
        </div>
      </div>
      <div className="field">
        <div className="row">
          <div style={{ flex: 1 }}>
            <span className="field-label">文字の色</span>
            <input
              type="color"
              value={clip.color}
              onChange={(e) => update({ color: e.target.value }, 'color')}
              aria-label="文字の色"
              data-testid="text-color"
            />
          </div>
          <div style={{ flex: 1 }}>
            <span className="field-label">太字</span>
            <label className="row" style={{ height: 30 }}>
              <input
                type="checkbox"
                checked={clip.bold}
                onChange={(e) => update({ bold: e.target.checked }, 'bold')}
              />
              太くする
            </label>
          </div>
        </div>
      </div>
      <div className="field">
        <span className="field-label">縁取り</span>
        <div className="row">
          <input
            type="color"
            value={clip.strokeColor}
            onChange={(e) => update({ strokeColor: e.target.value }, 'strokeColor')}
            aria-label="縁取りの色"
            data-testid="stroke-color"
          />
          <input
            type="range"
            min={0}
            max={30}
            value={clip.strokeWidth}
            onChange={(e) => update({ strokeWidth: Number(e.target.value) }, 'strokeWidth')}
            aria-label="縁取りの太さ"
            data-testid="stroke-width"
          />
          <span style={{ width: 28, textAlign: 'right' }}>{clip.strokeWidth}</span>
        </div>
      </div>
      <div className="field">
        <span className="field-label">位置（プレビューの文字をドラッグしても動かせます）</span>
        <div className="row">
          <span style={{ width: 28 }}>横</span>
          <input
            type="range"
            min={0}
            max={1000}
            value={Math.round(clip.x * 1000)}
            onChange={(e) => update({ x: Number(e.target.value) / 1000 }, 'x')}
            aria-label="横の位置"
          />
        </div>
        <div className="row" style={{ marginTop: 6 }}>
          <span style={{ width: 28 }}>縦</span>
          <input
            type="range"
            min={0}
            max={1000}
            value={Math.round(clip.y * 1000)}
            onChange={(e) => update({ y: Number(e.target.value) / 1000 }, 'y')}
            aria-label="縦の位置"
          />
        </div>
        <div className="preset-row" style={{ marginTop: 8 }}>
          <button onClick={() => commit((p) => updateTextClip(p, clip.id, { x: 0.5, y: 0.15 }))}>上</button>
          <button onClick={() => commit((p) => updateTextClip(p, clip.id, { x: 0.5, y: 0.5 }))}>真ん中</button>
          <button onClick={() => commit((p) => updateTextClip(p, clip.id, { x: 0.5, y: 0.82 }))}>下</button>
        </div>
      </div>
      <ClipTiming clip={clip} />
    </>
  );
}

function ClipTiming({ clip }: { clip: TextClip | MediaClip }) {
  return (
    <div className="field">
      <div className="info-table">
        <div>
          <span>開始</span>
          {formatTime(clip.start)}
        </div>
        <div>
          <span>長さ</span>
          {clip.duration.toFixed(1)} 秒
        </div>
      </div>
      <button className="danger" style={{ marginTop: 10 }} onClick={deleteSelected}>
        🗑 このクリップを削除
      </button>
    </div>
  );
}

function MediaInspector({ clip }: { clip: MediaClip }) {
  const asset = useEditor((s) => s.assets[clip.assetId]);
  const kind = asset?.kind === 'video' ? '動画' : asset?.kind === 'image' ? '画像' : '音楽';
  return (
    <>
      <div className="field">
        <div className="info-table">
          <div>
            <span>素材</span>
            {asset?.name ?? '-'}
          </div>
          <div>
            <span>種類</span>
            {kind}
          </div>
          {asset?.kind !== 'image' && (
            <div>
              <span>使う部分</span>
              {formatTime(clip.inPoint)} 〜 {formatTime(clip.inPoint + clip.duration)}
            </div>
          )}
          {asset?.kind === 'video' && asset.hasAudio === false && (
            <div>
              <span>音声</span>なし
            </div>
          )}
        </div>
      </div>
      <ClipTiming clip={clip} />
    </>
  );
}

export function Inspector() {
  const clip = useEditor((s) => (s.selectedClipId ? getClip(s.project, s.selectedClipId) : undefined));
  return (
    <section className="panel">
      <div className="panel-title">{clip?.type === 'text' ? '文字の設定' : clip ? 'クリップの情報' : '設定'}</div>
      <div className="panel-body">
        {clip?.type === 'text' && <TextInspector clip={clip} />}
        {clip?.type === 'media' && <MediaInspector clip={clip} />}
        {!clip && (
          <div className="hint">
            タイムラインのクリップをクリックすると、ここで設定できます。
            <br />
            <br />
            <b>使い方</b>
            <br />
            ・素材をタイムラインへドラッグ、または「＋追加」
            <br />
            ・クリップをドラッグで移動、両端をつまんで長さを変更
            <br />
            ・「分割」で白い線の位置で2つに分ける
            <br />
            <br />
            <b>キーボード</b>
            <br />
            <kbd>スペース</kbd> 再生・一時停止
            <br />
            <kbd>Ctrl</kbd>+<kbd>Z</kbd> 元に戻す / <kbd>Ctrl</kbd>+<kbd>Y</kbd> やり直し
            <br />
            <kbd>Ctrl</kbd>+<kbd>B</kbd> 分割 / <kbd>Delete</kbd> 削除
            <br />
            <kbd>←</kbd> <kbd>→</kbd> 1コマ移動
            <br />
            <kbd>Ctrl</kbd>+マウスホイール タイムラインの拡大・縮小
          </div>
        )}
      </div>
    </section>
  );
}
