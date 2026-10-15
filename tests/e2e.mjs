// 実際のブラウザで「読み込み → 分割 → 文字入れ → 書き出し」を通して確かめるテスト。
//   npm run build && node tests/e2e.mjs
// H.264 / AAC を使うには Google Chrome（または Chrome for Testing）が必要。
//   CHROME_PATH=/path/to/chrome node tests/e2e.mjs
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = join(root, 'tests/.fixtures');
const outDir = join(root, 'tests/output');
mkdirSync(fixtures, { recursive: true });
mkdirSync(outDir, { recursive: true });

const chromePath = process.env.CHROME_PATH;
const useH264 = !!chromePath;

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
}

// テスト用の素材を作る
const videoFile = join(fixtures, useH264 ? 'sample-video.mp4' : 'sample-video.webm');
if (!existsSync(videoFile)) {
  const codec = useH264
    ? ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k']
    : ['-c:v', 'libvpx-vp9', '-b:v', '1M', '-c:a', 'libopus'];
  ffmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '6', ...codec, '-shortest', videoFile,
  ]);
}
const imageFile = join(fixtures, 'sample-image.png');
if (!existsSync(imageFile)) {
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=orange:size=800x800', '-frames:v', '1', imageFile]);
}
const audioFile = join(fixtures, 'sample-audio.mp3');
if (!existsSync(audioFile)) {
  ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=44100', '-t', '4', '-c:a', 'libmp3lame', audioFile]);
}

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`  OK   ${msg}`);
  else {
    console.log(`  FAIL ${msg}`);
    failures++;
  }
}

// 組み立て済みのアプリを配信する
const port = 4180;
const server = spawn(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(port), '--strictPort'], {
  cwd: root,
  stdio: 'pipe',
});
server.stderr.on('data', (d) => process.stderr.write(d));
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('preview server did not start')), 20000);
  server.stdout.on('data', (d) => {
    if (String(d).includes(String(port))) {
      clearTimeout(timer);
      resolve();
    }
  });
});

