
import MediaClock from '@/services/player/engine/MediaClock';

// Vite の `new URL(..., import.meta.url)` パターンで AudioWorklet 用スクリプトを解決する
// (worker-modules.d.ts 的な別プログラムとして扱われ、メインスレッドの DOM lib とは型を共有しない)
const WORKLET_URL = new URL('./worklets/pcm-ring-buffer-processor.ts', import.meta.url);

/**
 * AAC 等のエンコード済み音声チャンクを WebCodecs の AudioDecoder でデコードし、
 * AudioWorkletNode 経由で Web Audio API に出力するパイプライン
 *
 * 実際に再生 (= 時間が進行) している実体はこのパイプラインが担うため、
 * AudioWorkletProcessor から定期的に報告される実測再生位置を MediaClock にフィードバックし、
 * 基準クロックのドリフト補正に使わせる
 */
class AudioPipeline {

    private readonly audioContext: AudioContext;
    private readonly mediaClock: MediaClock;

    private decoder: AudioDecoder | null = null;
    private workletNode: AudioWorkletNode | null = null;
    private gainNode: GainNode | null = null;
    private workletModuleLoaded = false;

    private sampleRate = 48000;
    private numberOfChannels = 2;

    constructor(audioContext: AudioContext, mediaClock: MediaClock) {
        this.audioContext = audioContext;
        this.mediaClock = mediaClock;
    }

    /** AudioWorklet モジュールを読み込む (configure() の前に1回だけ呼ぶ必要がある) */
    public async initialize(): Promise<void> {
        if (this.workletModuleLoaded) {
            return;
        }
        await this.audioContext.audioWorklet.addModule(WORKLET_URL);
        this.workletModuleLoaded = true;
    }

    /** 音声デコーダーを (再) 構築する。コーデック・サンプルレート・チャンネル数が変わった場合に呼ぶ */
    public configure(config: AudioDecoderConfig): void {
        this.closeDecoder();
        this.sampleRate = config.sampleRate;
        this.numberOfChannels = config.numberOfChannels;

        // AudioContext のサンプルレートは OS/ハードウェア依存で固定されており、デコード後の PCM の
        // サンプルレートと異なる場合、本来はリサンプリングが必要になる (未実装、既知の TODO)
        // ARIB 放送の音声は通常 48kHz AAC で、ブラウザの AudioContext も既定で 48kHz のことが多いため
        // Phase 1 では一致する前提で進め、不一致時は警告のみ出す
        if (this.sampleRate !== this.audioContext.sampleRate) {
            console.warn(
                `[AudioPipeline] Audio sample rate (${this.sampleRate}Hz) does not match ` +
                `AudioContext sample rate (${this.audioContext.sampleRate}Hz). Resampling is not implemented yet, ` +
                'so playback pitch/speed may be incorrect.',
            );
        }

        this.decoder = new AudioDecoder({
            output: (audioData) => this.onAudioData(audioData),
            error: (error) => console.error('[AudioPipeline] AudioDecoder error:', error),
        });
        this.decoder.configure(config);
        this.setupWorkletNode();
    }

    private setupWorkletNode(): void {
        if (this.workletNode !== null) {
            this.workletNode.disconnect();
        }
        this.workletNode = new AudioWorkletNode(this.audioContext, 'pcm-ring-buffer-processor', {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [this.numberOfChannels],
            processorOptions: {
                sampleRate: this.sampleRate,
                numberOfChannels: this.numberOfChannels,
            },
        });
        this.workletNode.port.onmessage = (event: MessageEvent) => {
            if (event.data.type === 'anchor') {
                this.mediaClock.reportAudioAnchor(event.data.contentTimeSeconds as number);
            }
        };
        this.gainNode = this.audioContext.createGain();
        this.workletNode.connect(this.gainNode);
        this.gainNode.connect(this.audioContext.destination);
        this.applyVolume();
    }

    /** エンコード済み音声チャンクをデコーダーに投入する */
    public decode(chunkInit: EncodedAudioChunkInit): void {
        if (!this.decoder || this.decoder.state !== 'configured') {
            return;
        }
        this.decoder.decode(new EncodedAudioChunk(chunkInit));
    }

    private onAudioData(audioData: AudioData): void {
        const frameCount = audioData.numberOfFrames;
        const channelData: Float32Array[] = [];
        for (let channel = 0; channel < audioData.numberOfChannels; channel++) {
            const plane = new Float32Array(frameCount);
            audioData.copyTo(plane, { planeIndex: channel, format: 'f32-planar' });
            channelData.push(plane);
        }
        const contentTimeSeconds = audioData.timestamp / 1e6;
        audioData.close();

        this.workletNode?.port.postMessage(
            { type: 'push', channelData, contentTimeSeconds },
            channelData.map((plane) => plane.buffer),
        );
    }

    /** 音量 (0.0~1.0) を反映する */
    public applyVolume(): void {
        if (this.gainNode === null) {
            return;
        }
        // ミュート自体はノイズの少ない無音出力 (Worklet 側の mute) で行い、
        // GainNode は音量スライダーの値をそのまま反映する役割に限定する
        this.gainNode.gain.setValueAtTime(this.mediaClock.muted ? 0 : this.mediaClock.volume, this.audioContext.currentTime);
    }

    /** ミュート状態を反映する (Worklet 側に無音出力させる。GainNode 側の 0 設定と二重になるが、クリック音対策として併用する) */
    public applyMuted(): void {
        this.workletNode?.port.postMessage({ type: 'mute', muted: this.mediaClock.muted });
        this.applyVolume();
    }

    /** デコーダー・リングバッファの両方をリセットする (シーク時に呼ぶ) */
    public async flush(): Promise<void> {
        if (this.decoder && this.decoder.state === 'configured') {
            try {
                await this.decoder.flush();
            } catch {
                // flush 中の close/configure 変更によるエラーは無視してよい
            }
        }
        this.workletNode?.port.postMessage({ type: 'reset' });
    }

    private closeDecoder(): void {
        if (this.decoder && this.decoder.state !== 'closed') {
            this.decoder.close();
        }
        this.decoder = null;
    }

    public destroy(): void {
        this.closeDecoder();
        this.workletNode?.disconnect();
        this.gainNode?.disconnect();
        this.workletNode = null;
        this.gainNode = null;
    }
}

export default AudioPipeline;
