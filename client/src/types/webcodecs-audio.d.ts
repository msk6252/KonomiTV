/**
 * TypeScript 5.5.4 にバンドルされている lib.dom.d.ts には WebCodecs の映像系 (VideoDecoder 等) は
 * 含まれているが、音声系 (AudioDecoder 等) がまだ含まれていないため、このプロジェクトで使う最小限の範囲だけ
 * アンビエント宣言として補っている (`@types/dom-webcodecs` 的な専用パッケージは存在しないため自前で宣言する)
 *
 * 型定義は W3C WebCodecs 仕様 (https://w3c.github.io/webcodecs/) および、同じ構造を持つ lib.dom.d.ts の
 * VideoDecoder/EncodedVideoChunk/VideoFrame 周りの宣言に合わせている
 */

interface EncodedAudioChunkInit {
    data: AllowSharedBufferSource;
    duration?: number;
    timestamp: number;
    type: EncodedVideoChunkType;
}

interface EncodedAudioChunk {
    readonly byteLength: number;
    readonly duration: number | null;
    readonly timestamp: number;
    readonly type: EncodedVideoChunkType;
    copyTo(destination: AllowSharedBufferSource): void;
}

declare const EncodedAudioChunk: {
    prototype: EncodedAudioChunk;
    new(init: EncodedAudioChunkInit): EncodedAudioChunk;
};

interface AudioDecoderConfig {
    codec: string;
    sampleRate: number;
    numberOfChannels: number;
    description?: AllowSharedBufferSource;
}

interface AudioDataOutputCallback {
    (output: AudioData): void;
}

interface AudioDecoderInit {
    error: WebCodecsErrorCallback;
    output: AudioDataOutputCallback;
}

interface AudioDecoderSupport {
    config?: AudioDecoderConfig;
    supported?: boolean;
}

interface AudioDecoderEventMap {
    'dequeue': Event;
}

interface AudioDecoder extends EventTarget {
    readonly decodeQueueSize: number;
    ondequeue: ((this: AudioDecoder, ev: Event) => any) | null;
    readonly state: CodecState;
    close(): void;
    configure(config: AudioDecoderConfig): void;
    decode(chunk: EncodedAudioChunk): void;
    flush(): Promise<void>;
    reset(): void;
    addEventListener<K extends keyof AudioDecoderEventMap>(type: K, listener: (this: AudioDecoder, ev: AudioDecoderEventMap[K]) => any, options?: boolean | AddEventListenerOptions): void;
    addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void;
    removeEventListener<K extends keyof AudioDecoderEventMap>(type: K, listener: (this: AudioDecoder, ev: AudioDecoderEventMap[K]) => any, options?: boolean | EventListenerOptions): void;
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void;
}

declare const AudioDecoder: {
    prototype: AudioDecoder;
    new(init: AudioDecoderInit): AudioDecoder;
    isConfigSupported(config: AudioDecoderConfig): Promise<AudioDecoderSupport>;
};

type AudioSampleFormat = 'f32' | 'f32-planar' | 's16' | 's16-planar' | 's32' | 's32-planar' | 'u8' | 'u8-planar';

interface AudioDataCopyToOptions {
    format?: AudioSampleFormat;
    frameCount?: number;
    frameOffset?: number;
    planeIndex: number;
}

interface AudioDataInit {
    data: AllowSharedBufferSource;
    format: AudioSampleFormat;
    numberOfChannels: number;
    numberOfFrames: number;
    sampleRate: number;
    timestamp: number;
    transfer?: ArrayBuffer[];
}

interface AudioData {
    readonly format: AudioSampleFormat | null;
    readonly numberOfChannels: number;
    readonly numberOfFrames: number;
    readonly sampleRate: number;
    readonly duration: number;
    readonly timestamp: number;
    allocationSize(options: AudioDataCopyToOptions): number;
    clone(): AudioData;
    close(): void;
    copyTo(destination: AllowSharedBufferSource, options: AudioDataCopyToOptions): void;
}

declare const AudioData: {
    prototype: AudioData;
    new(init: AudioDataInit): AudioData;
};
