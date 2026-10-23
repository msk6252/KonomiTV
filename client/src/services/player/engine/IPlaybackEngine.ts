
/**
 * DPlayer / KonomiTV 側コードが従来 HTMLVideoElement として扱っていた箇所に代わりに差し込むための
 * 最小限のインターフェース (MediaClock がこれを実装する)
 *
 * HTMLMediaElement と同名のプロパティ・メソッド・イベントのみを持たせることで、既存コードの
 * `this.player.video.currentTime` のような参照を極力そのまま動かせるようにしている
 * (DOM 固有の API である requestPictureInPicture() / textTracks / drawImage() のソースとしての利用等は、
 * このインターフェースの範囲外として各 Manager 側で個別に対応する)
 */
interface IPlaybackEngine extends EventTarget {

    /** 現在の再生位置 (秒) 。設定するとシークになる */
    currentTime: number;

    /** コンテンツの長さ (秒) 。不明な間は NaN */
    readonly duration: number;

    /** 一時停止中かどうか */
    readonly paused: boolean;

    /** 音量 (0.0 ~ 1.0) */
    volume: number;

    /** ミュート中かどうか */
    muted: boolean;

    /** 再生速度 (1.0 が通常速度) */
    playbackRate: number;

    /** バッファ済み範囲 */
    readonly buffered: TimeRanges;

    /** HTMLMediaElement.readyState と同じ意味を持つ値 (0: HAVE_NOTHING ~ 4: HAVE_ENOUGH_DATA) */
    readonly readyState: number;

    /** 現在の映像の幅 (px) 。映像サイズ判明前は 0 */
    readonly videoWidth: number;

    /** 現在の映像の高さ (px) 。映像サイズ判明前は 0 */
    readonly videoHeight: number;

    /** 直前に発生したエラー情報 */
    readonly error: MediaError | null;

    /** 再生を開始する */
    play(): Promise<void>;

    /** 再生を一時停止する */
    pause(): void;
}

export default IPlaybackEngine;
