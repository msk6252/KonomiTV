
import IPlaybackEngine from '@/services/player/engine/IPlaybackEngine';


/**
 * DPlayer (`node_modules/dplayer`) が内部で生成する実 `<video>` 要素を、video 要素を使わない自前再生エンジンの
 * `<canvas>` に置き換えるためのシム
 *
 * DPlayer の `player.ts`/`controller.ts` は `this.video` を型上 `HTMLVideoElement` として扱うが、実行時には
 * プロパティ/メソッドの形が合っていれば動作する (TypeScript の型チェックは実行時には存在しないため)。
 * そこで DPlayer 本体 (node_modules) には一切手を入れず、`<canvas>` という実 DOM 要素に対して
 * `HTMLVideoElement` が持つプロパティ/メソッドのうち、DPlayer と KonomiTV 側コードが実際に参照しているものだけを
 * `IPlaybackEngine` へ委譲する形で生やし、呼び出し元からは「video 要素」に見えるようにする
 *
 * `IPlaybackEngine` の実装は WebCodecs 自前再生エンジンの `MediaClock` のほか、Tesla 車載ブラウザ向け
 * Broadway.js エンジンが使う「plain `<audio>` 要素に委譲するだけの軽量アダプター」
 * (`AudioElementPlaybackEngineAdapter`) でも共用する。いずれも再生制御の実体を持たない「見た目だけの video 要素」
 * が必要という点は同じため
 *
 * イベントについては、`IPlaybackEngine` (EventTarget) 上で発火したイベントを canvas 要素自身にも re-dispatch する
 * ことで、`video.addEventListener('timeupdate', ...)` や `video.oncanplay = ...` のようなブラウザ標準の
 * イベント購読方法がそのまま (シム側で addEventListener を再実装せずに) 動作するようにしている
 */

// DPlayer (`events.ts` の videoEvents) および KonomiTV 側コードが購読している HTMLMediaElement イベント一覧
const BRIDGED_EVENT_TYPES = [
    'abort', 'canplay', 'canplaythrough', 'durationchange', 'emptied', 'ended', 'error',
    'loadeddata', 'loadedmetadata', 'loadstart', 'pause', 'play', 'playing', 'progress',
    'ratechange', 'resize', 'seeked', 'seeking', 'stalled', 'suspend', 'timeupdate', 'volumechange', 'waiting',
];

class SimpleTimeRanges implements TimeRanges {
    private readonly ranges: { start: number; end: number }[];
    constructor(ranges: { start: number; end: number }[]) {
        this.ranges = ranges;
    }
    public get length(): number {
        return this.ranges.length;
    }
    public start(index: number): number {
        return this.ranges[index].start;
    }
    public end(index: number): number {
        return this.ranges[index].end;
    }
}

/**
 * canvas 要素に HTMLVideoElement 互換のプロパティ/メソッドを生やし、`HTMLVideoElement` として返す
 * (呼び出し元で `dplayer_instance.video = createVideoElementShim(...)` のように代入することを想定)
 *
 * @param canvas 表示に使う実 canvas 要素
 * @param mediaClock 再生時刻等のデータを読み書きする先 (currentTime の "読み取り" はここから行う)
 * @param requestSeek `currentTime` への代入 (= シーク要求) があったときに呼ばれるコールバック
 *   委譲先の更新だけでは実際にソースから新しい位置のセグメントを取得し直す処理が走らないため、
 *   呼び出し元 (PlayerController) は通常 `PlaybackEngine.seek()` を呼ぶ関数を渡す
 *   (Broadway.js エンジンではシーク非対応のライブ視聴専用のため、空の関数を渡す想定)
 */
// このシムで生成した video 風オブジェクトかどうかを判別するための非公開マーカー (列挙不可、値の読み取りのみ用途)
// WebCodecs エンジン・Broadway.js エンジンのいずれでも使われる (どちらも実 video 要素を使わないため、
// DocumentPiPManager 側では「実 video 要素が無く classic PiP が使えない」という同じ扱いをする)
const CUSTOM_ENGINE_SHIM_MARKER = '__konomitv_custom_engine_shim__';

/** 渡された要素が createVideoElementShim() で生成されたシムかどうかを判定する */
export function isCustomEngineVideoElement(video: HTMLVideoElement | null): boolean {
    return video !== null && (video as unknown as Record<string, unknown>)[CUSTOM_ENGINE_SHIM_MARKER] === true;
}

