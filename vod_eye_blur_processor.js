// vod_eye_blur_processor.js
// 管线：VOD(获取视频URL) → ffmpeg 解码(yuv420p) → node processor_yuv → ffmpeg 编码(直写临时文件) → VOD上传
// 说明：与 processor_yuv.js 参数保持一致（width/height 必须为偶数）

const { Config } = require('@alicloud/openapi-client');
const VodUploader = require('./vod_uploader');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

/**
 * 使用 MoveNet + 超椭圆面具，仅遮挡"鼻子以上"，结果上传到 VOD
 *
 * @param {Object} opts
 * @param {string} opts.accessKeyId
 * @param {string} opts.accessKeySecret
 * @param {string} opts.region
 * @param {string} opts.videoId
 * @param {string} opts.outputTitle
 * @param {string} [opts.outputDescription]
 * @param {number} opts.width            // 偶数
 * @param {number} opts.height           // 偶数
 * @param {number} [opts.fps=25]
 * @param {number} [opts.minScore=0.2]   // 映射到 scoreThreshold & minPoseConfidence
 * @param {number} [opts.crf=23]
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
 * @returns {string} [returns.outputVideoId] - 输出视频ID（成功时）
 * @returns {string} returns.startTime - 开始执行时间（ISO 8601 格式）
 * @returns {string} returns.endTime - 结束执行时间（ISO 8601 格式）
 * @returns {number} returns.processingTime - 处理耗时毫秒数
 * @returns {string} [returns.error] - 错误信息（失败时）
 * @returns {string} [returns.errorType] - 错误类型（失败时）
 * @returns {string} [returns.stack] - 错误堆栈（失败时）
 * @returns {string[]} [returns.errors] - 详细错误日志数组
 */
