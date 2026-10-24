
import IPlaybackEngine from '@/services/player/engine/IPlaybackEngine';


/**
 * plain `<audio>` 要素への委譲だけで `IPlaybackEngine` を満たす軽量アダプター
 *
 * Tesla 車載ブラウザ向けの Broadway.js エンジンでは、映像は WebCodecs/MediaClock のような自前の
 * 再生時刻管理を持たず Broadway.js の decode() 結果を受け取った順に即描画するだけの単純な構造になっている一方、
 * 音声は実在する `<audio>` 要素 (別ストリーム 'tesla-audio' を再生する) がそのまま再生制御の実体を持つ。
 * そのため、DPlayer 側から見た「video 要素」としての再生制御 (play/pause/currentTime/volume 等) は、
 * 単純にこの `<audio>` 要素へ委譲すれば十分であり、MediaClock のような AudioContext 基準点管理は不要
 *
 * videoWidth/videoHeight だけは `<audio>` 要素に存在しない概念のため、Broadway.js の onPictureDecoded で
 * 判明したピクチャサイズを `reportVideoSize()` で都度反映する
 */
class AudioElementPlaybackEngineAdapter extends EventTarget implements IPlaybackEngine {

    private readonly audio: HTMLAudioElement;
    private _videoWidth = 0;
    private _videoHeight = 0;

    constructor(audio: HTMLAudioElement) {
        super();
        this.audio = audio;

        // audio 要素上で発火したイベントをこのアダプター自身にも re-dispatch する
        // (VideoElementShim.ts 側がこのアダプターのイベントを canvas へさらに re-dispatch する)
        const bridged_event_types = [
            'abort', 'canplay', 'canplaythrough', 'durationchange', 'emptied', 'ended', 'error',
            'loadeddata', 'loadedmetadata', 'loadstart', 'pause', 'play', 'playing', 'progress',
            'ratechange', 'resize', 'seeked', 'seeking', 'stalled', 'suspend', 'timeupdate', 'volumechange', 'waiting',
        ];
        for (const type of bridged_event_types) {
            audio.addEventListener(type, () => {
                this.dispatchEvent(new Event(type));
            });
        }
    }

    public get currentTime(): number {
        return this.audio.currentTime;
    }
    public set currentTime(value: number) {
        // ライブ視聴専用でシークには対応しないため、代入自体は無視する
        // (VideoElementShim.ts の requestSeek には空の関数を渡す想定で、ここに来るのは異常系のみ)
        void value;
    }

    public get duration(): number {
        return this.audio.duration;
    }

    public get paused(): boolean {
        return this.audio.paused;
    }

    public get volume(): number {
        return this.audio.volume;
    }
    public set volume(value: number) {
        this.audio.volume = value;
    }

    public get muted(): boolean {
        return this.audio.muted;
    }
    public set muted(value: boolean) {
        this.audio.muted = value;
    }

    public get playbackRate(): number {
        return this.audio.playbackRate;
    }
    public set playbackRate(value: number) {
        this.audio.playbackRate = value;
    }

    public get buffered(): TimeRanges {
        return this.audio.buffered;
    }

    public get readyState(): number {
        return this.audio.readyState;
    }

    public get videoWidth(): number {
        return this._videoWidth;
    }

    public get videoHeight(): number {
        return this._videoHeight;
    }

    public get error(): MediaError | null {
        return this.audio.error;
    }

    public async play(): Promise<void> {
        await this.audio.play();
    }

    public pause(): void {
        this.audio.pause();
    }

    /** Broadway.js の onPictureDecoded でピクチャサイズが判明/変化したときに呼ぶ */
    public reportVideoSize(width: number, height: number): void {
        if (this._videoWidth !== width || this._videoHeight !== height) {
            this._videoWidth = width;
            this._videoHeight = height;
            this.dispatchEvent(new Event('resize'));
        }
    }
}

export default AudioElementPlaybackEngineAdapter;
