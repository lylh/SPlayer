import {
  AUDIO_EVENTS,
  AudioErrorCode,
  BaseAudioPlayer,
  type AudioEventType,
} from "./BaseAudioPlayer";
import type { EngineCapabilities, FadeCurve } from "./IPlaybackEngine";
import { useSettingStore } from "@/stores";
import { isElectron } from "@/utils/env";

/**
 * 基于 HTMLAudioElement 的播放器实现
 *
 * Electron 环境：通过 MediaElementAudioSourceNode 连接 Web Audio API 音频图谱（支持 EQ、频谱等）
 * Web/移动端环境：直接输出模式，HTML Audio 元素直接播放到扬声器（支持后台/锁屏播放）
 */
export class AudioElementPlayer extends BaseAudioPlayer {
  /** 内部 Audio 元素 */
  private audioElement: HTMLAudioElement;
  /** MediaElementAudioSourceNode 用于连接 Web Audio API */
  private sourceNode: MediaElementAudioSourceNode | null = null;

  /** Seek 锁，用于在 seek 过程中返回稳定的 currentTime */
  private isInternalSeeking = false;
  /** 目标时间缓存，用于在 seek 过程中返回稳定的 currentTime */
  private targetSeekTime = 0;

  /**
   * 直接输出模式：不经过 AudioContext，音频直接从 HTML Audio 元素输出
   * 移动端浏览器后台会 suspend AudioContext 导致无声，必须绕过
   */
  private readonly useDirectOutput: boolean;

  /** 直接输出模式下的淡入淡出定时器 */
  private directFadeTimer: ReturnType<typeof requestAnimationFrame> | null = null;

  /** 引擎能力描述 */
  public override readonly capabilities: EngineCapabilities;

  constructor() {
    super();
    this.useDirectOutput = !isElectron;
    this.audioElement = new Audio();
    this.audioElement.crossOrigin = "anonymous";
    this.bindInternalEvents();

    this.audioElement.addEventListener("seeked", () => {
      this.isInternalSeeking = false;
    });

    // 直接输出模式下不支持 EQ 和频谱
    this.capabilities = {
      supportsRate: true,
      supportsSinkId: true,
      supportsEqualizer: !this.useDirectOutput,
      supportsSpectrum: !this.useDirectOutput,
    };
  }

  /**
   * 初始化：直接输出模式跳过 AudioContext 图谱
   */
  public override init() {
    if (this.useDirectOutput) {
      // 直接输出模式不需要 AudioContext
      this.isInitialized = true;
      return;
    }
    super.init();
  }

  /**
   * 当音频图谱初始化完成时调用
   * 创建 MediaElementAudioSourceNode 并连接到输入节点
   */
  protected onGraphInitialized(): void {
    // 直接输出模式不连接 AudioContext
    if (this.useDirectOutput) return;
    if (!this.audioCtx || !this.inputNode) return;

    try {
      if (!this.sourceNode) {
        this.sourceNode = this.audioCtx.createMediaElementSource(this.audioElement);
      } else {
        this.sourceNode.disconnect();
      }

      // 连接: Source -> Input
      this.sourceNode.connect(this.inputNode);
    } catch (error) {
      console.error("[AudioElementPlayer] SourceNode 创建失败", error);
    }
  }

  /**
   * 加载音频资源
   * @param url 音频地址
   */
  public async load(url: string): Promise<void> {
    this.audioElement.src = url;
    this.audioElement.load();
  }

  /**
   * 播放：直接输出模式绕过 AudioContext
   */
  public override async play(
    url?: string,
    options: {
      fadeIn?: boolean;
      fadeDuration?: number;
      fadeCurve?: FadeCurve;
      autoPlay?: boolean;
      seek?: number;
    } = {},
  ) {
    if (!this.useDirectOutput) {
      return super.play(url, options);
    }

    this.cancelPendingPause();
    const shouldPlay = options.autoPlay ?? true;

    if (url) {
      await this.load(url);
    }

    if (!this.isInitialized) this.init();

    if (options.seek && options.seek > 0) {
      this.doSeek(options.seek);
    }

    if (!shouldPlay) return;

    const duration = options.fadeIn ? (options.fadeDuration ?? 0.5) : 0;

    if (duration > 0) {
      this.audioElement.volume = 0;
      this.directFadeTo(this.volume * this.replayGain, duration);
    } else {
      this.audioElement.volume = this.volume * this.replayGain;
    }

    try {
      await this.doPlay();
    } catch (e) {
      console.error("播放失败", e);
      throw e;
    }
  }

