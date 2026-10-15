import { useEffect, useState } from 'react';
import { deleteSelected, detachSelectedAudio } from '../model/actions';
import { DEFAULT_TEXT_STYLE, TEXT_PRESETS } from '../model/defaults';
import {
  effectiveTransition,
  getClip,
  setClipSpeed,
  setRatio,
  setTransition,
  trackKindOfClip,
  updateClipCommon,
  updateMediaClip,
  updateTextClip,
} from '../model/ops';
import { commit, selectTransition, useEditor } from '../model/store';
import {
  Anim,
  Clip,
  DEFAULT_ADJUST,
  DEFAULT_TRANSFORM,
  MediaClip,
  Project,
  RATIOS,
  TextClip,
  Transform,
  formatTime,
} from '../model/types';
import { ANIM_IN, ANIM_OUT, FILTER_PRESETS, TRANSITIONS, getFilterPreset } from '../render/effects';
import { FONTS, ensureFont, fontStack } from '../render/fonts';

// ---------- 部品 ----------

/** 入力途中の数字（「1」→「14」→「140」など）も打てる数字欄 */
function NumberField(props: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  label: string;
  testId?: string;
  step?: number;
}) {
  const { value, min, max, onChange, label, testId, step } = props;
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      type="number"
      min={min}
      max={max}
      step={step ?? 1}
      value={draft ?? String(Math.round(value * 100) / 100)}
      onChange={(e) => {
        setDraft(e.target.value);
        const v = Number(e.target.value);
        if (e.target.value !== '' && v >= min && v <= max) onChange(v);
      }}
      onBlur={() => setDraft(null)}
      aria-label={label}
      data-testid={testId}
    />
  );
}

/** つまみ＋数字。ダブルクリックで初期値に戻す */
function Slider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** 表示用の倍率（0〜1 の値を % で見せるときは 100） */
  display?: number;
  unit?: string;
  reset?: number;
  onChange: (v: number) => void;
  testId?: string;
}) {
  const { label, value, min, max, step, display = 1, unit = '', reset, onChange, testId } = props;
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="row">
        <input
          type="range"
          min={min}
          max={max}
          step={step ?? (max - min) / 200}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          onDoubleClick={() => reset !== undefined && onChange(reset)}
          aria-label={label}
          data-testid={testId}
          title={reset !== undefined ? 'ダブルクリックで元に戻す' : undefined}
        />
        <NumberField
          value={value * display}
          min={min * display}
          max={max * display}
          step={display >= 100 ? 1 : 0.1}
          onChange={(v) => onChange(v / display)}
          label={`${label}（数字）`}
          testId={testId ? `${testId}-num` : undefined}
        />
        {unit && <span className="unit">{unit}</span>}
      </div>
    </div>
  );
}

