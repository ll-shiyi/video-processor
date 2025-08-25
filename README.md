# 视频隐私保护处理器

这是一个基于 MoveNet 的视频隐私保护处理工具，专门用于对视频中的人脸进行眼部遮挡处理。

## 功能特性

- 🎯 基于 MoveNet 的精确姿态检测
- 👁️ 智能眼部遮挡，仅遮挡鼻子以上区域
- 📱 针对手机视频优化的处理参数
- 🔄 自动保持视频原始宽高比，避免变形
- ⚡ 高效的 YUV420P 管线处理
- ☁️ 支持阿里云 VOD 上传

## 手机视频优化

### 问题解决

手机端拍摄的视频打码处理后出现变形的问题已得到解决：

1. **自动宽高比保持**：系统会自动检测原始视频尺寸，保持宽高比
2. **智能缩放**：使用 `force_original_aspect_ratio=decrease` 避免强制拉伸
3. **优化参数**：针对手机视频特性优化的检测和渲染参数

### 使用方法

#### 1. 自适应版本（推荐）

```bash
node vod_eye_blur_example_adaptive.js --videoId YOUR_VIDEO_ID --accessKeyId YOUR_KEY --accessKeySecret YOUR_SECRET
```

#### 2. 手机视频专用模式

```bash
node vod_eye_blur_example_adaptive.js --videoId YOUR_VIDEO_ID --accessKeyId YOUR_KEY --accessKeySecret YOUR_SECRET --mobileOptimized
```

#### 3. 自定义参数

```bash
node vod_eye_blur_example_adaptive.js \
  --videoId YOUR_VIDEO_ID \
  --accessKeyId YOUR_KEY \
  --accessKeySecret YOUR_SECRET \
  --width 1080 \
  --height 1920 \
  --fps 30 \
  --crf 18 \
  --minScore 0.2 \
  --detectScale 0.35 \
  --detectEvery 1 \
  --maskScaleW 1.5 \
  --maskScaleH 2.2
```

#### 4. 测试优化效果

```bash
node test_mobile_optimization.js
```

## 参数说明

### 视频处理参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `width` | 1080 | 视频宽度（必须为偶数） |
| `height` | 1920 | 视频高度（必须为偶数） |
| `fps` | 30 | 视频帧率 |
| `crf` | 20 | 视频质量（18-28，越小质量越高） |

### 检测参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `minScore` | 0.15 | 置信度阈值 |
| `detectScale` | 0.4 | 检测缩放比例 |
| `detectEvery` | 2 | 每隔几帧检测一次 |
| `maxDetections` | 3 | 最大检测数量 |

### 面具参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `maskScaleW` | 1.4 | 面具宽度缩放 |
| `maskScaleH` | 2.0 | 面具高度缩放 |
| `samplesPerCurve` | 32 | 曲线采样点数量 |
| `strokeWidth` | 2 | 描边宽度 |

## 自适应版本特性

### 智能尺寸处理

自适应版本具有以下特性：

1. **自动检测原始尺寸**：使用 ffprobe 获取原始视频尺寸
2. **智能计算处理尺寸**：根据原始宽高比计算最佳处理尺寸
3. **保持原始宽高比**：避免强制拉伸导致的画面变形
4. **支持最大/最小尺寸限制**：确保处理效率和质量
5. **确保偶数尺寸**：满足 YUV420P 编码要求

### 手机视频优化特性

#### 自动宽高比保持

系统会自动：
1. 检测原始视频尺寸
2. 计算最佳目标尺寸
3. 保持原始宽高比
4. 避免画面变形

### 优化参数

手机视频专用模式包含以下优化：

- **更高帧率**：30fps 适应手机视频
- **更高质量**：CRF 18 减少压缩伪影
- **更精确检测**：每帧检测，提高准确性
- **更大面具**：适应手机竖屏比例
- **更平滑曲线**：40个采样点，提高面具质量

## 环境要求

- Node.js 16+
- ffmpeg
- ffprobe
- 阿里云 VOD 服务

## 安装依赖

```bash
npm install
```

## 注意事项

1. 确保 `width` 和 `height` 参数为偶数（YUV420P 要求）
2. 手机视频建议使用 `--mobileOptimized` 参数
3. 处理时间取决于视频长度和复杂度
4. 建议在测试环境先验证效果

## 故障排除

### 视频变形问题

如果仍然出现变形，请检查：

1. 是否使用了 `--mobileOptimized` 参数
2. 确认 ffprobe 能正确获取视频信息
3. 检查日志中的"原始视频尺寸"和"调整后尺寸"信息

### 性能优化

- 降低 `detectEvery` 值可提高检测频率
- 降低 `maxDetections` 值可提高处理速度
- 调整 `crf` 值可平衡质量和文件大小