// 把 scene.html 逐帧渲染成 README 用的演示视频，配上晓晓的旁白。
//
//   node scripts/demo-video/render.mjs                 输出 attachments/演示视频.mp4
//   node scripts/demo-video/render.mjs --still 3,9.5   只截这几个时间点（成片时间），输出到 out/demo-stills/
//
// 旁白用 edge-tts 合成：字幕文字会发到微软的语音服务。合成结果按文字缓存在 out/narration/，
// 字幕不改就不会重复请求。需要本机装有 uv（用 uvx 临时运行 edge-tts）和 ffmpeg。
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { ROOT, withScene } from "../lib/headless-chrome.mjs";

const OUT_DIR = path.join(ROOT, "out");
const OUTPUT = path.join(ROOT, "attachments/演示视频.mp4");
const FPS = 30;
// GitHub 免费账号上传视频的上限是 10MB，留点余量。
const MAX_BYTES = 9.5 * 1024 * 1024;
const VOICE = "zh-CN-XiaoxiaoNeural";
const EDGE_TTS = ["uvx", "--from", "edge-tts==7.3.1", "edge-tts"];
const AUDIO_KBPS = 96;

function run(command, args, { capture = false } = {}) {
  const child = spawn(command, args, { stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"] });
  let output = "";
  if (capture) child.stdout.on("data", (chunk) => { output += chunk; });
  return new Promise((resolve, reject) => {
    child.on("exit", (code) => (code === 0 ? resolve(output) : reject(new Error(`${command} 退出码 ${code}`))));
  });
}

async function probeDuration(file) {
  const output = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { capture: true });
  return Number(output.trim());
}

// edge-tts 合成的音频开头约 0.2 秒、结尾约 0.5 秒是静音，算停顿时只按实际说话的部分算。
async function speechBounds(file, duration) {
  const args = ["-hide_banner", "-i", file, "-af", "silencedetect=n=-45dB:d=0.08", "-f", "null", "-"];
  const log = await new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let output = "";
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("exit", (code) => (code === 0 ? resolve(output) : reject(new Error(`ffmpeg 退出码 ${code}`))));
  });
  const starts = [...log.matchAll(/silence_start: ([\d.]+)/g)].map((match) => Number(match[1]));
  const ends = [...log.matchAll(/silence_end: ([\d.]+)/g)].map((match) => Number(match[1]));
  const begin = starts[0] === 0 ? ends[0] : 0;
  const finish = ends.length && ends.at(-1) >= duration - 0.01 ? starts.at(-1) : duration;
  // 两头各留一点余量，免得切到字音。
  const offset = Math.max(0, begin - 0.03);
  return { offset, duration: Math.min(duration, finish + 0.08) - offset };
}

// 每句字幕合成一段旁白，返回文件路径、说话部分的起点和长度。
async function synthesizeNarration(lines) {
  const cacheDir = path.join(OUT_DIR, "narration");
  await mkdir(cacheDir, { recursive: true });
  const clips = [];
  for (const text of lines) {
    const hash = createHash("sha1").update(`${VOICE}\n${text}`).digest("hex").slice(0, 12);
    const file = path.join(cacheDir, `${hash}.mp3`);
    if (!existsSync(file)) await run(EDGE_TTS[0], [...EDGE_TTS.slice(1), "--voice", VOICE, "--text", text, "--write-media", file]);
    clips.push({ file, ...await speechBounds(file, await probeDuration(file)) });
  }
  return clips;
}

// 把各段旁白裁掉首尾静音，按起点摆到同一条音轨上，补齐到整片长度。
// 补齐要用 apad=whole_dur：apad 后面再接 atrim 会把 adelay 插在开头的静音吃掉，整条旁白提前约半秒。
// 而 apad=whole_dur 输出的时间戳是乱的（起点变成上百亿秒），最后用 asetpts 按采样数重新生成。
async function mixNarration(clips, cues, duration, outputFile) {
  const inputs = clips.flatMap((clip) => ["-i", clip.file]);
  const delayed = clips.map((_clip, index) => {
    const delay = Math.round(cues[index] * 1000);
    const { offset, duration: length } = clips[index];
    return `[${index}:a]atrim=${offset}:${offset + length},asetpts=PTS-STARTPTS,adelay=${delay}:all=1[voice${index}]`;
  });
  const labels = clips.map((_clip, index) => `[voice${index}]`).join("");
  const filter = `${delayed.join(";")};${labels}amix=inputs=${clips.length}:normalize=0,apad=whole_dur=${duration},asetpts=N/SR/TB[mix]`;
  await run("ffmpeg", [
    "-loglevel", "error", "-y", ...inputs,
    "-filter_complex", filter, "-map", "[mix]",
    "-ac", "1", "-c:a", "aac", "-b:a", `${AUDIO_KBPS}k`, outputFile,
  ]);
}

