/**
 * vod_uploader.js - VOD上传器
 * 使用OSS SDK实现VOD视频上传功能
 */

const OSS = require('ali-oss');
const fs = require('fs');
const path = require('path');

/**
 * VOD上传器类
 */
class VodUploader {
  constructor(accessKeyId, accessKeySecret, region = 'cn-shanghai') {
    this.accessKeyId = accessKeyId;
    this.accessKeySecret = accessKeySecret;
    this.region = region;
  }

  /**
   * 获取VOD上传凭证
   * @param {Object} vodClient - VOD客户端
   * @param {Object} options - 上传选项
   * @returns {Promise<Object>} 上传凭证
   */
  async getUploadCredentials(vodClient, options) {
    const vod = require('@alicloud/vod20170321');
    const CreateUploadVideoRequest = vod.CreateUploadVideoRequest;
    
    const request = new CreateUploadVideoRequest({
      title: options.title || '上传的视频',
      description: options.description || '',
      fileName: options.fileName,
      fileSize: options.fileSize,
      cateId: options.cateId || 0,
      tags: options.tags || '',
      coverURL: options.coverURL || '',
      userData: options.userData || '',
      templateGroupId: options.templateGroupId || '',
      workflowId: options.workflowId || '',
      storageLocation: options.storageLocation || '',
      appId: options.appId || '',
    });

    try {
      const response = await vodClient.createUploadVideo(request);
      console.log('[UPLOAD] 获取上传凭证成功');

      
      return {
        videoId: response.body.videoId,
        uploadAddress: response.body.uploadAddress,
        uploadAuth: response.body.uploadAuth,
        requestId: response.body.requestId
      };
    } catch (error) {
      console.error('[UPLOAD] 获取上传凭证失败:', error.message);
      throw error;
    }
  }

  /**
   * 解析上传地址和认证信息
   * @param {string} uploadAddress - 上传地址
   * @param {string} uploadAuth - 上传认证信息
   * @returns {Object} 解析后的OSS配置
   */
  parseUploadInfo(uploadAddress, uploadAuth) {
    try {
      // 解析上传地址（base64解码）
      const addressData = JSON.parse(Buffer.from(uploadAddress, 'base64').toString());
      console.log('[UPLOAD] 解析的上传地址:', addressData);
      
      // 解析认证信息（base64解码）
      const auth = JSON.parse(Buffer.from(uploadAuth, 'base64').toString());
      
      return {
        bucket: addressData.Bucket,
        region: auth.Region,
        accessKeyId: auth.AccessKeyId,
        accessKeySecret: auth.AccessKeySecret,
        securityToken: auth.SecurityToken,
        endpoint: addressData.Endpoint,
        objectKey: addressData.FileName
      };
    } catch (error) {
      console.error('[UPLOAD] 解析上传信息失败:', error.message);
      throw new Error('上传信息格式错误');
    }
  }

  /**
   * 创建OSS客户端
   * @param {Object} ossConfig - OSS配置
   * @returns {OSS} OSS客户端实例
   */
  createOssClient(ossConfig) {
    return new OSS({
      accessKeyId: ossConfig.accessKeyId,
      accessKeySecret: ossConfig.accessKeySecret,
      stsToken: ossConfig.securityToken,
      bucket: ossConfig.bucket,
      endpoint: ossConfig.endpoint,
      region: ossConfig.region,
      secure: true,
      timeout: 120000, // 2分钟超时
    });
  }

