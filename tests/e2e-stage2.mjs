// 段階2の機能を実際のブラウザで確かめるテスト。
//   npm run build && CHROME_PATH=/path/to/chrome node tests/e2e-stage2.mjs
// 縦動画(9:16)・背景ぼかし・速度・切り替え効果・フィルター・音声の分離・文字のデザイン/フォント/アニメ・
// プレビューでの拡大/回転・コピー貼り付け・自動保存・書き出し設定(720p)
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
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
const videoFile = join(fixtures, useH264 ? 'sample-video.mp4' : 'sample-video.webm');
if (!existsSync(videoFile)) {
  const codec = useH264
    ? ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k']
    : ['-c:v', 'libvpx-vp9', '-b:v', '1M', '-c:a', 'libopus'];
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '6', ...codec, '-shortest', videoFile]);
}
const imageFile = join(fixtures, 'sample-image.png');
if (!existsSync(imageFile)) ffmpeg(['-f', 'lavfi', '-i', 'color=c=orange:size=800x800', '-frames:v', '1', imageFile]);

let failures = 0;
function check(cond, msg) {
  console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${msg}`);
  if (!cond) failures++;
}

const port = 4190;
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

const browser = await chromium.launch({ executablePath: chromePath, args: ['--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
page.on('pageerror', (e) => consoleErrors.push(String(e)));
page.on('dialog', (d) => d.accept());

const timeText = async () => (await page.locator('[data-testid=time]').innerText()).replace(/\s+/g, ' ');
const seek = async (sec) => {
  const r = await page.locator('[data-testid=ruler]').boundingBox();
  const z = await page.evaluate(() => {
    // 目盛りの 1 秒あたりの幅を、拡大率のつまみから求める代わりに既定値 60 を使う
    return 60;
  });
  await page.mouse.click(r.x + sec * z + 0.5, r.y + 14);
  await page.waitForTimeout(250);
};
const clickClip = async (locator) => {
  const b = await locator.boundingBox();
  await page.mouse.click(b.x + Math.min(30, b.width / 2), b.y + b.height / 2);
  await page.waitForTimeout(150);
};
const dragBy = async (locator, dx, dy) => {
  const b = await locator.boundingBox();
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 });
  await page.mouse.move(x + dx, y + dy, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(200);
};

try {
  await page.goto(`http://localhost:${port}/video-editor/`);
  await page.waitForSelector('[data-testid=import-button]');

  console.log('1. 画面比率 9:16（縦動画）');
  await page.locator('[data-testid="ratio-9:16"]').click();
  await page.waitForTimeout(200);
  const cs = await page.evaluate(() => {
    const c = document.querySelector('[data-testid=preview-canvas]');
    return [c.width, c.height];
  });
  check(cs[0] === 720 && cs[1] === 1280, `プレビューが縦長になった（${cs.join('x')}）`);

  console.log('2. 読み込みと配置');
  await page.setInputFiles('[data-testid=file-input]', [videoFile, imageFile]);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=media-add]').length === 2, null, { timeout: 30000 });
  await page.waitForTimeout(800);
  await page.locator('[data-testid=media-add]').nth(0).click();
  await page.locator('[data-testid=media-add]').nth(1).click();
  await page.waitForTimeout(200);
  check((await timeText()).includes('/ 00:11.0'), `動画6秒＋画像5秒が並んだ（${await timeText()}）`);

  console.log('3. 背景をぼかしに');
  await page.keyboard.press('Escape');
  await page.locator('[data-testid=bg-blur]').click();
  check(await page.locator('[data-testid=bg-blur]').evaluate((el) => el.classList.contains('on')), '背景「ぼかし」が選ばれた');

  console.log('4. 速度 2 倍');
  const videoClip = page.locator('[data-clip-type=video]').nth(0);
  await clickClip(videoClip);
  await page.locator('[data-testid=insp-tab-speed]').click();
  await page.locator('[data-testid=speed-2]').click();
  await page.waitForTimeout(200);
  check((await timeText()).includes('/ 00:08.0'), `動画が3秒になり、後ろの画像が詰まった（${await timeText()}）`);

  console.log('5. 切り替え効果');
  check((await page.locator('[data-testid=junction]').count()) === 1, 'つなぎ目のボタンが出ている');
  await page.locator('[data-testid=junction]').click();
  await page.locator('[data-testid=left-tab-transition]').click();
  await page.locator('[data-testid=transition-fade]').click();
  await page.waitForTimeout(150);
  check(await page.locator('[data-testid=junction]').evaluate((el) => el.classList.contains('has')), 'つなぎ目にクロスフェードが付いた');
  check((await page.locator('[data-testid=transition-duration]').count()) === 1, '切り替え効果の長さを変えられる');

  console.log('6. フィルター（画像をモノクロに）');
  const imageClip = page.locator('[data-clip-type=video]').nth(1);
  await clickClip(imageClip);
  await page.locator('[data-testid=left-tab-filter]').click();
  await page.locator('[data-testid=filter-mono]').click();
  await page.waitForTimeout(150);
  check((await imageClip.innerText()).includes('🎨'), '画像クリップにフィルターの印が付いた');

  console.log('7. 音声の分離');
  await clickClip(videoClip);
  await page.locator('[data-testid=insp-tab-audio]').click();
  await page.locator('[data-testid=detach-audio]').click();
  await page.waitForTimeout(200);
  check((await page.locator('[data-clip-type=audio]').count()) === 1, '音声トラックに音声クリップができた');

  console.log('8. 文字（デザイン・フォント・アニメ）');
  await seek(4);
  check((await timeText()).startsWith('00:04.0'), `再生位置 4 秒（${await timeText()}）`);
  await page.locator('[data-testid=left-tab-text]').click();
  await page.locator('[data-testid=text-preset-yellow]').click();
  await page.locator('[data-testid=text-input]').fill('縦動画テスト');
  await page.locator('[data-testid=font-select]').selectOption('dela');
  const fontOk = await page
    .waitForFunction(() => document.fonts.check("48px 'Dela Gothic One'", '縦動画テスト') && [...document.fonts].some((f) => f.family.includes('Dela') && f.status === 'loaded'), null, { timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  check(fontOk, 'Google Fonts の「Dela Gothic One」を読み込めた');
  await page.locator('[data-testid=insp-tab-anim]').click();
  await page.locator('[data-testid=animIn-fade]').click();
  check((await page.locator('[data-clip-type=text]').count()) === 1, '文字クリップができた');

  console.log('9. プレビューで拡大・回転（そのあと元に戻す）');
  await seek(1);
  await clickClip(videoClip);
  await page.waitForTimeout(200);
  check((await page.locator('[data-testid=media-box]').count()) === 1, '選んだ動画に枠が出た');
  await dragBy(page.locator('[data-testid=handle-scale-se]'), 60, 40);
  await page.locator('[data-testid=insp-tab-basic]').click();
  const scaled = Number(await page.locator('[data-testid=tr-scale-num]').inputValue());
  check(scaled > 110, `角をドラッグして大きくなった（${scaled}%）`);
  await dragBy(page.locator('[data-testid=handle-rotate]'), 80, 30);
  const rot = Number(await page.locator('[data-testid=tr-rot-num]').inputValue());
  check(Math.abs(rot) > 5, `上の丸をドラッグして回転した（${rot}°）`);
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(150);
  check(Number(await page.locator('[data-testid=tr-scale-num]').inputValue()) === 100, '元に戻すで大きさが 100% に戻った');
  check(Number(await page.locator('[data-testid=tr-rot-num]').inputValue()) === 0, '元に戻すで回転が 0° に戻った');

  console.log('10. コピー・貼り付け');
  const textClip = page.locator('[data-clip-type=text]').first();
  await clickClip(textClip);
  await page.keyboard.press('Control+c');
  await seek(0.5);
  await page.keyboard.press('Control+v');
  await page.waitForTimeout(150);
  check((await page.locator('[data-clip-type=text]').count()) === 2, 'Ctrl+V で文字が増えた');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(150);
  check((await page.locator('[data-clip-type=text]').count()) === 1, 'Ctrl+Z で貼り付けを取り消した');
  // 右クリックのメニュー
  await textClip.click({ button: 'right' });
  check((await page.locator('[data-testid=context-menu]').count()) === 1, '右クリックでメニューが出た');
  await page.keyboard.press('Escape');

  console.log('11. 自動保存（ページを開き直しても残る）');
  await page.waitForFunction(() => document.querySelector('[data-testid=save-state]')?.textContent?.includes('保存済み'), null, { timeout: 10000 });
  const before = await page.locator('[data-testid=clip]').count();
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=media-add]').length === 2, null, { timeout: 30000 });
  await page.waitForTimeout(1000);
  check((await page.locator('[data-testid=clip]').count()) === before, `クリップが ${before} 個とも復元された`);
  check((await timeText()).includes('/ 00:08.0'), `長さも復元された（${await timeText()}）`);
  const cs2 = await page.evaluate(() => {
    const c = document.querySelector('[data-testid=preview-canvas]');
    return [c.width, c.height];
  });
  check(cs2[0] === 720 && cs2[1] === 1280, '画面比率 9:16 も復元された');
  await page.screenshot({ path: join(outDir, 's2-01-restored.png') });

  console.log('12. 書き出し（720p）');
  await page.locator('[data-testid=export-open]').click();
  await page.locator('[data-testid=export-resolution]').selectOption('720');
  const downloadPromise = page.waitForEvent('download', { timeout: 300000 });
  await page.locator('[data-testid=export-start]').click();
  const download = await downloadPromise;
  const outFile = join(outDir, 'export-stage2.mp4');
  await download.saveAs(outFile);
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', outFile]).toString());
  const v = probe.streams.find((s) => s.codec_type === 'video');
  const a = probe.streams.find((s) => s.codec_type === 'audio');
  const dur = Number(probe.format.duration);
  console.log(`  映像: ${v?.codec_name} ${v?.width}x${v?.height} ${v?.avg_frame_rate} / 音声: ${a?.codec_name} / 長さ ${dur}s`);
  check(v?.width === 720 && v?.height === 1280, '縦長 720x1280 で書き出せた');
  check(Math.abs(dur - 8) < 0.15, `長さ約 8 秒（${dur}）`);
  check(!!a, '音声が入っている');
  const volLog = execFileSync('sh', ['-c', `ffmpeg -hide_banner -i "${outFile}" -af volumedetect -vn -f null - 2>&1 | grep mean_volume || true`]).toString();
  const mean = Number((volLog.match(/mean_volume: (-?[\d.]+)/) || [])[1]);
  check(isFinite(mean) && mean > -40, `分離した音声が鳴っている（平均 ${mean} dB）`);

  const W = 720;
  const frameAt = (sec) =>
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(sec), '-i', outFile, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 * 1024 * 1024 });
  const px = (raw, x, y) => {
    const i = (y * W + x) * 3;
    return [raw[i], raw[i + 1], raw[i + 2]];
  };
  const f1 = frameAt(1);
  const top = px(f1, 360, 120);
  check(top[0] + top[1] + top[2] > 60, `1 秒目: 上の余白がぼかした映像で埋まっている（色 ${top}）`);
  const f6 = frameAt(6);
  const c6 = px(f6, 360, 640);
  check(Math.abs(c6[0] - c6[1]) < 25 && Math.abs(c6[1] - c6[2]) < 25 && c6[0] > 70, `6 秒目: 画像がモノクロになっている（色 ${c6}）`);
  const yellowIn = (raw) => {
    let n = 0;
    for (let i = 0; i < raw.length; i += 3) if (raw[i] > 220 && raw[i + 1] > 200 && raw[i + 2] < 90) n++;
    return n;
  };
  const y6 = yellowIn(f6);
  const y4 = yellowIn(frameAt(4.0));
  check(y6 > 1500, `6 秒目: 黄色い文字が入っている（${y6} 画素）`);
  check(y4 < y6 / 4, `4 秒目: 文字はフェードインの途中で薄い（${y4} 画素）`);
  const dist = (p, q) => Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]);
  const m25 = px(frameAt(2.4), 360, 640);
  const m30 = px(frameAt(3.0), 360, 640);
  const m36 = px(frameAt(3.6), 360, 640);
  check(dist(m30, m25) > 15 && dist(m30, m36) > 15, `3 秒目: 動画と画像が混ざっている（${m25} / ${m30} / ${m36}）`);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '6', '-i', outFile, '-frames:v', '1', join(outDir, 'export-stage2-6s.png')]);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '1', '-i', outFile, '-frames:v', '1', join(outDir, 'export-stage2-1s.png')]);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '3', '-i', outFile, '-frames:v', '1', join(outDir, 'export-stage2-3s.png')]);

  const relevantErrors = consoleErrors.filter((e) => !/favicon/i.test(e));
  check(relevantErrors.length === 0, `ブラウザのエラーなし${relevantErrors.length ? '：' + relevantErrors.join(' | ') : ''}`);
} catch (e) {
  console.error(e);
  failures++;
  await page.screenshot({ path: join(outDir, 's2-error.png') }).catch(() => {});
} finally {
  await browser.close();
  server.kill();
}

console.log(failures ? `\n${failures} 件の失敗` : '\nすべて成功');
process.exit(failures ? 1 : 0);