const browser = await chromium.launch({
  executablePath: chromePath,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(String(e)));

try {
  await page.goto(`http://localhost:${port}/video-editor/`);
  await page.waitForSelector('[data-testid=import-button]');
  console.log('1. 読み込み');
  await page.setInputFiles('[data-testid=file-input]', [videoFile, imageFile, audioFile]);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=media-add]').length === 3, null, { timeout: 30000 });
  check(true, 'ボタンから動画・画像・音楽の3つを読み込めた');
  // パソコンからファイルを画面にドラッグ＆ドロップしたときと同じ操作
  const pngBase64 = readFileSync(imageFile).toString('base64');
  await page.evaluate(async (b64) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bin], 'dropped.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const target = document.querySelector('.app');
    for (const type of ['dragenter', 'dragover', 'drop']) {
      target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    }
  }, pngBase64);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=media-add]').length === 4, null, { timeout: 15000 });
  check(true, 'ドラッグ＆ドロップでも読み込めた');
  await page.screenshot({ path: join(outDir, '01-imported.png') });

  console.log('2. タイムラインに並べる');
  const adds = page.locator('[data-testid=media-add]');
  await adds.nth(0).click();
  await adds.nth(1).click();
  await adds.nth(2).click();
  await page.waitForTimeout(300);
  const timeText = async () => (await page.locator('[data-testid=time]').innerText()).replace(/\s+/g, ' ');
  check((await timeText()).includes('/ 00:11.0'), `全体の長さが 11 秒（${await timeText()}）`);
  check((await page.locator('[data-testid=clip]').count()) === 3, 'クリップが3つ並んだ');

  console.log('3. 再生位置を 2 秒へ（目盛りをクリック）');
  const ruler = await page.locator('[data-testid=ruler]').boundingBox();
  await page.mouse.click(ruler.x + 2 * 60 + 0.5, ruler.y + 14);
  await page.waitForTimeout(200);
  check((await timeText()).startsWith('00:02.0'), `再生位置が 2 秒（${await timeText()}）`);

  console.log('4. 分割');
  await page.locator('[data-clip-type=video]').first().click({ position: { x: 30, y: 30 } });
  // クリックで再生位置が変わらないことも確認
  check((await timeText()).startsWith('00:02.0'), 'クリップを選んでも再生位置はそのまま');
  await page.locator('[data-testid=split]').click();
  await page.waitForTimeout(200);
  check((await page.locator('[data-clip-type=video]').count()) === 3, '動画が2つに分かれた（映像トラックのクリップが3つ）');

  console.log('5. 元に戻す・やり直し');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(100);
  check((await page.locator('[data-clip-type=video]').count()) === 2, 'Ctrl+Z で分割前に戻った');
  await page.keyboard.press('Control+y');
  await page.waitForTimeout(100);
  check((await page.locator('[data-clip-type=video]').count()) === 3, 'Ctrl+Y で分割をやり直した');

  console.log('6. 端をつまんで長さを変える（画像を 5 秒 → 4 秒）');
  const imageClip = page.locator('[data-clip-type=video]').nth(2);
  const handle = await imageClip.locator('[data-testid=handle-right]').boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 - 30, handle.y + handle.height / 2, { steps: 4 });
  await page.mouse.move(handle.x + handle.width / 2 - 60, handle.y + handle.height / 2, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  check((await timeText()).includes('/ 00:10.0'), `全体の長さが 10 秒になった（${await timeText()}）`);

  console.log('7. ドラッグで動かす（音楽を 1 秒右へ）');
  const audioClip = page.locator('[data-clip-type=audio]').first();
  const ab = await audioClip.boundingBox();
  await page.mouse.move(ab.x + ab.width / 2, ab.y + ab.height / 2);
  await page.mouse.down();
  await page.mouse.move(ab.x + ab.width / 2 + 30, ab.y + ab.height / 2, { steps: 4 });
  await page.mouse.move(ab.x + ab.width / 2 + 60, ab.y + ab.height / 2, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const audioLeft = await audioClip.evaluate((el) => el.style.left);
  check(audioLeft === '60px', `音楽が 1 秒の位置へ動いた（left=${audioLeft}）`);

  console.log('8. 拡大・縮小');
  const widthBefore = (await audioClip.boundingBox()).width;
  await page.locator('[data-testid=zoom-in]').click();
  await page.waitForTimeout(150);
  const widthAfter = (await audioClip.boundingBox()).width;
  check(widthAfter > widthBefore * 1.3, `拡大でクリップが広がった（${widthBefore.toFixed(0)} → ${widthAfter.toFixed(0)}px）`);
  await page.locator('[data-testid=zoom-out]').click();
  await page.waitForTimeout(150);

  console.log('8b. 止めた状態で場面を切り替える');
  const canvasSig = () =>
    page.evaluate(() => {
      const c = document.querySelector('[data-testid=preview-canvas]');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let h = 0;
      for (let i = 0; i < d.length; i += 997) h = (h * 31 + d[i]) >>> 0;
      return h;
    });
  const seekTo = async (sec) => {
    const r = await page.locator('[data-testid=ruler]').boundingBox();
    await page.mouse.click(r.x + sec * 60 + 0.5, r.y + 14);
    await page.waitForTimeout(500);
  };
  await seekTo(1);
  const sigA = await canvasSig();
  await seekTo(1.5);
  const sigB = await canvasSig();
  await seekTo(1);
  const sigC = await canvasSig();
  check(sigA !== sigB, 'プレビューの絵が再生位置に合わせて変わる');
  check(sigA === sigC, '同じ位置に戻すと同じ絵になる');

  console.log('8c. 素材を直接タイムラインへドラッグ・削除');
  const before = await page.locator('[data-testid=clip]').count();
  const videoRow = await page.locator('[data-testid=track-video]').boundingBox();
  await page.locator('[data-testid=media-item]').nth(3).dragTo(page.locator('[data-testid=track-video]'), {
    targetPosition: { x: 12 * 60, y: videoRow.height / 2 },
  });
  await page.waitForTimeout(200);
  check((await page.locator('[data-testid=clip]').count()) === before + 1, '素材をタイムラインへドラッグして置けた');
  check((await timeText()).includes('/ 00:17.0'), `12 秒の位置に置かれた（${await timeText()}）`);
  await page.keyboard.press('Delete');
  await page.waitForTimeout(200);
  check((await page.locator('[data-testid=clip]').count()) === before, 'Delete キーで削除できた');
  check((await timeText()).includes('/ 00:10.0'), '削除後の長さが元に戻った');
  // 動画がある時間（1 秒）に画像をドラッグ → 新しい映像の段ができて、同じ時間に置ける
  await page.locator('[data-testid=media-item]').nth(3).dragTo(page.locator('[data-testid=track-video]').first(), {
    targetPosition: { x: 1 * 60, y: videoRow.height / 2 },
  });
  await page.waitForTimeout(200);
  check((await page.locator('[data-testid=track-video]').count()) === 2, '埋まっている時間に置くと映像の段が自動で増えた');
  const overlay = page.locator('[data-clip-id].selected');
  check((await overlay.evaluate((el) => el.style.left)) === '60px', '置いた画像は 1 秒の位置のまま');
  await page.keyboard.press('Delete');
  await page.waitForTimeout(200);
  check((await page.locator('[data-testid=clip]').count()) === before, '重ねた画像を削除できた');

  console.log('9. 文字入れ（7 秒の位置、画像の上）');
  const ruler2 = await page.locator('[data-testid=ruler]').boundingBox();
  await page.mouse.click(ruler2.x + 7 * 60 + 0.5, ruler2.y + 14);
  await page.waitForTimeout(200);
  check((await timeText()).startsWith('00:07.0'), `再生位置が 7 秒（${await timeText()}）`);
  const countYellow = () =>
    page.evaluate(() => {
      const c = document.querySelector('[data-testid=preview-canvas]');
      const ctx = c.getContext('2d');
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 230 && d[i + 1] > 210 && d[i + 2] < 60) n++;
      return n;
    });
  await page.locator('[data-testid=add-text]').click();
  await page.locator('[data-testid=text-input]').fill('テスト字幕 Hello');
  await page.locator('[data-testid=font-size]').fill('140');
  await page.waitForTimeout(200);
  // 文字の位置をドラッグで動かす
  const box = await page.locator('[data-testid=text-box]').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 100, { steps: 5 });
  await page.mouse.up();
  const box2 = await page.locator('[data-testid=text-box]').boundingBox();
  check(box2.y < box.y - 50, `文字をドラッグで上へ動かせた（${box.y.toFixed(0)} → ${box2.y.toFixed(0)}）`);
  const yellowBefore = await countYellow();
  await page.locator('[data-testid=text-color]').fill('#ffee00');
  await page.waitForTimeout(400);
  check((await page.locator('[data-clip-type=text]').count()) === 1, '文字クリップができた');
  // プレビューに黄色い文字が描かれているか
  const yellow = await countYellow();
  check(yellow > yellowBefore + 1000, `プレビューの文字が黄色になった（黄色の画素 ${yellowBefore} → ${yellow}）`);

  console.log('9b. 同じ時間に2つめの文字・2つめの音楽');
  await page.locator('[data-testid=add-text]').click();
  await page.locator('[data-testid=text-input]').fill('2つめの文字');
  await page.waitForTimeout(200);
  const textClips = page.locator('[data-clip-type=text]');
  check((await textClips.count()) === 2, '文字クリップが2つになった');
  check((await page.locator('[data-testid=track-text]').count()) === 2, '文字の段が自動で2つになった');
  const lefts = await textClips.evaluateAll((els) => els.map((el) => el.style.left));
  check(lefts[0] === lefts[1] && lefts[0] === '420px', `2つの文字が同じ 7 秒の位置にある（${lefts.join(', ')}）`);
  check((await page.locator('[data-testid=text-box]').count()) === 2, 'プレビューに2つの文字が同時に出ている');
  const ruler3 = await page.locator('[data-testid=ruler]').boundingBox();
  await page.mouse.click(ruler3.x + 2 * 60 + 0.5, ruler3.y + 14);
  await page.waitForTimeout(200);
  await page.locator('[data-testid=media-add]').nth(2).click();
  await page.waitForTimeout(200);
  check((await page.locator('[data-testid=track-audio]').count()) === 2, '音声の段が自動で2つになった');
  const audioLefts = await page.locator('[data-clip-type=audio]').evaluateAll((els) => els.map((el) => el.style.left).sort());
  check(audioLefts.join(',') === '120px,60px', `音楽が 1 秒と 2 秒に重ねて置けた（${audioLefts.join(', ')}）`);
  check((await timeText()).includes('/ 00:10.0'), '全体の長さは 10 秒のまま');
  await page.screenshot({ path: join(outDir, '02-edited.png') });

  console.log('10. 再生・一時停止');
  const toSec = (txt) => Number(txt.slice(0, 2)) * 60 + Number(txt.slice(3, 7));
  const beforePlay = toSec(await timeText());
  await page.locator('[data-testid=play]').click();
  await page.waitForTimeout(1500);
  await page.locator('[data-testid=play]').click();
  const afterPlay = await timeText();
  const advanced = toSec(afterPlay) - beforePlay;
  check(advanced > 1.0 && advanced < 2.5, `再生して止めると時間が進んでいる（${advanced.toFixed(1)} 秒進んだ）`);
  await page.waitForTimeout(500);
  check((await timeText()) === afterPlay, '一時停止すると時間が止まる');
  await page.screenshot({ path: join(outDir, '03-after-play.png') });

  console.log('11. 書き出し');
  await page.locator('[data-testid=export-open]').click();
  const downloadPromise = page.waitForEvent('download', { timeout: 300000 });
  const started = Date.now();
  await page.locator('[data-testid=export-start]').click();
  const seen = new Set();
  const poll = setInterval(async () => {
    try {
      const t = await page.locator('[data-testid=export-percent]').innerText({ timeout: 200 });
      seen.add(t);
    } catch {
      /* 表示が変わった */
    }
  }, 300);
  let download;
  try {
    download = await downloadPromise;
  } finally {
    clearInterval(poll);
  }
  const outFile = join(outDir, 'export.mp4');
  await download.saveAs(outFile);
  console.log(`  書き出し時間 ${((Date.now() - started) / 1000).toFixed(1)} 秒、表示された進み具合: ${[...seen].join(', ')}`);
  check(seen.size >= 2, '進み具合が表示された');
  await page.screenshot({ path: join(outDir, '04-exported.png') });

  console.log('12. ffprobe で確認');
  const probe = JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', outFile]).toString(),
  );
  const v = probe.streams.find((s) => s.codec_type === 'video');
  const a = probe.streams.find((s) => s.codec_type === 'audio');
  const dur = Number(probe.format.duration);
  console.log(`  映像: ${v?.codec_name} ${v?.width}x${v?.height} ${v?.avg_frame_rate} / 音声: ${a?.codec_name} ${a?.sample_rate}Hz ${a?.channels}ch / 長さ ${dur}s`);
  check(v && v.width === 1920 && v.height === 1080, '解像度 1920x1080');
  check(v && (v.avg_frame_rate === '30/1' || v.r_frame_rate === '30/1'), 'フレームレート 30fps');
  check(Math.abs(dur - 10) < 0.15, `長さが約 10 秒（${dur}）`);
  check(!!a, '音声が入っている');
  if (useH264) {
    check(v?.codec_name === 'h264', '映像は H.264');
    check(a?.codec_name === 'aac', '音声は AAC');
  }
  const nb = execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', outFile]).toString().trim();
  check(Number(nb) === 300, `フレーム数 300（${nb}）`);
  // 音が鳴っているか（無音でないか）
  const volLog = execFileSync('sh', ['-c', `ffmpeg -hide_banner -i "${outFile}" -af volumedetect -vn -f null - 2>&1 | grep mean_volume || true`]).toString();
  const mean = Number((volLog.match(/mean_volume: (-?[\d.]+)/) || [])[1]);
  check(isFinite(mean) && mean > -40, `音声が無音ではない（平均 ${mean} dB）`);
  const frameAt = (sec) =>
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(sec), '-i', outFile, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 * 1024 * 1024 });
  const px = (raw, x, y) => {
    const i = (y * 1920 + x) * 3;
    return [raw[i], raw[i + 1], raw[i + 2]];
  };
  // 8 秒の場面: 画像（オレンジ）の上に黄色い文字
  const raw8 = frameAt(8);
  const orange = px(raw8, 960, 150);
  check(orange[0] > 200 && orange[1] > 120 && orange[1] < 200 && orange[2] < 60, `8 秒目に画像が映っている（色 ${orange}）`);
  let ycount = 0;
  for (let i = 0; i < raw8.length; i += 3) if (raw8[i] > 220 && raw8[i + 1] > 215 && raw8[i + 2] < 90) ycount++;
  check(ycount > 3000, `8 秒目に黄色い文字が入っている（${ycount} 画素）`);
  let wcount = 0;
  for (let y = 810; y < 970; y++) {
    for (let x = 0; x < 1920; x++) {
      const i = (y * 1920 + x) * 3;
      if (raw8[i] > 235 && raw8[i + 1] > 235 && raw8[i + 2] > 235) wcount++;
    }
  }
  check(wcount > 2000, `8 秒目に2つめの白い文字も同時に入っている（${wcount} 画素）`);
  // 3 秒の場面: 動画（真っ黒ではない）、文字はまだない
  const raw3 = frameAt(3);
  let bright = 0;
  for (let i = 0; i < raw3.length; i += 3) bright += raw3[i] + raw3[i + 1] + raw3[i + 2];
  check(bright / (raw3.length / 3) > 150, '3 秒目に動画が映っている');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '3', '-i', outFile, '-frames:v', '1', join(outDir, 'export-frame-3s.png')]);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '8', '-i', outFile, '-frames:v', '1', join(outDir, 'export-frame-8s.png')]);

  const relevantErrors = consoleErrors.filter((e) => !/favicon/i.test(e));
  check(relevantErrors.length === 0, `ブラウザのエラーなし${relevantErrors.length ? '：' + relevantErrors.join(' | ') : ''}`);
} catch (e) {
  console.error(e);
  failures++;
  await page.screenshot({ path: join(outDir, 'error.png') }).catch(() => {});
} finally {
  await browser.close();
  server.kill();
}

console.log(failures ? `\n${failures} 件の失敗` : '\nすべて成功');
process.exit(failures ? 1 : 0);
