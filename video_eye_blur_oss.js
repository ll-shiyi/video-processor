// video_eye_blur_oss.js
// 管线：OSS(预签名URL) → ffmpeg 解码(yuv420p) → node processor_yuv → ffmpeg 编码(直写临时文件) → OSS multipartUpload
// 说明：与 processor_yuv.js 参数保持一致（width/height 必须为偶数）

const OSS = require('ali-oss');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

/**
 * 使用 MoveNet + 超椭圆面具，仅遮挡“鼻子以上”，结果上传到同一 OSS
 *
 * @param {Object} opts
 * @param {string} opts.region
 * @param {string} opts.bucket
 * @param {string} opts.accessKeyId
 * @param {string} opts.accessKeySecret
 * @param {string} opts.srcKey
 * @param {string} opts.dstKey
 * @param {number} opts.width            // 偶数
 * @param {number} opts.height           // 偶数
 * @param {number} [opts.fps=25]
 * @param {number} [opts.minScore=0.2]   // 映射到 scoreThreshold & minPoseConfidence
 * @param {number} [opts.crf=23]
 * @param {boolean} [opts.useInternal=true]
 * @param {number} [opts.timeout=300000]
 * @param {number} [opts.detectScale=0.3]
 * @param {number} [opts.detectEvery=5]
 * @param {boolean} [opts.enableSmoothing=true]
 * @param {boolean} [opts.adaptiveSkip=true]
 * @param {number} [opts.maxDetections=3]
 * @param {number} [opts.maskScaleW=1.3]
 * @param {number} [opts.maskScaleH=1.8]
 * @param {number} [opts.samplesPerCurve=28]
 * @param {number} [opts.strokeWidth=1]
 * 
 * @returns {Promise<Object>} 处理结果
 * @returns {boolean} returns.success - 是否成功
 * @returns {string} [returns.dstKey] - 目标文件键名
 * @returns {string} [returns.etag] - OSS ETag（成功时）
 * @returns {number} [returns.fileSize] - 文件大小字节数（成功时）
 * @returns {string} returns.startTime - 开始执行时间（ISO 8601 格式）
 * @returns {string} returns.endTime - 结束执行时间（ISO 8601 格式）
 * @returns {number} returns.processingTime - 处理耗时毫秒数
 * @returns {string} [returns.error] - 错误信息（失败时）
 * @returns {string} [returns.errorType] - 错误类型（失败时）
 * @returns {string} [returns.stack] - 错误堆栈（失败时）
 * @returns {string[]} [returns.errors] - 详细错误日志数组
 */
