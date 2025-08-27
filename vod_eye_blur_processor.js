// vod_eye_blur_processor_fixed.js
// 目的：不拉伸（等比例缩放+居中补边保黑边）+ 尺寸恒定（消重影）+ 输出写回原始SAR
// 步骤：1) 选定 PlayInfo；2) 偶数化尺寸；3) ffmpeg-in 使用 scale+pad 统一到该尺寸（不改变几何）；4) processor/out 严格一致

const { Config } = require('@alicloud/openapi-client');
const vod = require('@alicloud/vod20170321');
const VodUploader = require('./vod_uploader');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ---------- 工具 ----------
function ensureEven(v) {
  v = v | 0;
  return (v % 2 === 0) ? v : (v - 1);
}

function probe(input) {
  const cmd = `ffprobe -v error -select_streams v:0 -show_entries stream=width,height,sample_aspect_ratio,r_frame_rate -of json "${input}"`;
  const out = execSync(cmd, { encoding: 'utf8' });
  const info = JSON.parse(out).streams?.[0];
  if (!info) throw new Error('ffprobe: no video stream');
  const w = ensureEven(info.width);
  const h = ensureEven(info.height);
  const sar = (info.sample_aspect_ratio && info.sample_aspect_ratio !== '0:1') ? info.sample_aspect_ratio : '1:1';
  const fpsStr = info.r_frame_rate || '25/1';
  let fps = 25;
  try {
    const [a, b] = fpsStr.split('/').map(Number);
    if (a > 0 && b > 0) fps = Math.round((a / b) * 1000) / 1000;
  } catch {}
  return { width: w, height: h, sar, fps };
}

function spawnFFmpeg(args, stdio = ['pipe', 'pipe', 'pipe']) {
  console.log('[FFMPEG]', args.join(' '));
  return spawn('ffmpeg', args, { stdio });
}

function waitExit(cp, name) {
  return new Promise((resolve) => {
    cp.on('close', (code, signal) => {
      console.log(`[${name.toUpperCase()}] 退出：code=${code}, signal=${signal || 'null'}`);
      resolve({ name, code, signal });
    });
    cp.on('error', (err) => {
      console.error(`[${name.toUpperCase()}] 进程错误:`, err);
      resolve({ name, code: -1, signal: null, error: err });
    });
  });
}

