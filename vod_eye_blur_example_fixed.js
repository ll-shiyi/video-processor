#!/usr/bin/env node
/**
 * vod_eye_blur_example_fixed.js
 * 示例入口：调用 maskEyesWithPoseNetVOD 按“方案A”处理并上传到 VOD。
 *
 * 特性：
 * - 不强制缩放：若未提供 --width/--height，则由内部 ffprobe 自动探测源尺寸。
 * - 仅 setsar=1 确保显示比例正确，处理前后画面内容一致。
 * - 将处理结果回传到阿里云 VOD，并在控制台输出新视频的 VideoId。
 */

const { maskEyesWithPoseNetVOD } = require('./vod_eye_blur_processor_fixed');
const yargs = require('yargs');
const { hideBin } = require('yargs/helpers');

function ensureEvenOrThrow(name, v) {
  if (v == null) return undefined;
  const n = Number(v) | 0;
  if (n <= 0) throw new Error(`${name} 必须为正整数`);
  if (n % 2 !== 0) throw new Error(`${name} 必须为偶数（yuv420p 要求）`);
  return n;
}

const argv = yargs(hideBin(process.argv))
  // VOD 基本参数
  .option('accessKeyId', { type: 'string', describe: '阿里云 AccessKey ID', demandOption: true })
  .option('accessKeySecret', { type: 'string', describe: '阿里云 AccessKey Secret', demandOption: true })
  .option('region', { type: 'string', default: 'cn-shanghai', describe: 'VOD 区域，例如 cn-shanghai' })
  .option('videoId', { type: 'string', describe: '源视频 VideoId', demandOption: true })

  // 输出的 VOD 视频信息
  .option('outputTitle', { type: 'string', default: '隐私保护处理后的视频（修复版）', describe: '输出视频标题' })
  .option('outputDescription', { type: 'string', default: '使用 MoveNet 进行眼部遮挡处理（方案A：不缩放，仅 setsar=1）', describe: '输出视频描述' })

  // 尺寸/帧率/质量（width/height 可留空，内部自动探测；fps 也可留空用源fps）
  .option('width', { type: 'number', describe: '处理尺寸宽（偶数）。缺省=自动探测源宽' })
  .option('height', { type: 'number', describe: '处理尺寸高（偶数）。缺省=自动探测源高' })
  .option('fps', { type: 'number', describe: '输出帧率（缺省=自动取源fps的近似值）' })
  .option('crf', { type: 'number', default: 23, describe: 'x264 CRF（质量/码率权衡）' })
  .option('timeout', { type: 'number', default: 300000, describe: '上传超时时间（毫秒）' })

  // 检测/遮罩参数（传递给 processor_yuv.js）
  .option('minScore', { type: 'number', default: 0.1, describe: '关键点最小置信度阈值（同时用于 scoreThreshold 与 minPoseConfidence）' })
  .option('detectScale', { type: 'number', default: 0.5, describe: '检测降采样比例（0~1，越小越快但越糊）' })
  .option('detectEvery', { type: 'number', default: 3, describe: '每隔多少帧做一次检测' })
  .option('enableSmoothing', { type: 'boolean', default: true, describe: '启用关键点平滑' })
  .option('adaptiveSkip', { type: 'boolean', default: true, describe: '小位移时跳过检测' })
  .option('maxDetections', { type: 'number', default: 5, describe: '最大同时检测人数' })
  .option('maskScaleW', { type: 'number', default: 1.3, describe: '面具宽度缩放' })
  .option('maskScaleH', { type: 'number', default: 1.8, describe: '面具高度缩放' })
  .option('samplesPerCurve', { type: 'number', default: 28, describe: '超椭圆采样点数' })
  .option('strokeWidth', { type: 'number', default: 1, describe: '描边宽度（像素）' })

  .help()
  .alias('h', 'help')
  .strict()
  .argv;

(async () => {
  try {
    // 校验（仅当用户显式提供了尺寸时）
    const width = ensureEvenOrThrow('width', argv.width);
    const height = ensureEvenOrThrow('height', argv.height);

    const config = {
      accessKeyId: argv.accessKeyId,
      accessKeySecret: argv.accessKeySecret,
      region: argv.region,

      videoId: argv.videoId,
      outputTitle: argv.outputTitle,
      outputDescription: argv.outputDescription,

      // 尺寸/帧率/质量：width/height/fps 均可省略，交由处理器内部 ffprobe 自动探测
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
      ...(argv.fps ? { fps: Number(argv.fps) } : {}),
      crf: Number(argv.crf),
      timeout: Number(argv.timeout),

      // 检测/遮罩参数
      minScore: Number(argv.minScore),
      detectScale: Number(argv.detectScale),
      detectEvery: Number(argv.detectEvery),
      enableSmoothing: !!argv.enableSmoothing,
      adaptiveSkip: !!argv.adaptiveSkip,
      maxDetections: Number(argv.maxDetections),
      maskScaleW: Number(argv.maskScaleW),
      maskScaleH: Number(argv.maskScaleH),
      samplesPerCurve: Number(argv.samplesPerCurve),
      strokeWidth: Number(argv.strokeWidth),
    };

    console.log('开始处理（方案A：不缩放，仅 setsar=1）…');
    console.log('配置参数：', JSON.stringify(config, null, 2));

    const result = await maskEyesWithPoseNetVOD(config);

    if (result && result.success) {
      console.log('✅ 处理成功！');
      console.log(`📹 新视频 VideoId: ${result.outputVideoId}`);
      if (result.width && result.height) {
        console.log(`📐 输出尺寸: ${result.width}x${result.height}`);
      }
      if (result.fps) {
        console.log(`🎞️ FPS: ${result.fps}`);
      }
      console.log(`⏱️ 耗时: ${result.processingTime}ms`);
      if (result.errors?.length) {
        console.log('⚠️ 过程中有一些警告:');
        result.errors.forEach((e) => console.log('   - ' + e));
      }
      process.exit(0);
    } else {
      console.error('❌ 处理失败：', result?.error || '未知错误');
      if (result?.errors?.length) {
        console.error('详细错误：');
        result.errors.forEach((e) => console.error('   - ' + e));
      }
      process.exit(1);
    }
  } catch (err) {
    console.error('❌ 程序异常：', err.message || err);
    process.exit(1);
  }
})();
