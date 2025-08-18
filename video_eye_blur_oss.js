// video_eye_blur_oss.js
// 封装：给 srcKey、dstKey（都在同一 OSS），执行 ffmpeg→node(pose-detection)→ffmpeg，回传 OSS。
// 使用示例在文件末尾。
const OSS = require('ali-oss');
const { spawn } = require('child_process');
const { PassThrough } = require('stream');
const path = require('path');

/**
 * 用 pose-detection 在视频中识别眼睛并打码，流式回传到 OSS
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
 * @param {number} [opts.timeout=300000] OSS 上传超时时间（毫秒）
 */
async function maskEyesWithPoseNetOSS(opts) {
  console.log('[START] 开始执行视频眼睛打码处理');
  console.log('[PARAMS] 输入参数:', JSON.stringify(opts, null, 2));
  
  const {
    region, bucket, accessKeyId, accessKeySecret,
    srcKey, dstKey,
    width, height, fps = 25,
    mosaic = 20, eyeExpand = 0.6, minScore = 0.5,
    crf = 23, useInternal = true, timeout = 300000,
  } = opts;

  console.log('[CONFIG] 解析后的配置参数:');
  console.log(`  - 视频尺寸: ${width}x${height}`);
  console.log(`  - 帧率: ${fps}`);
  console.log(`  - 马赛克强度: ${mosaic}`);
  console.log(`  - 眼睛扩展系数: ${eyeExpand}`);
  console.log(`  - 最小置信度: ${minScore}`);
  console.log(`  - 编码质量: ${crf}`);
  console.log(`  - 使用内网: ${useInternal}`);
  console.log(`  - 超时时间: ${timeout}ms`);

  // 初始化 OSS 客户端，增加超时配置
  console.log('[OSS] 初始化 OSS 客户端...');
  const client = new OSS({
    region,
    accessKeyId,
    accessKeySecret,
    bucket,
    endpoint: useInternal
      ? `${region}-internal.aliyuncs.com`
      : `${region}.aliyuncs.com`,
    timeout: timeout, // 增加超时时间
    retryMax: 3, // 重试次数
  });
  console.log(`[OSS] OSS 客户端初始化完成，endpoint: ${useInternal ? region + '-internal.aliyuncs.com' : region + '.aliyuncs.com'}`);

  // 生成预签名 GET URL
  console.log(`[OSS] 生成预签名 URL，源文件: ${srcKey}`);
  const signedUrl = client.signatureUrl(srcKey, { expires: 3600, method: 'GET' });
  console.log(`[OSS] 预签名 URL 生成完成，有效期: 3600秒`);
  
  const errors = [];
  const collectErr = (prefix) => (data) => {
    const errorMsg = data.toString().trim();
    if (errorMsg) {
      errors.push(`${prefix}: ${errorMsg}`);
      console.error(`${prefix}: ${errorMsg}`);
    }
  };

  // 子进程引用，用于清理
  let ffmpegIn, processor, ffmpegOut;
  let uploadStream;

  // 清理函数
  const cleanup = () => {
    console.log('[CLEANUP] 开始清理资源...');
    try {
      if (ffmpegIn && !ffmpegIn.killed) {
        console.log('[CLEANUP] 终止 ffmpeg-in 进程...');
        ffmpegIn.kill('SIGTERM');
        setTimeout(() => {
          if (!ffmpegIn.killed) {
            console.log('[CLEANUP] 强制终止 ffmpeg-in 进程...');
            ffmpegIn.kill('SIGKILL');
          }
        }, 5000);
      }
      if (processor && !processor.killed) {
        console.log('[CLEANUP] 终止 processor 进程...');
        processor.kill('SIGTERM');
        setTimeout(() => {
          if (!processor.killed) {
            console.log('[CLEANUP] 强制终止 processor 进程...');
            processor.kill('SIGKILL');
          }
        }, 5000);
      }
      if (ffmpegOut && !ffmpegOut.killed) {
        console.log('[CLEANUP] 终止 ffmpeg-out 进程...');
        ffmpegOut.kill('SIGTERM');
        setTimeout(() => {
          if (!ffmpegOut.killed) {
            console.log('[CLEANUP] 强制终止 ffmpeg-out 进程...');
            ffmpegOut.kill('SIGKILL');
          }
        }, 5000);
      }
      if (uploadStream) {
        console.log('[CLEANUP] 销毁上传流...');
        uploadStream.destroy();
      }
      console.log('[CLEANUP] 资源清理完成');
    } catch (e) {
      console.error('[CLEANUP] 清理过程中发生错误:', e);
    }
  };

  try {
    // ffmpeg 解码 - 改进参数
    console.log('[FFMPEG-IN] 启动 ffmpeg 解码进程...');
    const ffmpegInArgs = [
      '-hide_banner', '-loglevel', 'error',
      '-i', signedUrl,
      '-vf', `scale=${width}:${height},fps=${fps}`,
      '-f', 'rawvideo',
      '-pix_fmt', 'rgb24',
      '-y', // 覆盖输出
      'pipe:1'
    ];
    console.log('[FFMPEG-IN] 命令参数:', ffmpegInArgs.join(' '));
    
    ffmpegIn = spawn('ffmpeg', ffmpegInArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    console.log(`[FFMPEG-IN] 进程已启动，PID: ${ffmpegIn.pid}`);
    
    ffmpegIn.stderr.on('data', collectErr('[ffmpeg-in]'));
    ffmpegIn.on('error', (err) => {
      console.error(`[FFMPEG-IN] 进程启动失败: ${err.message}`);
      errors.push(`[ffmpeg-in] spawn error: ${err.message}`);
      cleanup();
    });

    // processor.js (pose-detection 眼睛打码)
    console.log('[PROCESSOR] 启动 pose-detection 处理进程...');
    const processorPath = path.join(__dirname, 'processor.js');
    const processorArgs = [
      processorPath,
      '--width', String(width),
      '--height', String(height),
      '--fps', String(fps),
      '--scoreThreshold', String(minScore), // 修正参数名称
      '--minPoseConfidence', String(minScore), // 添加最小姿态置信度
    ];
    console.log('[PROCESSOR] 命令参数:', processorArgs.join(' '));
    
    processor = spawn('node', processorArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    console.log(`[PROCESSOR] 进程已启动，PID: ${processor.pid}`);
    
    processor.stderr.on('data', collectErr('[processor]'));
    processor.on('error', (err) => {
      console.error(`[PROCESSOR] 进程启动失败: ${err.message}`);
      errors.push(`[processor] spawn error: ${err.message}`);
      cleanup();
    });

    // ffmpeg 编码回 mp4 - 修复 MP4 流式输出问题
    console.log('[FFMPEG-OUT] 启动 ffmpeg 编码进程...');
    const ffmpegOutArgs = [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'rawvideo',
      '-pix_fmt', 'rgb24',
      '-s', `${width}x${height}`,
      '-r', String(fps),
      '-i', 'pipe:0',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', String(crf),
      '-profile:v', 'baseline', // 使用 baseline profile 提高兼容性
      '-level', '3.0',
      '-pix_fmt', 'yuv420p', // 确保输出格式兼容
      '-f', 'mp4',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof', // 支持流式输出
      '-y', // 覆盖输出
      'pipe:1'
    ];
    console.log('[FFMPEG-OUT] 命令参数:', ffmpegOutArgs.join(' '));
    
    ffmpegOut = spawn('ffmpeg', ffmpegOutArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    console.log(`[FFMPEG-OUT] 进程已启动，PID: ${ffmpegOut.pid}`);
    
    ffmpegOut.stderr.on('data', collectErr('[ffmpeg-out]'));
    ffmpegOut.on('error', (err) => {
      console.error(`[FFMPEG-OUT] 进程启动失败: ${err.message}`);
      errors.push(`[ffmpeg-out] spawn error: ${err.message}`);
      cleanup();
    });

    // 管道连接 - 改进错误处理和背压控制
    console.log('[PIPELINE] 开始连接进程管道...');
    
    // 错误处理
    ffmpegIn.stdout.on('error', (err) => {
      console.error(`[PIPELINE] ffmpeg-in stdout 错误: ${err.message}`);
      errors.push(`[ffmpeg-in stdout] error: ${err.message}`);
    });
    
    processor.stdin.on('error', (err) => {
      console.error(`[PIPELINE] processor stdin 错误: ${err.message}`);
      errors.push(`[processor stdin] error: ${err.message}`);
    });
    
    processor.stdout.on('error', (err) => {
      console.error(`[PIPELINE] processor stdout 错误: ${err.message}`);
      errors.push(`[processor stdout] error: ${err.message}`);
    });
    
    ffmpegOut.stdin.on('error', (err) => {
      console.error(`[PIPELINE] ffmpeg-out stdin 错误: ${err.message}`);
      errors.push(`[ffmpeg-out stdin] error: ${err.message}`);
    });

    // 背压控制 - 防止内存溢出
    ffmpegIn.stdout.pause();
    processor.stdout.pause();
    
    // 安全的管道连接，添加背压控制
    console.log('[PIPELINE] 连接 ffmpeg-in → processor');
    ffmpegIn.stdout.pipe(processor.stdin, { highWaterMark: 1024 * 1024 }); // 1MB buffer
    console.log('[PIPELINE] 连接 processor → ffmpeg-out');
    processor.stdout.pipe(ffmpegOut.stdin, { highWaterMark: 1024 * 1024 }); // 1MB buffer
    console.log('[PIPELINE] 管道连接完成');
    
    // 恢复流
    ffmpegIn.stdout.resume();
    processor.stdout.resume();

    // 上传到 OSS - 改进流处理
    console.log('[UPLOAD] 创建上传流...');
    uploadStream = new PassThrough({ highWaterMark: 1024 * 1024 }); // 1MB buffer
    console.log('[UPLOAD] 连接 ffmpeg-out → upload stream');
    ffmpegOut.stdout.pipe(uploadStream, { highWaterMark: 1024 * 1024 });

    // 监听管道错误
    uploadStream.on('error', (err) => {
      console.error(`[UPLOAD] 上传流错误: ${err.message}`);
      errors.push(`[upload stream] error: ${err.message}`);
    });

    const waitExit = (cp, name) =>
      new Promise((resolve) => {
        cp.on('close', (code, signal) => {
          console.log(`[${name.toUpperCase()}] 进程退出，代码: ${code}, 信号: ${signal}`);
          resolve({ name, code, signal });
        });
        cp.on('error', (err) => {
          console.error(`[${name.toUpperCase()}] 进程错误:`, err);
          resolve({ name, code: -1, signal: null, error: err });
        });
      });

    // 改进 OSS 上传，添加重试机制
    const uploadWithRetry = async (retries = 3) => {
      for (let i = 0; i < retries; i++) {
        try {
          console.log(`[OSS] 开始上传到 ${dstKey}，第 ${i + 1} 次尝试...`);
          const result = await client.putStream(dstKey, uploadStream, {
            timeout: timeout,
            headers: {
              'Content-Type': 'video/mp4',
            }
          });
          console.log(`[OSS] 上传成功，ETag: ${result.etag}`);
          return result;
        } catch (error) {
          console.error(`[OSS] 第 ${i + 1} 次上传失败:`, error.message);
          if (i === retries - 1) {
            console.error(`[OSS] 所有重试都失败了，抛出错误`);
            throw error;
          }
          // 等待一段时间后重试
          const waitTime = 2000 * (i + 1);
          console.log(`[OSS] 等待 ${waitTime}ms 后重试...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }
    };

    console.log('[UPLOAD] 开始异步上传任务...');
    const putPromise = uploadWithRetry().catch((e) => {
      console.error(`[UPLOAD] 上传任务失败: ${e?.message || e}`);
      errors.push(`[oss] upload error: ${e?.message || e}`);
      throw e;
    });

    console.log('[WAIT] 等待所有进程完成...');
    const [rIn, rProc, rOut] = await Promise.all([
      waitExit(ffmpegIn, 'ffmpeg-in'),
      waitExit(processor, 'processor'),
      waitExit(ffmpegOut, 'ffmpeg-out'),
    ]).catch((e) => {
      console.error(`[WAIT] 等待进程时发生错误: ${e?.message || e}`);
      errors.push(`[wait] pipeline error: ${e?.message || e}`);
      if (uploadStream && !uploadStream.destroyed) {
        uploadStream.destroy(e);
      }
      throw e;
    });

    console.log('[CHECK] 检查进程退出状态...');
    // 检查进程退出状态
    if (rIn.code !== 0) {
      console.error(`[CHECK] ffmpeg-in 失败，退出代码: ${rIn.code}`);
      throw new Error(`ffmpeg-in failed with code ${rIn.code}: ${errors.join('\n')}`);
    }
    if (rProc.code !== 0) {
      console.error(`[CHECK] processor 失败，退出代码: ${rProc.code}`);
      throw new Error(`processor failed with code ${rProc.code}: ${errors.join('\n')}`);
    }
    if (rOut.code !== 0) {
      console.error(`[CHECK] ffmpeg-out 失败，退出代码: ${rOut.code}`);
      throw new Error(`ffmpeg-out failed with code ${rOut.code}: ${errors.join('\n')}`);
    }
    console.log('[CHECK] 所有进程都成功完成');

    let putRes;
    try {
      console.log('[UPLOAD] 等待上传完成...');
      putRes = await putPromise;
      console.log('[UPLOAD] 上传任务完成');
    } catch (e) {
      console.error(`[UPLOAD] 上传失败，进程状态: in=${rIn.code}, proc=${rProc.code}, out=${rOut.code}`);
      console.error(`[UPLOAD] 错误详情:`, e);
      throw new Error(
        `Upload failed. Stages: in=${rIn.code}, proc=${rProc.code}, out=${rOut.code}.\n` +
        `Error: ${e?.message || e}\n` +
        errors.join('\n')
      );
    }

    console.log('[SUCCESS] 视频眼睛打码处理完成');
    console.log(`[RESULT] 输出文件: ${dstKey}, ETag: ${putRes.etag}`);
    return { ok: true, etag: putRes.etag, dstKey };

  } catch (error) {
    console.error('[ERROR] 处理过程中发生错误:', error.message);
    console.error('[ERROR] 错误堆栈:', error.stack);
    cleanup();
    throw error;
  } finally {
    // 确保清理
    console.log('[FINALLY] 执行最终清理...');
    setTimeout(cleanup, 1000);
  }
}

module.exports = { maskEyesWithPoseNetOSS };