// ---------- 主函数 ----------
async function maskEyesWithPoseNetVOD(opts) {
  const startTime = Date.now();
  const startTimeISO = new Date().toISOString();
  console.log('[START] VOD视频遮挡处理启动 (等比例+补边/保黑边/消重影版)');
  console.log('[START_TIME]', startTimeISO);
  console.log('[PARAMS]', JSON.stringify(opts, null, 2));

  const {
    accessKeyId, accessKeySecret, region,
    videoId, outputTitle, outputDescription,

    // 可选覆盖
    width: optWidth,
    height: optHeight,
    fps: optFps,

    // 模型/质量/时限
    minScore = 0.1,
    crf = 23,
    timeout = 300000,

    // 检测参数
    detectScale = 0.5,
    detectEvery = 3,
    enableSmoothing = true,
    adaptiveSkip = true,
    maxDetections = 5,

    // 面具参数
    maskScaleW = 1.3,
    maskScaleH = 1.8,
    samplesPerCurve = 28,
    strokeWidth = 1,
  } = opts;

  const errors = [];
  const collectErr = (prefix) => (data) => {
    const msg = data.toString().trim();
    if (msg) {
      errors.push(`${prefix}: ${msg}`);
      console.error(`${prefix}: ${msg}`);
    }
  };

  console.log('[VOD] 初始化客户端…');
  const config = new Config({
    accessKeyId,
    accessKeySecret,
    region,
    endpoint: `vod.${region}.aliyuncs.com`,
  });
  const vodClient = new vod.default(config);
  const GetPlayInfoRequest = vod.GetPlayInfoRequest;
  const CreateUploadVideoRequest = vod.CreateUploadVideoRequest;

  const uploader = new VodUploader(accessKeyId, accessKeySecret, region);

  let ffmpegIn, processor, ffmpegOut;
  const tmpFile = path.join(os.tmpdir(), `vod-privacy-guard-fixed-${Date.now()}-${process.pid}.mp4`);

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
    // 1) 选定播放清晰度：优先720p，其次 Original/Source，最后分辨率最大
    console.log(`[VOD] 获取视频播放信息: ${videoId}`);
    let playUrl = null, playWidth = null, playHeight = null;

    try {
      const getPlayInfoRequest = new GetPlayInfoRequest({ videoId });
      const playInfoResponse = await vodClient.getPlayInfo(getPlayInfoRequest);
      const body = playInfoResponse.body;
      let list = body?.playInfoList?.playInfo || body?.playInfoList || [];
      if (!Array.isArray(list)) list = [];

      const enriched = list.map(p => ({
        ...p,
        _w: (p.width && +p.width) || null,
        _h: (p.height && +p.height) || null,
        _isOriginal: /original|source/i.test(String(p.definition || '')) || /source/i.test(String(p.streamType || '')),
        _is720p: (p.width && +p.width === 1280 && p.height && +p.height === 720) || 
                 (p.width && +p.width === 720 && p.height && +p.height === 1280) ||
                 /720p|720/i.test(String(p.definition || ''))
      }));

      // 优先选择720p清晰度，其次Original/Source，最后分辨率最大
      let pick = enriched.find(p => p._is720p && p.playURL && p._w && p._h);
      if (!pick) {
        pick = enriched.find(p => p._isOriginal && p.playURL && p._w && p._h);
      }
      if (!pick) {
        enriched.sort((a, b) => ((b._w || 0) * (b._h || 0)) - ((a._w || 0) * (a._h || 0)));
        pick = enriched.find(p => p.playURL && p._w && p._h) || enriched[0];
      }

      if (pick?.playURL && pick._w && pick._h) {
        playUrl = pick.playURL;
        playWidth = pick._w | 0;
        playHeight = pick._h | 0;
        console.log(`[VOD] 选择清晰度: definition=${pick.definition}, size=${playWidth}x${playHeight}`);
      }
    } catch (error) {
      console.log('[VOD] 获取播放信息失败:', error.message);
      throw new Error(`无法获取视频播放地址: ${error.message}`);
    }

    if (!playUrl) throw new Error(`无法获取视频播放地址。视频ID: ${videoId}`);
    console.log(`[VOD] 播放地址: ${playUrl}`);

    // 2) 计算目标尺寸（偶数化）+ 原始 SAR + FPS
    const metaProbe = probe(playUrl);
    const origSAR = (metaProbe.sar && metaProbe.sar !== '0:1') ? metaProbe.sar : '1:1';
    
    // 优先使用原始视频尺寸，如果指定了尺寸则使用指定尺寸
    const SRC_W = ensureEven(optWidth  ?? metaProbe.width);
    const SRC_H = ensureEven(optHeight ?? metaProbe.height);
    const FPS   = (optFps && +optFps > 0) ? +optFps : (Math.round(metaProbe.fps) || 25);

    console.log('[META]');
    console.log(`  - 原始视频尺寸: ${metaProbe.width}x${metaProbe.height}`);
    console.log(`  - 目标帧尺寸（偶数化）: ${SRC_W}x${SRC_H}`);
    console.log(`  - 原始 SAR: ${origSAR}`);
    console.log(`  - 输出 FPS: ${FPS}`);

    // 3) ffmpeg-in：保持原始尺寸，不进行缩放和补边，只确保尺寸为偶数
    //    如果目标尺寸与原始尺寸不同，则进行简单缩放，不添加黑边
    console.log('[FFMPEG-IN] 启动…');
    let vfIn;
    if (SRC_W === metaProbe.width && SRC_H === metaProbe.height) {
      // 尺寸相同，直接使用原始尺寸
      vfIn = `setsar=1`; // 只设置方形像素，不进行任何缩放
    } else {
      // 尺寸不同，进行缩放但不添加黑边
      vfIn = `scale=${SRC_W}:${SRC_H}:flags=bicubic,setsar=1`;
    }
    const ffmpegInArgs = [
      '-hide_banner', '-loglevel', 'error',
      '-threads', '4',
      '-fflags', '+genpts',
      '-i', playUrl,
      '-vf', vfIn,
      '-pix_fmt', 'yuv420p',
      '-f', 'rawvideo',
      '-y',
      'pipe:1',
    ];
    const ffmpegIn = spawnFFmpeg(ffmpegInArgs, ['ignore', 'pipe', 'pipe']);
    console.log(`[FFMPEG-IN] PID=${ffmpegIn.pid}`);
    ffmpegIn.stderr.on('data', collectErr('[ffmpeg-in]'));
    ffmpegIn.on('error', (err) => {
      errors.push(`[ffmpeg-in] spawn error: ${err.message}`);
      console.error('[FFMPEG-IN] 启动失败:', err.message);
    });

    // 4) 处理器：严格使用同一宽高/FPS
    console.log('[PROCESSOR] 启动 processor_yuv…');
    const processorPath = path.join(__dirname, 'processor_yuv.js');
    const processorArgs = [
      processorPath,
      '--width', String(SRC_W),
      '--height', String(SRC_H),
      '--fps', String(FPS),

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
    const procEnv = {
      ...process.env,
      TF_CPP_MIN_LOG_LEVEL: process.env.TF_CPP_MIN_LOG_LEVEL || '2',
      TENSORFLOW_NUM_INTRAOP_THREADS: process.env.TENSORFLOW_NUM_INTRAOP_THREADS || '4',
      TENSORFLOW_NUM_INTEROP_THREADS: process.env.TENSORFLOW_NUM_INTEROP_THREADS || '2',
      NODE_NO_WARNINGS: '1',
      NODE_OPTIONS: (process.env.NODE_OPTIONS || '') + ' --no-deprecation',
    };
    console.log('[PROCESSOR] 命令:', processorArgs.join(' '));
    const processor = spawn('node', processorArgs, { stdio: ['pipe', 'pipe', 'pipe'], env: procEnv });
    console.log(`[PROCESSOR] PID=${processor.pid}`);
    processor.stderr.on('data', collectErr('[processor]'));
    processor.on('error', (err) => {
      errors.push(`[processor] spawn error: ${err.message}`);
      console.error('[PROCESSOR] 启动失败:', err.message);
    });

    // 输出端：同一宽高；写回原始 SAR（播放器显示保持与源一致；黑边效果保留）
    console.log('[FFMPEG-OUT] 启动…');
    const ffmpegOutArgs = [
      '-hide_banner', '-loglevel', 'error',
      '-threads', '4',

      '-f', 'rawvideo',
      '-pixel_format', 'yuv420p',
      '-video_size', `${SRC_W}x${SRC_H}`,
      '-framerate', String(FPS),
      '-i', 'pipe:0',

      '-vf', `setsar=${origSAR}`,  // 写回源SAR，显示比例与源一致

      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', String(crf),
      '-movflags', '+faststart',
      '-pix_fmt', 'yuv420p',
      '-y',
      tmpFile,
    ];
    const ffmpegOut = spawnFFmpeg(ffmpegOutArgs, ['pipe', 'ignore', 'pipe']);
    console.log(`[FFMPEG-OUT] PID=${ffmpegOut.pid}`);
    ffmpegOut.stderr.on('data', collectErr('[ffmpeg-out]'));
    ffmpegOut.on('error', (err) => {
      errors.push(`[ffmpeg-out] spawn error: ${err.message}`);
      console.error('[FFMPEG-OUT] 启动失败:', err.message);
    });

    // 管线连接
    console.log('[PIPELINE] 连接 ffmpeg-in → processor_yuv');
    ffmpegIn.stdout.pipe(processor.stdin, { highWaterMark: 1024 * 1024 });

    console.log('[PIPELINE] 连接 processor_yuv → ffmpeg-out');
    processor.stdout.pipe(ffmpegOut.stdin, { highWaterMark: 1024 * 1024 });

    // 等待结束
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
    if (rIn.code !== 0) throw new Error(`ffmpeg-in failed with code ${rIn.code}: ${errors.join('\n')}`);
    if (rProc.code !== 0) throw new Error(`processor failed with code ${rProc.code}: ${errors.join('\n')}`);
    if (rOut.code !== 0) throw new Error(`ffmpeg-out failed with code ${rOut.code}: ${errors.join('\n')}`);

    // 文件检查
    console.log('[FILE] 检查输出文件…');
    if (!fs.existsSync(tmpFile)) throw new Error('输出文件不存在');
    const stat = fs.statSync(tmpFile);
    console.log(`[FILE] 输出文件大小: ${stat.size} 字节`);
    if (stat.size === 0) throw new Error('输出文件为空');

    // 上传 VOD（使用分片上传）
    console.log('[VOD] 准备上传处理后的视频…');
    const uploadResult = await uploader.uploadToVod(tmpFile, vodClient, {
      title: outputTitle,
      description: outputDescription || `处理后的视频 - 源视频ID: ${videoId}`,
      fileName: `processed_${videoId}_${Date.now()}.mp4`,
      fileSize: stat.size,
      cateId: 0,
      tags: 'privacy-protected,eye-blur',
      // 分片上传配置
      partSize: 1024 * 1024 * 5, // 1MB分片
      parallel: 3, // 3个并发
      maxRetries: 3, // 最大重试3次
      timeout: timeout, // 使用传入的timeout
      onProgress: (progress, info) => {
        const percent = (progress * 100).toFixed(2);
        console.log(`[UPLOAD] 上传进度: ${percent}% (${info.uploadedBytes}/${info.fileSize} bytes)`);
      }
    });
    
    console.log('[VOD] 文件上传成功，视频ID:', uploadResult.videoId);

    try { fs.unlinkSync(tmpFile); console.log('[FILE] 已删除临时文件:', tmpFile); } catch (e) {
      console.warn('[FILE] 删除临时文件失败:', e.message);
    }

    const endTime = Date.now();
    const endTimeISO = new Date().toISOString();
    const successResult = {
      success: true,
      outputVideoId: uploadResult.videoId,
      startTime: startTimeISO,
      endTime: endTimeISO,
      processingTime: endTime - startTime,
      width: SRC_W,
      height: SRC_H,
      fps: FPS,
      sar: origSAR,
      errors: errors.length > 0 ? errors : undefined,
    };
    console.log('[SUCCESS] 返回结果:', JSON.stringify(successResult, null, 2));
    return successResult;

  } catch (error) {
    console.error('[ERROR] 处理异常:', error?.message || error);
    console.error('[ERROR] 堆栈:', error?.stack || '');
    const endTime = Date.now();
    const endTimeISO = new Date().toISOString();
    const failureResult = {
      success: false,
      error: error?.message || String(error),
      errorType: error?.constructor?.name || 'Error',
      startTime: startTimeISO,
      endTime: endTimeISO,
      processingTime: endTime - startTime,
      errors: errors.length > 0 ? errors : undefined,
      stack: error?.stack,
    };
    console.log('[FAILURE] 返回结果:', JSON.stringify(failureResult, null, 2));
    return failureResult;

  } finally {
    console.log('[FINALLY] 清理延时执行…');
    setTimeout(() => {
      try { cleanup(); } catch {}
    }, 1000);
  }
}

module.exports = { maskEyesWithPoseNetVOD };
