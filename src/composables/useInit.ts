import { mediaSessionManager } from "@/core/player/MediaSessionManager";
import { usePlayerController } from "@/core/player/PlayerController";
import { useDownloadManager } from "@/core/resource/DownloadManager";
import { useDataStore, useSettingStore, useShortcutStore, useStatusStore } from "@/stores";
import { TASKBAR_IPC_CHANNELS } from "@/types/shared";
import { isElectron, isMac } from "@/utils/env";
import { printVersion } from "@/utils/log";
import { openUserAgreement } from "@/utils/modal";

import { useEventListener } from "@vueuse/core";
import { debounce } from "lodash-es";
import { onMounted, watch } from "vue";

/** 最终聚焦主窗口的延迟时间（毫秒） */
const FINAL_FOCUS_DELAY_MS = 500;

/** 页面隐藏前是否正在播放 */
let wasPlayingBeforeHidden = false;

/** Web Lock 控制器，用于释放保活锁 */
let webLockAbort: AbortController | null = null;

/** Screen Wake Lock 句柄 */
let wakeLockSentinel: WakeLockSentinel | null = null;

/**
 * 请求 Web Lock 保活
 * 告诉浏览器当前页面有活跃任务，避免后台节流
 */
const requestWebLock = () => {
  if (isElectron || !navigator.locks) return;
  releaseWebLock();
  webLockAbort = new AbortController();
  navigator.locks
    .request("splayer-audio-active", { signal: webLockAbort.signal }, () => {
      // 持有锁直到被 abort
      return new Promise<void>(() => {});
    })
    .catch(() => {
      // abort 时正常退出
    });
};

/**
 * 释放 Web Lock
 */
const releaseWebLock = () => {
  if (webLockAbort) {
    webLockAbort.abort();
    webLockAbort = null;
  }
};

/**
 * 请求 Screen Wake Lock 防止屏幕锁定
 */
const requestWakeLock = async () => {
  if (isElectron || !("wakeLock" in navigator)) return;
  try {
    wakeLockSentinel = await navigator.wakeLock.request("screen");
    wakeLockSentinel.addEventListener("release", () => {
      wakeLockSentinel = null;
    });
  } catch {
    // 用户或系统拒绝
  }
};

/**
 * 释放 Screen Wake Lock
 */
const releaseWakeLock = async () => {
  if (wakeLockSentinel) {
    await wakeLockSentinel.release().catch(() => {});
    wakeLockSentinel = null;
  }
};
/**
 * 处理页面可见性变化
 * 移动端锁屏恢复后自动续播
 */
const handleVisibilityChange = () => {
  const player = usePlayerController();
  const statusStore = useStatusStore();

  if (document.hidden) {
    wasPlayingBeforeHidden = statusStore.playStatus && !statusStore.playLoading;
  } else {
    // 如果之前正在播放但现在停了，重新播放
    if (wasPlayingBeforeHidden) {
      wasPlayingBeforeHidden = false;
      if (!statusStore.playStatus && !statusStore.playLoading) {
        player.play();
      }
    }

    // 重新获取 Wake Lock（锁屏后会自动释放）
    if (statusStore.playStatus) {
      requestWakeLock();
    }
  }
};

/**
 * 应用初始化时需要执行的操作
 */