// quality 是 { crf } 或 { bitrate, pass, passLog }：先按固定画质试，超了再按目标码率两遍编码。
// 第一遍只分析画面，不需要音轨。
function encode(frameDir, audioFile, outputFile, quality) {
  const rateArgs = quality.crf !== undefined
    ? ["-crf", String(quality.crf)]
    : ["-b:v", `${quality.bitrate}k`, "-pass", String(quality.pass), "-passlogfile", quality.passLog];
  const firstPass = quality.pass === 1;
  const audioInput = firstPass ? [] : ["-i", audioFile];
  const target = firstPass
    ? ["-an", "-f", "null", "/dev/null"]
    : ["-map", "0:v", "-map", "1:a", "-c:a", "copy", "-pix_fmt", "yuv420p", "-movflags", "+faststart", outputFile];
  return run("ffmpeg", [
    "-loglevel", "error", "-y",
    "-framerate", String(FPS), "-i", path.join(frameDir, "frame-%05d.png"), ...audioInput,
    "-c:v", "libx264", "-preset", "slow", ...rateArgs,
    ...target,
  ]);
}

function parseStills(argv) {
  const index = argv.indexOf("--still");
  if (index === -1) return null;
  return argv[index + 1].split(",").map(Number);
}

async function renderStills(capture, times) {
  const stillDir = path.join(OUT_DIR, "demo-stills");
  await mkdir(stillDir, { recursive: true });
  for (const time of times) {
    const file = path.join(stillDir, `t${time.toFixed(2)}.png`);
    await writeFile(file, await capture(time));
    console.log(file);
  }
}

async function renderVideo(capture, timing, clips) {
  const frameDir = path.join(OUT_DIR, "demo-frames");
  await rm(frameDir, { recursive: true, force: true });
  await mkdir(frameDir, { recursive: true });
  const frames = Math.round(timing.duration * FPS);
  for (let frame = 0; frame < frames; frame += 1) {
    await writeFile(path.join(frameDir, `frame-${String(frame).padStart(5, "0")}.png`), await capture(frame / FPS));
    if (frame % FPS === 0) process.stdout.write(`\r渲染 ${frame}/${frames}`);
  }
  process.stdout.write(`\r渲染 ${frames}/${frames}\n`);

  const audioFile = path.join(frameDir, "narration.m4a");
  await mixNarration(clips, timing.cues, timing.duration, audioFile);

  // 先按 crf 18 编码，放得下就用它；放不下就按上限的 95% 扣掉音轨算码率，两遍编码，
  // 同样体积下画质比单纯调高 crf 好。
  await mkdir(path.dirname(OUTPUT), { recursive: true });
  await encode(frameDir, audioFile, OUTPUT, { crf: 18 });
  let { size } = await stat(OUTPUT);
  console.log(`crf 18：${(size / 1024 / 1024).toFixed(2)} MB`);
  if (size > MAX_BYTES) {
    const bitrate = Math.floor(MAX_BYTES * 0.95 * 8 / 1000 / timing.duration) - AUDIO_KBPS;
    const passLog = path.join(frameDir, "x264-pass");
    await encode(frameDir, audioFile, OUTPUT, { bitrate, pass: 1, passLog });
    await encode(frameDir, audioFile, OUTPUT, { bitrate, pass: 2, passLog });
    ({ size } = await stat(OUTPUT));
    console.log(`两遍编码，画面 ${bitrate} kbps：${(size / 1024 / 1024).toFixed(2)} MB`);
  }
  await rm(frameDir, { recursive: true, force: true });
  console.log(OUTPUT);
}

const stills = parseStills(process.argv);
await withScene("scripts/demo-video/scene.html", { width: 1920, height: 1080 }, async ({ info, evaluate, screenshot }) => {
  console.log("对齐结果", JSON.stringify({ offsets: info.offsets, alignmentErrors: info.alignmentErrors }));
  const clips = await synthesizeNarration(info.captions);
  const timing = await evaluate(`window.configureNarration(${JSON.stringify(clips.map((clip) => clip.duration))})`);
  console.log(`旁白 ${clips.map((clip) => clip.duration.toFixed(2)).join(" / ")} 秒，成片 ${timing.duration.toFixed(2)} 秒`);

  const capture = async (time) => {
    await evaluate(`window.renderAt(${time})`);
    return screenshot();
  };
  if (stills) await renderStills(capture, stills);
  else await renderVideo(capture, timing, clips);
});