function Tabs<T extends string>(props: { tabs: { id: T; label: string }[]; value: T; onChange: (t: T) => void }) {
  return (
    <div className="tabs small" role="tablist">
      {props.tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={props.value === t.id}
          className={`tab${props.value === t.id ? ' active' : ''}`}
          onClick={() => props.onChange(t.id)}
          data-testid={`insp-tab-${t.id}`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

function ChoiceGrid<T extends string>(props: {
  items: { id: T; label: string }[];
  value: T | null;
  onChange: (v: T) => void;
  testPrefix?: string;
}) {
  return (
    <div className="choice-grid">
      {props.items.map((it) => (
        <button
          key={it.id}
          className={`choice${props.value === it.id ? ' active' : ''}`}
          onClick={() => props.onChange(it.id)}
          data-testid={props.testPrefix ? `${props.testPrefix}-${it.id}` : undefined}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

// ---------- 共通（位置・アニメーション） ----------

function TransformSection({ clip, project }: { clip: Clip; project: Project }) {
  const assets = useEditor((s) => s.assets);
  const tr = clip.transform;
  const set = (patch: Partial<Transform>, key: string) =>
    commit((p) => updateClipCommon(p, clip.id, { transform: { ...tr, ...patch } }), `${clip.id}:tr:${key}`);
  const fillScale = (() => {
    if (clip.type !== 'media') return 1;
    const a = assets[clip.assetId];
    if (!a?.width || !a.height) return 1;
    const { width: W, height: H } = project.settings;
    return Math.max(W / a.width, H / a.height) / Math.min(W / a.width, H / a.height);
  })();
  return (
    <>
      <Slider label="大きさ" value={tr.scale} min={0.05} max={4} display={100} unit="%" reset={1} onChange={(v) => set({ scale: v }, 'scale')} testId="tr-scale" />
      <Slider label="横の位置" value={tr.x} min={-0.5} max={1.5} display={100} unit="%" reset={0.5} onChange={(v) => set({ x: v }, 'x')} testId="tr-x" />
      <Slider label="縦の位置" value={tr.y} min={-0.5} max={1.5} display={100} unit="%" reset={0.5} onChange={(v) => set({ y: v }, 'y')} testId="tr-y" />
      <Slider label="回転" value={tr.rotation} min={-180} max={180} step={1} unit="°" reset={0} onChange={(v) => set({ rotation: v }, 'rot')} testId="tr-rot" />
      <Slider label="不透明度" value={tr.opacity} min={0} max={1} display={100} unit="%" reset={1} onChange={(v) => set({ opacity: v }, 'op')} testId="tr-opacity" />
      <div className="field">
        <span className="field-label">反転・配置</span>
        <div className="preset-row">
          <button className={tr.flipH ? 'on' : ''} onClick={() => set({ flipH: !tr.flipH }, 'fh')}>
            ⇋ 左右反転
          </button>
          <button className={tr.flipV ? 'on' : ''} onClick={() => set({ flipV: !tr.flipV }, 'fv')}>
            ⇵ 上下反転
          </button>
          {clip.type === 'media' && (
            <>
              <button onClick={() => set({ scale: 1, x: 0.5, y: 0.5, rotation: 0 }, 'fit')}>画面に合わせる</button>
              <button onClick={() => set({ scale: fillScale, x: 0.5, y: 0.5, rotation: 0 }, 'fill')} data-testid="tr-fill">
                画面いっぱい
              </button>
            </>
          )}
          {clip.type === 'text' && (
            <>
              <button onClick={() => set({ x: 0.5, y: 0.15 }, 'top')}>上</button>
              <button onClick={() => set({ x: 0.5, y: 0.5 }, 'mid')}>真ん中</button>
              <button onClick={() => set({ x: 0.5, y: 0.82 }, 'bottom')}>下</button>
            </>
          )}
          <button
            onClick={() =>
              set(clip.type === 'text' ? { ...DEFAULT_TRANSFORM, y: 0.82 } : { ...DEFAULT_TRANSFORM }, 'reset')
            }
          >
            リセット
          </button>
        </div>
      </div>
    </>
  );
}

function AnimSection({ clip }: { clip: Clip }) {
  const isText = clip.type === 'text';
  const setAnim = (which: 'animIn' | 'animOut', anim: Anim | null) =>
    commit((p) => updateClipCommon(p, clip.id, { [which]: anim }), `${clip.id}:${which}`);
  const block = (which: 'animIn' | 'animOut', title: string, list: typeof ANIM_IN) => {
    const cur = clip[which];
    const items = [{ id: 'none', label: 'なし' }, ...list.filter((a) => isText || a.type !== 'typewriter').map((a) => ({ id: a.type, label: a.name }))];
    return (
      <div className="field">
        <span className="field-label">{title}</span>
        <ChoiceGrid
          items={items}
          value={cur?.type ?? 'none'}
          onChange={(id) =>
            setAnim(which, id === 'none' ? null : { type: id as Anim['type'], duration: cur?.duration ?? 0.6 })
          }
          testPrefix={which}
        />
        {cur && (
          <Slider
            label="長さ"
            value={cur.duration}
            min={0.1}
            max={Math.max(0.2, Math.min(5, clip.duration))}
            step={0.05}
            unit="秒"
            onChange={(v) => setAnim(which, { ...cur, duration: v })}
          />
        )}
      </div>
    );
  };
  return (
    <>
      {block('animIn', '入り（はじまり）', ANIM_IN)}
      {block('animOut', '出（おわり）', ANIM_OUT)}
    </>
  );
}

// ---------- 動画・画像・音楽 ----------

function AudioSection({ clip, project }: { clip: MediaClip; project: Project }) {
  const asset = useEditor((s) => s.assets[clip.assetId]);
  const kind = trackKindOfClip(project, clip);
  const set = (patch: Partial<MediaClip>, key: string) => commit((p) => updateMediaClip(p, clip.id, patch), `${clip.id}:${key}`);
  if (kind === 'video' && clip.audioDetached) {
    return <p className="hint">この動画の音声は分離済みです。下の音声トラックのクリップで調整できます。</p>;
  }
  if (asset?.hasAudio === false) return <p className="hint">この動画には音声が入っていません。</p>;
  const maxFade = Math.max(0.1, Math.min(10, clip.duration / 2));
  return (
    <>
      <Slider label="音量" value={clip.volume} min={0} max={2} display={100} unit="%" reset={1} onChange={(v) => set({ volume: v }, 'vol')} testId="volume" />
      <div className="preset-row" style={{ marginBottom: 14 }}>
        <button className={clip.volume === 0 ? 'on' : ''} onClick={() => set({ volume: clip.volume === 0 ? 1 : 0 }, 'mute')} data-testid="mute">
          {clip.volume === 0 ? '🔇 ミュート中' : '🔈 ミュート'}
        </button>
      </div>
      <Slider label="フェードイン" value={Math.min(clip.fadeIn, maxFade)} min={0} max={maxFade} step={0.05} unit="秒" reset={0} onChange={(v) => set({ fadeIn: v }, 'fi')} testId="fade-in" />
      <Slider label="フェードアウト" value={Math.min(clip.fadeOut, maxFade)} min={0} max={maxFade} step={0.05} unit="秒" reset={0} onChange={(v) => set({ fadeOut: v }, 'fo')} testId="fade-out" />
      {kind === 'video' && asset?.kind === 'video' && (
        <button onClick={detachSelectedAudio} data-testid="detach-audio">
          🎵 音声を分離
        </button>
      )}
    </>
  );
}

const SPEED_PRESETS = [0.25, 0.5, 1, 1.5, 2, 3, 5];

function SpeedSection({ clip }: { clip: MediaClip }) {
  const toSlider = (s: number) => Math.log10(s); // -1〜1
  const set = (speed: number) => commit((p) => setClipSpeed(p, clip.id, Math.round(speed * 100) / 100), `${clip.id}:speed`);
  return (
    <>
      <div className="field">
        <span className="field-label">速度</span>
        <div className="row">
          <input
            type="range"
            min={-1}
            max={1}
            step={0.01}
            value={toSlider(clip.speed)}
            onChange={(e) => set(Math.pow(10, Number(e.target.value)))}
            onDoubleClick={() => set(1)}
            aria-label="速度"
            data-testid="speed"
          />
          <span className="speed-value">{clip.speed.toFixed(2)}x</span>
        </div>
      </div>
      <div className="preset-row" style={{ marginBottom: 14 }}>
        {SPEED_PRESETS.map((s) => (
          <button key={s} className={Math.abs(clip.speed - s) < 0.001 ? 'on' : ''} onClick={() => set(s)} data-testid={`speed-${s}`}>
            {s}x
          </button>
        ))}
      </div>
      <p className="hint">
        長さ: {clip.duration.toFixed(1)} 秒（同じ段の後ろのクリップは自動でずれます）。
        <br />
        音の高さも速度に合わせて変わります。
      </p>
    </>
  );
}

function AdjustSection({ clip }: { clip: MediaClip }) {
  const preset = getFilterPreset(clip.filter.id);
  const setAdj = (key: keyof typeof DEFAULT_ADJUST, v: number) =>
    commit((p) => updateMediaClip(p, clip.id, { adjust: { ...clip.adjust, [key]: v } }), `${clip.id}:adj:${key}`);
  const adj: { key: keyof typeof DEFAULT_ADJUST; label: string; min: number }[] = [
    { key: 'brightness', label: '明るさ', min: -1 },
    { key: 'contrast', label: 'コントラスト', min: -1 },
    { key: 'saturation', label: '彩度', min: -1 },
    { key: 'temperature', label: '色温度（寒い↔暖かい）', min: -1 },
    { key: 'hue', label: '色合い', min: -1 },
    { key: 'vignette', label: '周辺を暗く（ビネット）', min: 0 },
  ];
  return (
    <>
      <div className="field">
        <span className="field-label">フィルター</span>
        <select
          value={clip.filter.id}
          onChange={(e) => commit((p) => updateMediaClip(p, clip.id, { filter: { ...clip.filter, id: e.target.value } }))}
          aria-label="フィルター"
          data-testid="filter-select"
        >
          {FILTER_PRESETS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </div>
      {preset.id !== 'none' && (
        <Slider
          label="フィルターの強さ"
          value={clip.filter.intensity}
          min={0}
          max={1}
          display={100}
          unit="%"
          reset={1}
          onChange={(v) => commit((p) => updateMediaClip(p, clip.id, { filter: { ...clip.filter, intensity: v } }), `${clip.id}:fint`)}
        />
      )}
      {adj.map((a) => (
        <Slider
          key={a.key}
          label={a.label}
          value={clip.adjust[a.key]}
          min={a.min}
          max={1}
          display={100}
          reset={0}
          onChange={(v) => setAdj(a.key, v)}
          testId={`adj-${a.key}`}
        />
      ))}
      <button onClick={() => commit((p) => updateMediaClip(p, clip.id, { adjust: { ...DEFAULT_ADJUST }, filter: { id: 'none', intensity: 1 } }))}>
        色の調整をリセット
      </button>
    </>
  );
}

function ClipInfo({ clip }: { clip: Clip }) {
  const asset = useEditor((s) => (clip.type === 'media' ? s.assets[clip.assetId] : undefined));
  return (
    <div className="field">
      <div className="info-table">
        {asset && (
          <div>
            <span>素材</span>
            {asset.name}
          </div>
        )}
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

type MediaTab = 'basic' | 'audio' | 'speed' | 'anim' | 'adjust';

function MediaInspector({ clip, project }: { clip: MediaClip; project: Project }) {
  const asset = useEditor((s) => s.assets[clip.assetId]);
  const kind = trackKindOfClip(project, clip);
  const visual = kind === 'video';
  const tabs: { id: MediaTab; label: string }[] = visual
    ? [
        { id: 'basic', label: '基本' },
        ...(asset?.kind === 'video' ? [{ id: 'audio' as const, label: '音声' }, { id: 'speed' as const, label: '速度' }] : []),
        { id: 'anim', label: 'アニメ' },
        { id: 'adjust', label: '調整' },
      ]
    : [
        { id: 'audio', label: '音声' },
        { id: 'speed', label: '速度' },
      ];
  const [tab, setTab] = useState<MediaTab>(tabs[0].id);
  const active = tabs.some((t) => t.id === tab) ? tab : tabs[0].id;
  return (
    <>
      <Tabs tabs={tabs} value={active} onChange={setTab} />
      <div className="panel-body">
        {active === 'basic' && <TransformSection clip={clip} project={project} />}
        {active === 'audio' && <AudioSection clip={clip} project={project} />}
        {active === 'speed' && <SpeedSection clip={clip} />}
        {active === 'anim' && <AnimSection clip={clip} />}
        {active === 'adjust' && <AdjustSection clip={clip} />}
        <ClipInfo clip={clip} />
      </div>
    </>
  );
}

// ---------- 文字 ----------

function TextContent({ clip }: { clip: TextClip }) {
  const update = (patch: Partial<TextClip>, key: string) => commit((p) => updateTextClip(p, clip.id, patch), `${clip.id}:${key}`);
  useEffect(() => {
    void ensureFont(clip.fontFamily, clip.bold, clip.text);
  }, [clip.fontFamily, clip.bold, clip.text]);
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
        <span className="field-label">フォント</span>
        <select
          value={clip.fontFamily}
          onChange={(e) => update({ fontFamily: e.target.value }, 'font')}
          style={{ fontFamily: fontStack(clip.fontFamily), width: '100%' }}
          aria-label="フォント"
          data-testid="font-select"
        >
          {FONTS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </div>
      <Slider label="大きさ" value={clip.fontSize} min={16} max={400} step={1} reset={96} onChange={(v) => update({ fontSize: v }, 'fontSize')} testId="font-size" />
      <div className="field">
        <div className="row">
          <div style={{ flex: 1 }}>
            <span className="field-label">文字の色</span>
            <input type="color" value={clip.color} onChange={(e) => update({ color: e.target.value }, 'color')} aria-label="文字の色" data-testid="text-color" />
          </div>
          <div style={{ flex: 2 }}>
            <span className="field-label">形</span>
            <div className="preset-row">
              <button className={clip.bold ? 'on' : ''} onClick={() => update({ bold: !clip.bold }, 'bold')} title="太字">
                <b>B</b>
              </button>
              <button className={clip.italic ? 'on' : ''} onClick={() => update({ italic: !clip.italic }, 'italic')} title="斜体">
                <i>I</i>
              </button>
              {(['left', 'center', 'right'] as const).map((a) => (
                <button key={a} className={clip.align === a ? 'on' : ''} onClick={() => update({ align: a }, 'align')} title={a === 'left' ? '左揃え' : a === 'right' ? '右揃え' : '中央揃え'}>
                  {a === 'left' ? '⇤' : a === 'right' ? '⇥' : '↔'}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
      <Slider label="文字の間隔" value={clip.letterSpacing} min={-20} max={80} step={1} reset={0} onChange={(v) => update({ letterSpacing: v }, 'ls')} />
      <Slider label="行の間隔" value={clip.lineHeight} min={0.8} max={3} step={0.05} reset={1.25} onChange={(v) => update({ lineHeight: v }, 'lh')} />
    </>
  );
}

function TextStyleSection({ clip }: { clip: TextClip }) {
  const update = (patch: Partial<TextClip>, key: string) => commit((p) => updateTextClip(p, clip.id, patch), `${clip.id}:${key}`);
  return (
    <>
      <div className="field">
        <span className="field-label">デザインをまとめて変える</span>
        <div className="preset-row">
          {TEXT_PRESETS.map((p) => (
            <button key={p.id} onClick={() => commit((pr) => updateTextClip(pr, clip.id, { ...DEFAULT_TEXT_STYLE, fontSize: clip.fontSize, ...p.style }))}>
              {p.name}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <span className="field-label">縁取り</span>
        <div className="row">
          <input type="color" value={clip.strokeColor} onChange={(e) => update({ strokeColor: e.target.value }, 'sc')} aria-label="縁取りの色" data-testid="stroke-color" />
          <input type="range" min={0} max={40} value={clip.strokeWidth} onChange={(e) => update({ strokeWidth: Number(e.target.value) }, 'sw')} aria-label="縁取りの太さ" data-testid="stroke-width" />
          <span className="unit">{clip.strokeWidth}</span>
        </div>
      </div>
      <div className="field">
        <span className="field-label">背景</span>
        <div className="row">
          <input type="color" value={clip.bgColor} onChange={(e) => update({ bgColor: e.target.value, bgOpacity: clip.bgOpacity || 0.7 }, 'bgc')} aria-label="背景の色" data-testid="bg-color" />
          <input type="range" min={0} max={1} step={0.01} value={clip.bgOpacity} onChange={(e) => update({ bgOpacity: Number(e.target.value) }, 'bgo')} aria-label="背景の濃さ" data-testid="bg-opacity" />
          <span className="unit">{Math.round(clip.bgOpacity * 100)}%</span>
        </div>
      </div>
      <div className="field">
        <span className="field-label">影</span>
        <div className="row">
          <input type="color" value={clip.shadowColor} onChange={(e) => update({ shadowColor: e.target.value }, 'shc')} aria-label="影の色" />
          <span className="unit">ぼかし</span>
          <input type="range" min={0} max={60} value={clip.shadowBlur} onChange={(e) => update({ shadowBlur: Number(e.target.value) }, 'shb')} aria-label="影のぼかし" data-testid="shadow-blur" />
        </div>
        <div className="row" style={{ marginTop: 6 }}>
          <span className="unit" style={{ width: 'auto' }}>距離</span>
          <input type="range" min={0} max={40} value={clip.shadowDistance} onChange={(e) => update({ shadowDistance: Number(e.target.value) }, 'shd')} aria-label="影の距離" />
        </div>
      </div>
    </>
  );
}

type TextTab = 'text' | 'style' | 'basic' | 'anim';

function TextInspector({ clip, project }: { clip: TextClip; project: Project }) {
  const [tab, setTab] = useState<TextTab>('text');
  return (
    <>
      <Tabs
        tabs={[
          { id: 'text', label: '文字' },
          { id: 'style', label: 'スタイル' },
          { id: 'basic', label: '基本' },
          { id: 'anim', label: 'アニメ' },
        ]}
        value={tab}
        onChange={setTab}
      />
      <div className="panel-body">
        {tab === 'text' && <TextContent clip={clip} />}
        {tab === 'style' && <TextStyleSection clip={clip} />}
        {tab === 'basic' && <TransformSection clip={clip} project={project} />}
        {tab === 'anim' && <AnimSection clip={clip} />}
        <ClipInfo clip={clip} />
      </div>
    </>
  );
}

// ---------- 切り替え効果 ----------

function TransitionInspector({ clipId, project }: { clipId: string; project: Project }) {
  const clip = getClip(project, clipId);
  const eff = clip ? effectiveTransition(project, clip) : null;
  if (!clip) return null;
  const cur = clip.transitionIn;
  const maxD = eff ? Math.max(0.1, Math.min(3, eff.prev.duration, clip.duration)) : 2;
  return (
    <div className="panel-body">
      <ChoiceGrid
        items={[{ id: 'none', label: 'なし' }, ...TRANSITIONS.map((t) => ({ id: t.type, label: `${t.icon} ${t.name}` }))]}
        value={cur?.type ?? 'none'}
        onChange={(id) =>
          commit((p) => setTransition(p, clipId, id === 'none' ? null : { type: id as NonNullable<Clip['transitionIn']>['type'], duration: cur?.duration ?? 0.8 }))
        }
        testPrefix="trans"
      />
      {cur && (
        <Slider
          label="長さ"
          value={Math.min(cur.duration, maxD)}
          min={0.1}
          max={maxD}
          step={0.05}
          unit="秒"
          onChange={(v) => commit((p) => setTransition(p, clipId, { ...cur, duration: v }), `${clipId}:trd`)}
          testId="transition-duration"
        />
      )}
      {!eff && cur && <p className="hint">クリップが離れているため、今は効果が出ません。すき間なく並べてください。</p>}
      <button className="danger" onClick={() => commit((p) => setTransition(p, clipId, null))}>
        🗑 切り替え効果を外す
      </button>
    </div>
  );
}

// ---------- 何も選んでいないとき（プロジェクトの設定） ----------

function ProjectSettings({ project }: { project: Project }) {
  const s = project.settings;
  const bg = s.background;
  const setBg = (b: typeof bg, key?: string) => commit((p) => ({ ...p, settings: { ...p.settings, background: b } }), key);
  return (
    <div className="panel-body">
      <div className="field">
        <span className="field-label">画面比率</span>
        <div className="ratio-grid">
          {RATIOS.map((r) => (
            <button
              key={r.id}
              className={`ratio-btn${s.ratio === r.id ? ' active' : ''}`}
              onClick={() => commit((p) => setRatio(p, r.id))}
              title={r.hint}
              data-testid={`ratio-${r.id}`}
            >
              <span className="ratio-shape" style={{ aspectRatio: `${r.w} / ${r.h}` }} />
              <b>{r.label}</b>
              <small>{r.hint}</small>
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <span className="field-label">背景（映像がない部分）</span>
        <div className="preset-row">
          <button className={bg.type === 'color' && bg.color === '#000000' ? 'on' : ''} onClick={() => setBg({ type: 'color', color: '#000000' })}>
            黒
          </button>
          <button className={bg.type === 'color' && bg.color === '#ffffff' ? 'on' : ''} onClick={() => setBg({ type: 'color', color: '#ffffff' })}>
            白
          </button>
          <button className={bg.type === 'blur' ? 'on' : ''} onClick={() => setBg({ type: 'blur', amount: 40 })} data-testid="bg-blur">
            ぼかし
          </button>
          <label className="row" style={{ gap: 6 }}>
            色
            <input
              type="color"
              value={bg.type === 'color' ? bg.color : '#000000'}
              onChange={(e) => setBg({ type: 'color', color: e.target.value }, 'bgcolor')}
              aria-label="背景の色"
            />
          </label>
        </div>
        {bg.type === 'blur' && (
          <Slider label="ぼかしの強さ" value={bg.amount} min={5} max={100} step={1} reset={40} onChange={(v) => setBg({ type: 'blur', amount: v }, 'bgblur')} />
        )}
      </div>
      <div className="hint">
        <b>使い方</b>
        <br />
        ・素材をタイムラインへドラッグ、または「＋追加」
        <br />
        ・プレビューの絵をクリックして選び、ドラッグで移動・角で大きさ・上の丸で回転
        <br />
        ・クリップの両端をつまんで長さを変更、右クリックでメニュー
        <br />
        ・つなぎ目の「⇄」で切り替え効果
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
        <kbd>Ctrl</kbd>+<kbd>C</kbd> コピー / <kbd>Ctrl</kbd>+<kbd>V</kbd> 貼り付け / <kbd>Ctrl</kbd>+<kbd>D</kbd> 複製
        <br />
        <kbd>←</kbd> <kbd>→</kbd> 1コマ移動
        <br />
        <kbd>Ctrl</kbd>+マウスホイール タイムラインの拡大・縮小
      </div>
    </div>
  );
}

export function Inspector() {
  const project = useEditor((s) => s.project);
  const selectedId = useEditor((s) => s.selectedClipId);
  const transId = useEditor((s) => s.selectedTransitionClipId);
  const clip = selectedId ? getClip(project, selectedId) : undefined;
  const title = transId
    ? '切り替え効果'
    : clip?.type === 'text'
      ? '文字の設定'
      : clip
        ? 'クリップの設定'
        : 'プロジェクトの設定';
  return (
    <section className="panel right-panel">
      <div className="panel-title">
        {title}
        {transId && (
          <button className="link" onClick={() => selectTransition(null)}>
            閉じる
          </button>
        )}
      </div>
      {transId && <TransitionInspector clipId={transId} project={project} />}
      {!transId && clip?.type === 'text' && <TextInspector key={clip.id} clip={clip} project={project} />}
      {!transId && clip?.type === 'media' && <MediaInspector key={clip.id} clip={clip} project={project} />}
      {!transId && !clip && <ProjectSettings project={project} />}
    </section>
  );
}