  /**
   * 暂停：直接输出模式不操作 AudioContext
   */
  public override async pause(
    options: {
      fadeOut?: boolean;
      fadeDuration?: number;
      fadeCurve?: FadeCurve;
      keepContextRunning?: boolean;
    } = {},
  ) {
    if (!this.useDirectOutput) {
      return super.pause(options);
    }

    this.cancelPendingPause();
    const duration = options.fadeOut ? (options.fadeDuration ?? 0.5) : 0;

    if (duration > 0) {
      this.directFadeTo(0, duration);
      this.fadeTimerDirect = setTimeout(() => {
        this.doPause();
        this.fadeTimerDirect = null;
      }, duration * 1000);
    } else {
      this.doPause();
    }
  }

  /** 淡出暂停定时器 */
  private fadeTimerDirect: ReturnType<typeof setTimeout> | null = null;

  /**
   * 取消暂停定时器
   */
  protected override cancelPendingPause() {
    super.cancelPendingPause();
    if (this.fadeTimerDirect) {
      clearTimeout(this.fadeTimerDirect);
      this.fadeTimerDirect = null;
    }
    if (this.directFadeTimer) {
      cancelAnimationFrame(this.directFadeTimer);
      this.directFadeTimer = null;
    }
  }

  /**
   * 直接输出模式下的音量渐变
   */
  private directFadeTo(targetVolume: number, duration: number) {
    if (this.directFadeTimer) {
      cancelAnimationFrame(this.directFadeTimer);
      this.directFadeTimer = null;
    }

    const startVolume = this.audioElement.volume;
    const startTime = performance.now();
    const durationMs = duration * 1000;

    const step = () => {
      const elapsed = performance.now() - startTime;
      const progress = Math.min(elapsed / durationMs, 1);
      this.audioElement.volume = startVolume + (targetVolume - startVolume) * progress;

      if (progress < 1) {
        this.directFadeTimer = requestAnimationFrame(step);
      } else {
        this.directFadeTimer = null;
      }
    };

    this.directFadeTimer = requestAnimationFrame(step);
  }

  /**
   * 设置音量
   */
  public override setVolume(value: number) {
    this.volume = Math.max(0, Math.min(1, value));
    if (this.useDirectOutput) {
      this.audioElement.volume = this.volume * this.replayGain;
    } else {
      this.applyFadeTo(this.volume * this.replayGain, 0);
    }
  }

  /**
   * 音量渐变
   */
  public override rampVolumeTo(value: number, duration: number, curve?: FadeCurve) {
    this.volume = Math.max(0, Math.min(1, value));
    if (this.useDirectOutput) {
      this.directFadeTo(this.volume * this.replayGain, duration);
    } else {
      this.applyFadeTo(this.volume * this.replayGain, duration, curve);
    }
  }

  /**
   * 设置 ReplayGain
   */
  public override setReplayGain(gain: number) {
    this.replayGain = gain;
    if (this.useDirectOutput) {
      this.audioElement.volume = this.volume * this.replayGain;
    } else {
      this.applyFadeTo(this.volume * this.replayGain, 0.1);
    }
  }

  /**
   * 恢复播放
   */
  public override async resume(options?: {
    fadeIn?: boolean;
    fadeDuration?: number;
    fadeCurve?: FadeCurve;
  }): Promise<void> {
    await this.play(undefined, options);
  }

  /**
   * 执行底层播放
   * @returns 播放 Promise
   */
  protected async doPlay(): Promise<void> {
    return this.audioElement.play();
  }

  /**
   * 执行底层暂停
   */
  protected doPause(): void {
    this.audioElement.pause();
  }

  /**
   * 跳转到指定时间
   * @param time 目标时间（秒）
   */
  public async seek(time: number): Promise<void> {
    this.isInternalSeeking = true;
    this.targetSeekTime = time;

    this.cancelPendingPause();
    this.doSeek(time);
  }