function createVideoElementShim(canvas: HTMLCanvasElement, mediaClock: IPlaybackEngine, requestSeek: (positionSeconds: number) => void): HTMLVideoElement {
    const shim = canvas as unknown as HTMLVideoElement & { [key: string]: unknown };
    Object.defineProperty(shim, CUSTOM_ENGINE_SHIM_MARKER, { value: true, enumerable: false });

    Object.defineProperty(shim, 'currentTime', {
        get: () => mediaClock.currentTime,
        set: (value: number) => { requestSeek(value); },
    });
    Object.defineProperty(shim, 'duration', { get: () => mediaClock.duration });
    Object.defineProperty(shim, 'paused', { get: () => mediaClock.paused });
    Object.defineProperty(shim, 'volume', {
        get: () => mediaClock.volume,
        set: (value: number) => { mediaClock.volume = value; },
    });
    Object.defineProperty(shim, 'muted', {
        get: () => mediaClock.muted,
        set: (value: boolean) => { mediaClock.muted = value; },
    });
    Object.defineProperty(shim, 'playbackRate', {
        get: () => mediaClock.playbackRate,
        set: (value: number) => { mediaClock.playbackRate = value; },
    });
    Object.defineProperty(shim, 'buffered', { get: () => mediaClock.buffered });
    Object.defineProperty(shim, 'seekable', {
        // シークは常にプレイリスト全体に対して可能なため、[0, duration] をそのまま返す
        get: () => new SimpleTimeRanges(Number.isFinite(mediaClock.duration) ? [{ start: 0, end: mediaClock.duration }] : []),
    });
    Object.defineProperty(shim, 'played', {
        // 厳密な再生済み区間ではなく [0, currentTime] の近似値で十分 (info-panel 等の表示用途のみ)
        get: () => new SimpleTimeRanges(mediaClock.currentTime > 0 ? [{ start: 0, end: mediaClock.currentTime }] : []),
    });
    Object.defineProperty(shim, 'readyState', { get: () => mediaClock.readyState });
    Object.defineProperty(shim, 'videoWidth', { get: () => mediaClock.videoWidth });
    Object.defineProperty(shim, 'videoHeight', { get: () => mediaClock.videoHeight });
    Object.defineProperty(shim, 'error', { get: () => mediaClock.error });
    // WebVTT 字幕は KonomiTV では使わないため、空の TextTrackList 相当 (length 0) で十分
    Object.defineProperty(shim, 'textTracks', { get: () => Object.assign([], { length: 0 }) });

    shim.play = (): Promise<void> => mediaClock.play();
    shim.pause = (): void => mediaClock.pause();
    // ドロップフレーム数等は Phase 1 では計測していないため、仕様を満たす形だけのダミー値を返す
    (shim as unknown as { getVideoPlaybackQuality(): VideoPlaybackQuality }).getVideoPlaybackQuality = () => ({
        creationTime: performance.now(),
        droppedVideoFrames: 0,
        totalVideoFrames: 0,
        corruptedVideoFrames: 0,
    } as VideoPlaybackQuality);
    shim.canPlayType = () => '';
    // Picture-in-Picture は DocumentPiPManager が Document PiP 対応ブラウザでのみ別途フックする
    // (対応していないブラウザではハードポイントの設計通り機能自体を諦めるため、ここでは常に拒否する)
    shim.requestPictureInPicture = () => Promise.reject(new DOMException('Picture-in-Picture is not available', 'NotSupportedError'));
    (shim as unknown as { webkitEnterFullscreen?(): void }).webkitEnterFullscreen = () => { /* 何もしない (KonomiTV は独自の全画面実装を使う) */ };
    (shim as unknown as { webkitShowPlaybackTargetPicker?(): void }).webkitShowPlaybackTargetPicker = () => { /* AirPlay は未対応 */ };

    // MediaClock 上で発火したイベントを canvas 要素自身にも re-dispatch する
    // (これにより video.addEventListener(...) / video.oncanplay = ... がブラウザ標準のまま動作する)
    for (const type of BRIDGED_EVENT_TYPES) {
        mediaClock.addEventListener(type, () => {
            canvas.dispatchEvent(new Event(type));
        });
    }

    return shim;
}

export default createVideoElementShim;