async function maskEyesWithPoseNetOSS(opts) {
  const startTime = Date.now();
  const startTimeISO = new Date().toISOString();
  console.log('[START] 视频遮挡处理启动 (YUV420P + 临时文件 + multipartUpload)');
  console.log('[START_TIME]', startTimeISO);
  console.log('[PARAMS]', JSON.stringify(opts, null, 2));

  const {
    region, bucket, accessKeyId, accessKeySecret,
    srcKey, dstKey,
    width, height,
    fps = 25,
    minScore = 0.2,
    crf = 23,
    useInternal = true,
    timeout = 300000,

    detectScale = 0.3,
    detectEvery = 5,
    enableSmoothing = true,
    adaptiveSkip = true,
    maxDetections = 3,
    maskScaleW = 1.3,
    maskScaleH = 1.8,
    samplesPerCurve = 28,
    strokeWidth = 1,
  } = opts;

  if (!width || !height) throw new Error('width/height 不能为空');
  if (width % 2 !== 0 || height % 2 !== 0) {
    throw new Error('yuv420p 需要偶数尺寸：width/height 必须为偶数');
  }

  console.log('[CONFIG]');
  console.log(`  - 尺寸: ${width}x${height} (yuv420p)`);
  console.log(`  - 帧率: ${fps}`);
  console.log(`  - 置信度阈值: ${minScore}`);
  console.log(`  - CRF: ${crf}`);
  console.log(`  - 内网: ${useInternal}`);
  console.log(`  - 超时: ${timeout}ms`);
  console.log(`  - detectScale=${detectScale}, detectEvery=${detectEvery}, enableSmoothing=${enableSmoothing}, adaptiveSkip=${adaptiveSkip}, maxDetections=${maxDetections}`);
  console.log(`  - maskScaleW=${maskScaleW}, maskScaleH=${maskScaleH}, samplesPerCurve=${samplesPerCurve}, strokeWidth=${strokeWidth}`);

  // 初始化 OSS 客户端（外网强制 HTTPS，内网通常 http）
  console.log('[OSS] 初始化客户端…');
  const client = new OSS({
    region,
    accessKeyId,
    accessKeySecret,
    bucket,
    endpoint: useInternal
      ? `${region}-internal.aliyuncs.com`
      : `${region}.aliyuncs.com`,
    secure: !useInternal,   // 外网 https
    timeout,
    retryMax: 3,
  });
  console.log(`[OSS] endpoint=${useInternal ? region + '-internal.aliyuncs.com' : region + '.aliyuncs.com'}, secure=${!useInternal}`);

  // 预签名 URL
  console.log(`[OSS] 生成预签名 GET URL: ${srcKey}`);
  const signedUrl = client.signatureUrl(srcKey, { expires: 3600, method: 'GET' });
  console.log('[OSS] 预签名 URL 有效期 3600s');

  const errors = [];
  const collectErr = (prefix) => (data) => {
    const msg = data.toString().trim();
    if (msg) {
      errors.push(`${prefix}: ${msg}`);
      console.error(`${prefix}: ${msg}`);
    }
  };

  let ffmpegIn, processor, ffmpegOut;
  const tmpFile = path.join(os.tmpdir(), `privacy-guard-${Date.now()}-${process.pid}.mp4`);

  const cleanup = () => {
    console.log('[CLEANUP] 开始清理资源…');
    try {
      if (ffmpegIn && !ffmpegIn.killed) {
        ffmpegIn.kill('SIGTERM');
        setTimeout(() => { if (!ffmpegIn.killed) ffmpegIn.kill('SIGKILL'); }, 5000);
      }
      if (processor && !processor.killed) {
        processor.kill('SIGTERM');
        setTimeout(() => { if (!processor.killed) processor.kill('SIGKILL'); }, 5000);
      }
      if (ffmpegOut && !ffmpegOut.killed) {
        ffmpegOut.kill('SIGTERM');
        setTimeout(() => { if (!ffmpegOut.killed) ffmpegOut.kill('SIGKILL'); }, 5000);
      }
      if (fs.existsSync(tmpFile)) {
        try { fs.unlinkSync(tmpFile); console.log('[CLEANUP] 已删除临时文件:', tmpFile); } catch (e) {
          console.warn('[CLEANUP] 删除临时文件失败:', e.message);
        }
      }
    } catch (e) {
      console.error('[CLEANUP] 异常：', e);
    }
  };

  try {
    // 1) ffmpeg-in: 解码为 yuv420p 原始帧
    console.log('[FFMPEG-IN] 启动…');
    const ffmpegInArgs = [
      '-hide_banner', '-loglevel', 'error',
      '-threads', '4',
      '-i', signedUrl,
      '-vf', `scale=${width}:${height},fps=${fps}`,
      '-pix_fmt', 'yuv420p',
      '-f', 'rawvideo',
      '-vsync', '0',
      '-y',
      'pipe:1',
    ];
    console.log('[FFMPEG-IN] 命令:', ffmpegInArgs.join(' '));
    ffmpegIn = spawn('ffmpeg', ffmpegInArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    console.log(`[FFMPEG-IN] PID=${ffmpegIn.pid}`);
    ffmpegIn.stderr.on('data', collectErr('[ffmpeg-in]'));
    ffmpegIn.on('error', (err) => {
      errors.push(`[ffmpeg-in] spawn error: ${err.message}`);
      console.error('[FFMPEG-IN] 启动失败:', err.message);
      cleanup();
    });

    // 2) processor_yuv.js
    console.log('[PROCESSOR] 启动 processor_yuv…');
    const processorPath = path.join(__dirname, 'processor_yuv.js');
    const processorArgs = [
      processorPath,
      '--width', String(width),
      '--height', String(height),
      '--fps', String(fps),
      '--scoreThreshold', String(minScore),
      '--minPoseConfidence', String(minScore),
      '--detectScale', String(detectScale),
      '--detectEvery', String(detectEvery),
      '--enableSmoothing', String(enableSmoothing),
      '--adaptiveSkip', String(adaptiveSkip),
      '--maxDetections', String(maxDetections),
      '--maskScaleW', String(maskScaleW),
      '--maskScaleH', String(maskScaleH),
      '--samplesPerCurve', String(samplesPerCurve),
      '--strokeWidth', String(strokeWidth),
      '--showProgress', 'false',
    ];
    console.log('[PROCESSOR] 命令:', processorArgs.join(' '));

    const procEnv = {
      ...process.env,
      TF_CPP_MIN_LOG_LEVEL: process.env.TF_CPP_MIN_LOG_LEVEL || '2',
      TENSORFLOW_NUM_INTRAOP_THREADS: process.env.TENSORFLOW_NUM_INTRAOP_THREADS || '4',
      TENSORFLOW_NUM_INTEROP_THREADS: process.env.TENSORFLOW_NUM_INTEROP_THREADS || '2',
    };
    processor = spawn('node', processorArgs, { stdio: ['pipe', 'pipe', 'pipe'], env: procEnv });
    console.log(`[PROCESSOR] PID=${processor.pid}`);
    processor.stderr.on('data', collectErr('[processor]'));
    processor.on('error', (err) => {
      errors.push(`[processor] spawn error: ${err.message}`);
      console.error('[PROCESSOR] 启动失败:', err.message);
      cleanup();
    });

    // 3) ffmpeg-out: 从 yuv420p 原始帧编码为 MP4 —— 直接写临时文件（可寻址）
    console.log('[FFMPEG-OUT] 启动…');
    const ffmpegOutArgs = [
      '-hide_banner', '-loglevel', 'error',
      '-threads', '4',
      '-f', 'rawvideo',
      '-pix_fmt', 'yuv420p',
      '-s', `${width}x${height}`,
      '-r', String(fps),
      '-i', 'pipe:0',
      '-c:v', 'libx264',
      '-preset', 'veryfast',         // 可按机器改成 faster/fast
      '-crf', String(crf),
      '-profile:v', 'baseline',
      '-level', '3.0',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',     // 可寻址输出下，移动 moov 到前面
      '-vsync', '0',
      '-y',
      tmpFile,                       // ★ 直接写文件，避免 “non seekable output”
    ];
    console.log('[FFMPEG-OUT] 命令:', ffmpegOutArgs.join(' '));
    // stdout 无需使用，设为 'ignore'；stdin 接收 processor 输出；stderr 打日志
    ffmpegOut = spawn('ffmpeg', ffmpegOutArgs, { stdio: ['pipe', 'ignore', 'pipe'] });
    console.log(`[FFMPEG-OUT] PID=${ffmpegOut.pid}`);
    ffmpegOut.stderr.on('data', collectErr('[ffmpeg-out]'));
    ffmpegOut.on('error', (err) => {
      errors.push(`[ffmpeg-out] spawn error: ${err.message}`);
      console.error('[FFMPEG-OUT] 启动失败:', err.message);
      cleanup();
    });

    // —— 连接管线
    console.log('[PIPELINE] 连接 ffmpeg-in → processor_yuv');
    ffmpegIn.stdout.pipe(processor.stdin, { highWaterMark: 1024 * 1024 });

    console.log('[PIPELINE] 连接 processor_yuv → ffmpeg-out(写文件)');
    processor.stdout.pipe(ffmpegOut.stdin, { highWaterMark: 1024 * 1024 });

    // 等待子进程退出
    const waitExit = (cp, name) =>
      new Promise((resolve) => {
        cp.on('close', (code, signal) => {
          console.log(`[${name.toUpperCase()}] 退出：code=${code}, signal=${signal || 'null'}`);
          resolve({ name, code, signal });
        });
        cp.on('error', (err) => {
          console.error(`[${name.toUpperCase()}] 进程错误:`, err);
          resolve({ name, code: -1, signal: null, error: err });
        });
      });

    console.log('[WAIT] 等待进程完成…');
    const [rIn, rProc, rOut] = await Promise.all([
      waitExit(ffmpegIn, 'ffmpeg-in'),
      waitExit(processor, 'processor'),
      waitExit(ffmpegOut, 'ffmpeg-out'),
    ]).catch((e) => {
      const msg = e?.message || String(e);
      errors.push(`[wait] pipeline error: ${msg}`);
      console.error('[WAIT] 管线等待异常:', msg);
      throw e;
    });

    console.log('[CHECK] 校验退出码…');
    if (rIn.code !== 0) {
      throw new Error(`ffmpeg-in failed with code ${rIn.code}: ${errors.join('\n')}`);
    }
    if (rProc.code !== 0) {
      throw new Error(`processor failed with code ${rProc.code}: ${errors.join('\n')}`);
    }
    if (rOut.code !== 0) {
      throw new Error(`ffmpeg-out failed with code ${rOut.code}: ${errors.join('\n')}`);
    }

    // 4) 分片上传临时文件
    console.log('[UPLOAD] multipartUpload 开始（临时文件）…');
    const stat = fs.statSync(tmpFile);
    console.log(`[UPLOAD] 本地文件大小: ${stat.size} 字节`);

    const putRes = await client
      .multipartUpload(dstKey, tmpFile, {
        partSize: Math.max(8 * 1024 * 1024, Math.ceil(stat.size / 100)), // 目标 ~≤100 片
        parallel: 3,
        mime: 'video/mp4',
        timeout,
        headers: { 'Content-Type': 'video/mp4' },
        // progress: (p) => console.log(`[UPLOAD] 进度: ${(p * 100).toFixed(1)}%`)
      })
      .then((res) => {
        const etag = res?.etag || res?.res?.headers?.etag || '';
        console.log(`[OSS] multipartUpload 成功，ETag: ${etag}`);
        return { etag };
      })
      .catch((e) => {
        const msg = e?.message || String(e);
        errors.push(`[oss] multipart upload error: ${msg}`);
        console.error('[UPLOAD] multipartUpload 失败:', msg);
        throw e;
      });

    console.log('[SUCCESS] 视频处理与上传完成');
    console.log(`[RESULT] dstKey=${dstKey}, ETag=${putRes?.etag || ''}`);

    // 5) 上传成功后删除临时文件
    try { fs.unlinkSync(tmpFile); console.log('[FILE] 已删除临时文件:', tmpFile); } catch (e) {
      console.warn('[FILE] 删除临时文件失败:', e.message);
    }

    // 返回成功结果
    const endTime = Date.now();
    const endTimeISO = new Date().toISOString();
    const successResult = {
      success: true,
      dstKey,
      etag: putRes?.etag || '',
      fileSize: stat.size,
      startTime: startTimeISO,
      endTime: endTimeISO,
      processingTime: endTime - startTime,
      errors: errors.length > 0 ? errors : undefined
    };

    console.log('[SUCCESS] 返回结果:', JSON.stringify(successResult, null, 2));
    return successResult;
  } catch (error) {
    console.error('[ERROR] 处理异常:', error?.message || error);
    console.error('[ERROR] 堆栈:', error?.stack || '');
    
    // 返回失败结果
    const endTime = Date.now();
    const endTimeISO = new Date().toISOString();
    const failureResult = {
      success: false,
      error: error?.message || String(error),
      errorType: error?.constructor?.name || 'Error',
      dstKey,
      startTime: startTimeISO,
      endTime: endTimeISO,
      processingTime: endTime - startTime,
      errors: errors.length > 0 ? errors : undefined,
      stack: error?.stack
    };

    console.log('[FAILURE] 返回结果:', JSON.stringify(failureResult, null, 2));
    cleanup();
    return failureResult;
  } finally {
    console.log('[FINALLY] 清理延时执行…');
    setTimeout(cleanup, 1000);
  }
}

module.exports = { maskEyesWithPoseNetOSS };