async function maskEyesWithPoseNetVOD(opts) {
  const startTime = Date.now();
  const startTimeISO = new Date().toISOString();
  console.log('[START] VOD视频遮挡处理启动 (YUV420P + 临时文件 + VOD上传)');
  console.log('[START_TIME]', startTimeISO);
  console.log('[PARAMS]', JSON.stringify(opts, null, 2));

  const {
    accessKeyId, accessKeySecret, region,
    videoId, outputTitle, outputDescription,
    width, height,
    fps = 25,
    minScore = 0.1,
    crf = 23,
    timeout = 300000,

    detectScale = 0.5,
    detectEvery = 3,
    enableSmoothing = true,
    adaptiveSkip = true,
    maxDetections = 5,
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
  console.log(`  - 超时: ${timeout}ms`);
  console.log(`  - detectScale=${detectScale}, detectEvery=${detectEvery}, enableSmoothing=${enableSmoothing}, adaptiveSkip=${adaptiveSkip}, maxDetections=${maxDetections}`);
  console.log(`  - maskScaleW=${maskScaleW}, maskScaleH=${maskScaleH}, samplesPerCurve=${samplesPerCurve}, strokeWidth=${strokeWidth}`);

  // 初始化 VOD 客户端
  console.log('[VOD] 初始化客户端…');
  const config = new Config({
    accessKeyId,
    accessKeySecret,
    region,
    endpoint: `vod.${region}.aliyuncs.com`,
  });
  
  const vod = require('@alicloud/vod20170321');
  const vodClient = new vod.default(config);
  const GetPlayInfoRequest = vod.GetPlayInfoRequest;
  const CreateUploadVideoRequest = vod.CreateUploadVideoRequest;

  // 初始化 VOD 上传器
  const uploader = new VodUploader(accessKeyId, accessKeySecret, region);

  const errors = [];
  const collectErr = (prefix) => (data) => {
    const msg = data.toString().trim();
    if (msg) {
      errors.push(`${prefix}: ${msg}`);
      console.error(`${prefix}: ${msg}`);
    }
  };

  let ffmpegIn, processor, ffmpegOut;
  const tmpFile = path.join(os.tmpdir(), `vod-privacy-guard-${Date.now()}-${process.pid}.mp4`);

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
    // 1) 从 VOD 获取视频播放地址
    console.log(`[VOD] 获取视频播放信息: ${videoId}`);
    
    // 首先尝试获取播放信息
    console.log('[VOD] 尝试获取播放信息...');
    let playUrl = null;
    let usedMethod = null;

    try {
      // 尝试获取播放信息（不指定格式）
      const getPlayInfoRequest = new GetPlayInfoRequest({
        videoId: videoId,
      });

      const playInfoResponse = await vodClient.getPlayInfo(getPlayInfoRequest);
      const playInfo = playInfoResponse.body;
      
      console.log('[VOD] 播放信息响应:', JSON.stringify(playInfo, null, 2));
      
      // VOD API 返回的数据结构是 playInfoList.playInfo 数组
      const playInfoArray = playInfo?.playInfoList?.playInfo || playInfo?.playInfoList || [];
      
      if (playInfoArray && playInfoArray.length > 0) {
        const firstPlayInfo = playInfoArray[0];
        if (firstPlayInfo && firstPlayInfo.playURL) {
          playUrl = firstPlayInfo.playURL;
          usedMethod = 'playInfo';
          console.log('[VOD] 成功获取播放地址');
        }
      }
    } catch (error) {
      console.log('[VOD] 获取播放信息失败:', error.message);
    }

    // 如果播放信息获取失败，尝试获取原始文件下载地址
    if (!playUrl) {
      console.log('[VOD] 尝试获取原始文件下载地址...');
      try {
        const GetURLUploadInfosRequest = vod.GetURLUploadInfosRequest;
        const getURLUploadInfosRequest = new GetURLUploadInfosRequest({
          jobIds: videoId,
        });

        const urlUploadInfosResponse = await vodClient.getURLUploadInfos(getURLUploadInfosRequest);
        const urlUploadInfos = urlUploadInfosResponse.body;
        
        console.log('[VOD] URL上传信息响应:', JSON.stringify(urlUploadInfos, null, 2));
        
        if (urlUploadInfos && urlUploadInfos.URLUploadInfoList && urlUploadInfos.URLUploadInfoList.length > 0) {
          const uploadInfo = urlUploadInfos.URLUploadInfoList[0];
          if (uploadInfo && uploadInfo.sourceUrl) {
            playUrl = uploadInfo.sourceUrl;
            usedMethod = 'sourceUrl';
            console.log('[VOD] 成功获取原始文件地址');
          }
        }
      } catch (error) {
        console.log('[VOD] 获取原始文件地址失败:', error.message);
      }
    }

    // 如果还是失败，尝试获取原始文件信息
    if (!playUrl) {
      console.log('[VOD] 尝试获取原始文件信息...');
      try {
        const GetMezzanineInfoRequest = vod.GetMezzanineInfoRequest;
        const getMezzanineInfoRequest = new GetMezzanineInfoRequest({
          videoId: videoId,
        });

        const mezzanineInfoResponse = await vodClient.getMezzanineInfo(getMezzanineInfoRequest);
        const mezzanineInfo = mezzanineInfoResponse.body;
        
        console.log('[VOD] 原始文件信息响应:', JSON.stringify(mezzanineInfo, null, 2));
        
        if (mezzanineInfo && mezzanineInfo.mezzanine && mezzanineInfo.mezzanine.fileURL) {
          playUrl = mezzanineInfo.mezzanine.fileURL;
          usedMethod = 'mezzanine';
          console.log('[VOD] 成功获取原始文件URL');
        }
      } catch (error) {
        console.log('[VOD] 获取原始文件信息失败:', error.message);
      }
    }

    // 如果还是失败，尝试使用 OSS 直接访问
    if (!playUrl) {
      console.log('[VOD] 尝试使用OSS直接访问...');
      try {
        // 获取视频基本信息来获取存储位置
        const GetVideoInfoRequest = vod.GetVideoInfoRequest;
        const getVideoInfoRequest = new GetVideoInfoRequest({
          videoId: videoId,
        });

        const videoInfoResponse = await vodClient.getVideoInfo(getVideoInfoRequest);
        const videoInfo = videoInfoResponse.body;
        
        console.log('[VOD] 视频信息:', JSON.stringify(videoInfo, null, 2));
        
        if (videoInfo && videoInfo.video && videoInfo.video.storageLocation) {
          // 构建OSS URL（需要签名）
          const storageLocation = videoInfo.video.storageLocation;
          const title = videoInfo.video.title || 'video.mp4';
          
          // 生成预签名URL
          const ossClient = new (require('ali-oss'))({
            region: region,
            accessKeyId: accessKeyId,
            accessKeySecret: accessKeySecret,
            bucket: storageLocation.split('.')[0],
            endpoint: `${region}.aliyuncs.com`,
          });
          
          // 尝试常见的文件路径
          const possiblePaths = [
            `sv/${videoId}/${title}`,
            `sv/${videoId}/video.mp4`,
            `sv/${videoId}/video.mov`,
            `${videoId}/${title}`,
            `${videoId}/video.mp4`,
            `${videoId}/video.mov`,
          ];
          
          for (const path of possiblePaths) {
            try {
              const signedUrl = ossClient.signatureUrl(path, { expires: 3600, method: 'GET' });
              // 测试URL是否可访问
              const response = await fetch(signedUrl, { method: 'HEAD' });
              if (response.ok) {
                playUrl = signedUrl;
                usedMethod = 'ossDirect';
                console.log(`[VOD] 成功获取OSS直接访问地址: ${path}`);
                break;
              }
            } catch (error) {
              console.log(`[VOD] OSS路径 ${path} 不可访问:`, error.message);
              continue;
            }
          }
        }
      } catch (error) {
        console.log('[VOD] OSS直接访问失败:', error.message);
      }
    }

    if (!playUrl) {
      throw new Error(`无法获取视频播放地址。已尝试播放信息、原始文件地址和OSS直接访问。视频ID: ${videoId}`);
    }

    console.log(`[VOD] 最终使用方法: ${usedMethod}`);
    console.log(`[VOD] 获取到播放地址: ${playUrl}`);

    // 2) ffmpeg-in: 解码为 yuv420p 原始帧
    console.log('[FFMPEG-IN] 启动…');
    const ffmpegInArgs = [
      '-hide_banner', '-loglevel', 'error',
      '-threads', '4',
      '-i', playUrl,
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

    // 3) processor_yuv.js
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
      // 抑制 Node.js 弃用警告
      NODE_NO_WARNINGS: '1',
      // 抑制特定的弃用警告
      NODE_OPTIONS: (process.env.NODE_OPTIONS || '') + ' --no-deprecation',
    };
    processor = spawn('node', processorArgs, { stdio: ['pipe', 'pipe', 'pipe'], env: procEnv });
    console.log(`[PROCESSOR] PID=${processor.pid}`);
    processor.stderr.on('data', collectErr('[processor]'));
    processor.on('error', (err) => {
      errors.push(`[processor] spawn error: ${err.message}`);
      console.error('[PROCESSOR] 启动失败:', err.message);
      cleanup();
    });

    // 4) ffmpeg-out: 从 yuv420p 原始帧编码为 MP4 —— 直接写临时文件（可寻址）
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
      tmpFile,                       // ★ 直接写文件，避免 "non seekable output"
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

    // 5) 获取文件信息并上传到 VOD
    console.log('[VOD] 准备上传处理后的视频…');
    const stat = fs.statSync(tmpFile);
    console.log(`[VOD] 本地文件大小: ${stat.size} 字节`);

    // 获取上传凭证
    const uploadRequest = new CreateUploadVideoRequest({
      title: outputTitle,
      description: outputDescription || `处理后的视频 - 源视频ID: ${videoId}`,
      fileName: `processed_${videoId}_${Date.now()}.mp4`,
      fileSize: stat.size,
      cateId: 0,
      tags: 'privacy-protected,eye-blur',
    });

    const uploadResponse = await vodClient.createUploadVideo(uploadRequest);
    const uploadInfo = uploadResponse.body;
    console.log(`[VOD] 获取上传凭证成功，输出视频ID: ${uploadInfo.videoId}`);

    // 解析上传信息
    const ossConfig = uploader.parseUploadInfo(uploadInfo.uploadAddress, uploadInfo.uploadAuth);
    console.log('[VOD] 解析上传信息成功');

    // 上传文件
    console.log('[VOD] 开始上传文件…');
    const ossClient = uploader.createOssClient(ossConfig);
    
    const uploadResult = await uploader.uploadToOss(ossClient, tmpFile, ossConfig.objectKey, {
      timeout: timeout,
    });

    console.log('[VOD] 文件上传成功');
    console.log(`[VOD] 输出视频ID: ${uploadInfo.videoId}`);

    // 6) 上传成功后删除临时文件
    try { fs.unlinkSync(tmpFile); console.log('[FILE] 已删除临时文件:', tmpFile); } catch (e) {
      console.warn('[FILE] 删除临时文件失败:', e.message);
    }

    // 返回成功结果
    const endTime = Date.now();
    const endTimeISO = new Date().toISOString();
    const successResult = {
      success: true,
      outputVideoId: uploadInfo.videoId,
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

module.exports = { maskEyesWithPoseNetVOD };