  /**
   * 上传文件到VOD
   * @param {string} filePath - 本地文件路径
   * @param {Object} vodClient - VOD客户端
   * @param {Object} options - 上传选项
   * @returns {Promise<Object>} 上传结果
   */
  async uploadToVod(filePath, vodClient, options = {}) {
    console.log('[UPLOAD] 开始上传文件到VOD...');
    console.log('[UPLOAD] 文件路径:', filePath);
    
    try {
      // 检查文件是否存在
      if (!fs.existsSync(filePath)) {
        throw new Error(`文件不存在: ${filePath}`);
      }

      const fileStats = fs.statSync(filePath);
      const fileName = path.basename(filePath);
      
      console.log('[UPLOAD] 文件信息:', {
        fileName,
        fileSize: fileStats.size,
        lastModified: new Date(fileStats.mtime).toISOString()
      });

      // 1. 获取上传凭证
      const credentials = await this.getUploadCredentials(vodClient, {
        title: options.title || `上传的视频_${Date.now()}`,
        description: options.description || '通过AI处理的视频',
        fileName: fileName,
        fileSize: fileStats.size,
        cateId: options.cateId || 0,
        tags: options.tags || '',
        ...options
      });

      // 2. 解析上传信息
      const ossConfig = this.parseUploadInfo(credentials.uploadAddress, credentials.uploadAuth);
      console.log('[UPLOAD] OSS配置:', {
        bucket: ossConfig.bucket,
        region: ossConfig.region,
        endpoint: ossConfig.endpoint,
        objectKey: ossConfig.objectKey
      });

      // 3. 创建OSS客户端
      const ossClient = this.createOssClient(ossConfig);

      // 4. 上传文件
      console.log('[UPLOAD] 开始上传到OSS...');
      const uploadResult = await this.uploadToOss(ossClient, filePath, ossConfig.objectKey, options);

      // 5. 刷新上传凭证
      await this.refreshUploadCredentials(vodClient, credentials.videoId);

      console.log('[UPLOAD] 上传完成');
      return {
        success: true,
        videoId: credentials.videoId,
        requestId: credentials.requestId,
        etag: uploadResult.etag,
        fileSize: fileStats.size,
        uploadTime: new Date().toISOString()
      };

    } catch (error) {
      console.error('[UPLOAD] 上传失败:', error.message);
      throw error;
    }
  }

  /**
   * 上传文件到OSS
   * @param {OSS} ossClient - OSS客户端
   * @param {string} filePath - 本地文件路径
   * @param {string} objectKey - OSS对象键
   * @param {Object} options - 上传选项
   * @returns {Promise<Object>} 上传结果
   */
  async uploadToOss(ossClient, filePath, objectKey, options = {}) {
    return new Promise((resolve, reject) => {
      const fileSize = fs.statSync(filePath).size;
      let uploadedBytes = 0;
      let lastProgressTime = Date.now();

      // 创建文件读取流
      const fileStream = fs.createReadStream(filePath);
      
      // 监听进度
      fileStream.on('data', (chunk) => {
        uploadedBytes += chunk.length;
        const now = Date.now();
        
        // 每秒最多输出一次进度
        if (now - lastProgressTime > 1000) {
          const progress = ((uploadedBytes / fileSize) * 100).toFixed(2);
          console.log(`[UPLOAD] 上传进度: ${progress}% (${uploadedBytes}/${fileSize} bytes)`);
          lastProgressTime = now;
        }
      });

      // 执行上传
      ossClient.putStream(objectKey, fileStream, {
        progress: (p, checkpoint) => {
          if (options.onProgress) {
            options.onProgress(p, checkpoint);
          }
        },
        timeout: options.timeout || 300000, // 5分钟超时
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Length': fileSize
        }
      }).then(result => {
        console.log('[UPLOAD] OSS上传成功');
        console.log('[UPLOAD] ETag:', result.etag);
        resolve(result);
      }).catch(error => {
        console.error('[UPLOAD] OSS上传失败:', error.message);
        reject(error);
      });
    });
  }

  /**
   * 刷新上传凭证
   * @param {Object} vodClient - VOD客户端
   * @param {string} videoId - 视频ID
   * @returns {Promise<void>}
   */
  async refreshUploadCredentials(vodClient, videoId) {
    try {
      const { RefreshUploadVideoRequest } = require('@alicloud/vod20170321');
      
      const request = new RefreshUploadVideoRequest({
        videoId: videoId
      });

      await vodClient.refreshUploadVideo(request);
      console.log('[UPLOAD] 刷新上传凭证成功');
    } catch (error) {
      console.warn('[UPLOAD] 刷新上传凭证失败:', error.message);
      // 刷新失败不影响上传结果
    }
  }

  /**
   * 获取视频信息
   * @param {Object} vodClient - VOD客户端
   * @param {string} videoId - 视频ID
   * @returns {Promise<Object>} 视频信息
   */
  async getVideoInfo(vodClient, videoId) {
    try {
      const { GetVideoInfoRequest } = require('@alicloud/vod20170321');
      
      const request = new GetVideoInfoRequest({
        videoId: videoId
      });

      const response = await vodClient.getVideoInfo(request);
      console.log('[VOD] 获取视频信息成功');
      
      return {
        videoId: response.body.video.videoId,
        title: response.body.video.title,
        description: response.body.video.description,
        duration: response.body.video.duration,
        size: response.body.video.size,
        status: response.body.video.status,
        createTime: response.body.video.createTime,
        coverURL: response.body.video.coverURL,
        playURL: response.body.video.playURL
      };
    } catch (error) {
      console.error('[VOD] 获取视频信息失败:', error.message);
      throw error;
    }
  }
}

module.exports = VodUploader;