export const useInit = () => {
  // init pinia-data
  const dataStore = useDataStore();
  const statusStore = useStatusStore();
  const settingStore = useSettingStore();
  const shortcutStore = useShortcutStore();

  const player = usePlayerController();
  const downloadManager = useDownloadManager();

  // 事件监听
  initEventListener();

  onMounted(async () => {
    // 监听页面可见性变化（移动端锁屏恢复后自动续播）
    useEventListener(document, "visibilitychange", handleVisibilityChange);
    // 检查并执行设置迁移
    settingStore.checkAndMigrate();
    // 打印版本信息
    printVersion();
    // 用户协议
    openUserAgreement();
    // 加载数据
    await dataStore.loadData();
    // 初始化 MediaSession
    mediaSessionManager.init();
    // 初始化播放器
    player.playSong({
      autoPlay: settingStore.autoPlay,
      seek: settingStore.memoryLastSeek ? statusStore.currentTime : 0,
    });
    // 同步播放模式
    player.playModeSyncIpc();
    // 初始化自动关闭定时器
    if (statusStore.autoClose.enable) {
      const { endTime, time } = statusStore.autoClose;
      const now = Date.now();
      if (endTime > now) {
        // 计算真实剩余时间
        const realRemainTime = Math.ceil((endTime - now) / 1000);
        player.startAutoCloseTimer(time, realRemainTime);
      } else {
        // 定时器已过期，重置状态
        statusStore.autoClose.enable = false;
        statusStore.autoClose.remainTime = time * 60;
        statusStore.autoClose.endTime = 0;
      }
    }

    // 监听设置变化以更新 ReplayGain
    watch(
      () => [settingStore.enableReplayGain, settingStore.replayGainMode],
      () => player.applyReplayGain(),
    );

    // 监听播放状态，控制后台保活
    if (!isElectron) {
      watch(
        () => statusStore.playStatus,
        (playing) => {
          if (playing) {
            requestWebLock();
            requestWakeLock();
          } else {
            releaseWebLock();
            releaseWakeLock();
          }
        },
        { immediate: true },
      );
    }

    if (isElectron) {
      // 注册全局快捷键
      shortcutStore.registerAllShortcuts();
      // 初始化下载管理器
      downloadManager.init();
      // 显示窗口
      window.electron.ipcRenderer.send("win-loaded");
      // 同步任务栏歌词状态
      const taskbarConfig = await window.electron.ipcRenderer.invoke(
        TASKBAR_IPC_CHANNELS.GET_OPTION,
      );
      statusStore.showTaskbarLyric =
        taskbarConfig?.enabled ?? statusStore.showTaskbarLyric ?? false;
      window.electron.ipcRenderer.send(
        TASKBAR_IPC_CHANNELS.SET_OPTION,
        { enabled: statusStore.showTaskbarLyric },
        true,
      );
      // 显示桌面歌词
      window.electron.ipcRenderer.send("desktop-lyric:toggle", statusStore.showDesktopLyric);
      // 检查更新
      if (settingStore.checkUpdateOnStart) window.electron.ipcRenderer.send("check-update", false);
      // 如果启用macOS歌词，发送初始数据
      if (isMac && settingStore.macos.statusBarLyric.enabled) {
        window.electron.ipcRenderer.send(TASKBAR_IPC_CHANNELS.REQUEST_DATA);
      }
      // 确保主窗口在最后获得焦点
      if (statusStore.showDesktopLyric) {
        setTimeout(() => {
          window.electron.ipcRenderer.send("win-show-main");
        }, FINAL_FOCUS_DELAY_MS);
      }
    }
  });
};

// 事件监听
const initEventListener = () => {
  // 键盘事件
  useEventListener(window, "keydown", keyDownEvent);
};

// 键盘事件
const keyDownEvent = debounce((event: KeyboardEvent) => {
  const player = usePlayerController();
  const shortcutStore = useShortcutStore();
  const statusStore = useStatusStore();
  const target = event.target as HTMLElement;
  // 排除元素
  const extendsDom = ["input", "textarea"];
  if (extendsDom.includes(target.tagName.toLowerCase())) return;
  event.preventDefault();
  event.stopPropagation();
  // 获取按键信息
  const key = event.code;
  const isCtrl = event.ctrlKey || event.metaKey;
  const isShift = event.shiftKey;
  const isAlt = event.altKey;
  // 循环注册快捷键
  for (const shortcutKey in shortcutStore.shortcutList) {
    const shortcut = shortcutStore.shortcutList[shortcutKey];
    const shortcutParts = shortcut.shortcut.split("+");
    // 标志位
    let match = true;
    // 检查是否包含修饰键
    const hasCmdOrCtrl = shortcutParts.includes("CmdOrCtrl");
    const hasShift = shortcutParts.includes("Shift");
    const hasAlt = shortcutParts.includes("Alt");
    // 检查修饰键匹配
    if (hasCmdOrCtrl && !isCtrl) match = false;
    if (hasShift && !isShift) match = false;
    if (hasAlt && !isAlt) match = false;
    // 如果快捷键定义中没有修饰键，确保没有按下任何修饰键
    if (!hasCmdOrCtrl && !hasShift && !hasAlt) {
      if (isCtrl || isShift || isAlt) match = false;
    }
    // 检查实际按键
    const mainKey = shortcutParts.find(
      (part: string) => part !== "CmdOrCtrl" && part !== "Shift" && part !== "Alt",
    );
    if (mainKey !== key) match = false;
    if (match && shortcutKey) {
      console.log(shortcutKey, `快捷键触发: ${shortcut.name}`);
      switch (shortcutKey) {
        case "playOrPause":
          player.playOrPause();
          break;
        case "playPrev":
          player.nextOrPrev("prev");
          break;
        case "playNext":
          player.nextOrPrev("next");
          break;
        case "seekForward":
          player.seekBy(5000);
          break;
        case "seekBackward":
          player.seekBy(-5000);
          break;
        case "volumeUp":
          player.setVolume("up");
          break;
        case "volumeDown":
          player.setVolume("down");
          break;
        case "toggle-desktop-lyric":
          player.toggleDesktopLyric();
          break;
        case "openPlayer":
          // 打开播放界面（任意界面）
          statusStore.showFullPlayer = true;
          break;
        case "closePlayer":
          // 关闭播放界面（仅在播放界面时）
          if (statusStore.showFullPlayer) {
            statusStore.showFullPlayer = false;
          }
          break;
        case "openPlayList":
          // 打开播放列表（任意界面）
          statusStore.playListShow = !statusStore.playListShow;
          break;
        default:
          break;
      }
    }
  }
}, 100);
