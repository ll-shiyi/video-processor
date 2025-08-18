// video_eye_blur_oss.js
// 封装：给 srcKey、dstKey（都在同一 OSS），执行 ffmpeg→node(posenet)→ffmpeg，回传 OSS。
// 使用示例在文件末尾。
const OSS = require('ali-oss');
const { spawn } = require('child_process');
const { PassThrough } = require('stream');
const path = require('path');

/**
 * 用 PoseNet 在视频中识别眼睛并打码，流式回传到 OSS
 * @param {Object} opts
 * @param {string} opts.region
 * @param {string} opts.bucket
 * @param {string} opts.accessKeyId
 * @param {string} opts.accessKeySecret
 * @param {string} opts.srcKey
 * @param {string} opts.dstKey
 * @param {number} opts.width
 * @param {number} opts.height
 * @param {number} [opts.fps=25]
 * @param {number} [opts.mosaic=20]
 * @param {number} [opts.eyeExpand=0.6]
 * @param {number} [opts.minScore=0.5]
 * @param {number} [opts.crf=23]
 * @param {boolean} [opts.useInternal=true]
 */
async function maskEyesWithPoseNetOSS(opts) {
  const {
    region, bucket, accessKeyId, accessKeySecret,
    srcKey, dstKey,
    width, height, fps = 25,
    mosaic = 20, eyeExpand = 0.6, minScore = 0.5,
    crf = 23, useInternal = true,
  } = opts;

  // 初始化 OSS 客户端
  const client = new OSS({
    region,
    accessKeyId,
    accessKeySecret,
    bucket,
    endpoint: useInternal
      ? `${region}-internal.aliyuncs.com`
      : `${region}.aliyuncs.com`,
  });

  // 生成预签名 GET URL
  const signedUrl = client.signatureUrl(srcKey, { expires: 3600, method: 'GET' });

  const errors = [];
  const collectErr = (prefix) => (data) => errors.push(`${prefix}: ${data}`);

  // ffmpeg 解码
  const ffmpegIn = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-i', signedUrl,
    '-vf', `scale=${width}:${height},fps=${fps}`,
    '-f', 'rawvideo',
    '-pix_fmt', 'rgb24',
    'pipe:1'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  ffmpegIn.stderr.on('data', collectErr('[ffmpeg-in]'));

  // processor.js (PoseNet 眼睛打码)
  const processorPath = path.join(__dirname, 'processor.js');
  const processor = spawn('node', [
    processorPath,
    '--width', String(width),
    '--height', String(height),
    '--fps', String(fps),
    '--mosaic', String(mosaic),
    '--eyeExpand', String(eyeExpand),
    '--minScore', String(minScore),
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  processor.stderr.on('data', collectErr('[processor]'));

  // ffmpeg 编码回 mp4
  const ffmpegOut = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgb24',
    '-s', `${width}x${height}`,
    '-r', String(fps),
    '-i', 'pipe:0',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', String(crf),
    '-movflags', '+faststart',
    '-f', 'mp4',
    'pipe:1'
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  ffmpegOut.stderr.on('data', collectErr('[ffmpeg-out]'));

  // 管道连接
  ffmpegIn.stdout.pipe(processor.stdin);
  processor.stdout.pipe(ffmpegOut.stdin);

  // 上传到 OSS
  const uploadStream = new PassThrough();
  ffmpegOut.stdout.pipe(uploadStream);

  const waitExit = (cp, name) =>
    new Promise((resolve) => cp.on('close', (code, signal) => resolve({ name, code, signal })));

  const putPromise = client.putStream(dstKey, uploadStream).catch((e) => {
    errors.push(`[oss] upload error: ${e?.message || e}`);
    throw e;
  });

  const [rIn, rProc, rOut] = await Promise.all([
    waitExit(ffmpegIn, 'ffmpeg-in'),
    waitExit(processor, 'processor'),
    waitExit(ffmpegOut, 'ffmpeg-out'),
  ]).catch((e) => {
    errors.push(`[wait] pipeline error: ${e?.message || e}`);
    uploadStream.destroy(e);
    throw e;
  });

  let putRes;
  try {
    putRes = await putPromise;
  } catch (e) {
    throw new Error(
      `Upload failed. Stages: in=${rIn.code}, proc=${rProc.code}, out=${rOut.code}.\n` +
      errors.join('\n')
    );
  }

  const failed = [rIn, rProc, rOut].find(r => r.code !== 0);
  if (failed) {
    throw new Error(
      `Pipeline failed at ${failed.name} (code=${failed.code}).\n` +
      errors.join('\n')
    );
  }

  return { ok: true, etag: putRes.etag, dstKey };
}

module.exports = { maskEyesWithPoseNetOSS };