  /**
   * 停止播放并清理当前音频源
   * 彻底移除 src，防止旧链接后续继续触发 canplay 等事件
   */
  public stop(): void {
    super.stop();
    this.audioElement.removeAttribute("src");
    this.audioElement.load();
  }

  /**
   * 执行底层 Seek
   * @param time 目标时间（秒）
   */
  protected doSeek(time: number): void {
    if (Number.isFinite(time)) {
      this.audioElement.currentTime = time;
    }
  }

  /**
   * 设置播放速率
   * @param value 速率值 (0.5 - 2.0)
   */
  public setRate(value: number): void {
    this.audioElement.playbackRate = value;
    this.audioElement.defaultPlaybackRate = value;
  }

  /**
   * 设置音高偏移
   * @param semitones 半音偏移量
   */
  public setPitchShift(semitones: number): void {
    if ("preservesPitch" in this.audioElement) {
      const el = this.audioElement as HTMLAudioElement & { preservesPitch: boolean };
      el.preservesPitch = semitones === 0;
    }
  }

  /**
   * 获取当前播放速率
   * @returns 当前速率值
   */
  public getRate(): number {
    return this.audioElement.playbackRate;
  }

  /**
   * 设置音频输出设备
   * @param deviceId 设备 ID
   */
  protected async doSetSinkId(deviceId: string): Promise<void> {
    if (typeof this.audioElement.setSinkId === "function") {
      await this.audioElement.setSinkId(deviceId);
    }
  }

  /** 获取当前音频源地址 */
  public get src(): string {
    return this.audioElement.src || "";
  }

  /** 获取音频总时长（秒） */
  public get duration(): number {
    return this.audioElement.duration || 0;
  }

  /**
   * 获取当前播放时间（秒）
   * 如果正在 Seek，返回目标时间以避免进度跳回
   */
  public get currentTime(): number {
    if (this.isInternalSeeking) {
      return this.targetSeekTime;
    }

    // 直接输出模式不需要延迟补偿
    if (this.useDirectOutput) {
      return this.audioElement.currentTime || 0;
    }

    const settingStore = useSettingStore();

    const isPlayback = settingStore.audioLatencyHint === "playback";

    let autoLatency = 0;

    if (isPlayback && this.audioCtx) {
      autoLatency = (this.audioCtx.outputLatency || 0) + (this.audioCtx.baseLatency || 0);
    }
    const manualCompensation = isPlayback ? this.audioDelayCompensation / 1000 : 0;
    // 基础时间 - 自动延迟补偿 + 手动延迟补偿
    return (this.audioElement.currentTime || 0) - autoLatency + manualCompensation;
  }

  /** 获取是否暂停状态 */
  public get paused(): boolean {
    return this.audioElement.paused;
  }

  /**
   * 获取错误码
   * @returns 错误码 (0: 无错误, 1: ABORTED, 2: NETWORK, 3: DECODE, 4: SRC_NOT_SUPPORTED)
   */
  public getErrorCode(): number {
    if (!this.audioElement.error) return 0;
    switch (this.audioElement.error.code) {
      case MediaError.MEDIA_ERR_ABORTED:
        return AudioErrorCode.ABORTED;
      case MediaError.MEDIA_ERR_NETWORK:
        return AudioErrorCode.NETWORK;
      case MediaError.MEDIA_ERR_DECODE:
        return AudioErrorCode.DECODE;
      case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
        return AudioErrorCode.SRC_NOT_SUPPORTED;
      default:
        return 0;
    }
  }

  /**
   * 监听原生 DOM 事件并转发为标准事件
   * 将 HTMLAudioElement 的事件转换为 BaseAudioPlayer 的统一事件格式
   */
  private bindInternalEvents() {
    const events: AudioEventType[] = Object.values(AUDIO_EVENTS);

    events.forEach((eventType) => {
      this.audioElement.addEventListener(eventType, (e) => {
        if (eventType === AUDIO_EVENTS.ERROR) {
          this.dispatch(AUDIO_EVENTS.ERROR, {
            originalEvent: e,
            errorCode: this.getErrorCode(),
          });
        } else {
          this.dispatch(eventType);
        }
      });
    });
  }
}
