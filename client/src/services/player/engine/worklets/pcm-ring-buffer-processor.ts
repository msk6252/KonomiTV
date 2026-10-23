// AudioWorkletGlobalScope は DOM / Worker のどちらの lib 定義とも異なる独立した実行コンテキストで、
// `AudioWorkletProcessor` / `registerProcessor` / `sampleRate` はそのスコープ特有のグローバルのため、
// このファイル単体を型チェック対象から外す (tsconfig の lib を広げて DOM 定義と衝突させるよりも安全)
// @ts-nocheck

/**
 * AudioDecoder が出力した PCM (Float32) を、AudioContext の処理スレッド側で再生し続けるためのリングバッファ
 *
 * メインスレッド (AudioPipeline) が port.postMessage() で PCM チャンクを送り込み、
 * process() が AudioContext のサンプルレートに同期して一定ペースでそれを読み出して出力する。
 * 「実際に読み出した (= 再生された) サンプル数」を一定間隔でメインスレッドに報告することで、
 * MediaClock がそれを基準クロックのドリフト補正に使える
 */
class PcmRingBufferProcessor extends AudioWorkletProcessor {

    // チャンネルごとのリングバッファ本体
    channels = [];
    capacitySamples = 0;

    // リングバッファ上の書き込み・読み出し位置はどちらも capacitySamples で wrap するが、
    // アンカーの時刻計算を wrap の影響を受けさせないため、総書き込み数・総読み出し数は wrap しない値として別途保持する
    totalSamplesWritten = 0;
    totalSamplesRead = 0;

    // { 書き込み時点の totalSamplesWritten, その先頭サンプルのコンテンツ再生時刻(秒) } の履歴
    // 新しい要素ほど末尾に追加される
    anchors = [];

    muted = false;
    lastReportedAt = 0;

    constructor(options) {
        super();
        const numberOfChannels = options.processorOptions.numberOfChannels;
        // 5秒分のリングバッファを確保する (ジッターバッファとしての余裕を持たせる)
        this.capacitySamples = Math.max(1, Math.floor(options.processorOptions.sampleRate * 5));
        for (let c = 0; c < numberOfChannels; c++) {
            this.channels.push(new Float32Array(this.capacitySamples));
        }
        this.port.onmessage = (event) => this.handleMessage(event.data);
    }

    handleMessage(message) {
        if (message.type === 'push') {
            this.pushSamples(message.channelData, message.contentTimeSeconds);
        } else if (message.type === 'reset') {
            this.totalSamplesWritten = 0;
            this.totalSamplesRead = 0;
            this.anchors = [];
        } else if (message.type === 'mute') {
            this.muted = message.muted;
        }
    }

    pushSamples(channelData, contentTimeSeconds) {
        const frameCount = channelData[0].length;
        // 書き込みすぎてリングバッファを一周以上追い越すと破綻するため、追い越す分は書き込み側を諦めて捨てる
        // (本来は AudioPipeline 側が先読み量を見てペース調整すべきだが、安全弁として最終防御を用意する)
        if (frameCount > this.capacitySamples) {
            return;
        }
        this.anchors.push({ totalSamplesAtPush: this.totalSamplesWritten, contentTimeSecondsAtPush: contentTimeSeconds });
        if (this.anchors.length > 64) {
            this.anchors.shift();
        }
        for (let c = 0; c < this.channels.length; c++) {
            const src = channelData[Math.min(c, channelData.length - 1)];
            const dst = this.channels[c];
            for (let i = 0; i < frameCount; i++) {
                dst[(this.totalSamplesWritten + i) % this.capacitySamples] = src[i];
            }
        }
        this.totalSamplesWritten += frameCount;
    }

    /** totalSamplesRead の時点に最も近い (それ以前で最新の) アンカーからコンテンツ再生時刻を算出する */
    resolveContentTimeSeconds() {
        for (let i = this.anchors.length - 1; i >= 0; i--) {
            const anchor = this.anchors[i];
            if (anchor.totalSamplesAtPush <= this.totalSamplesRead) {
                const elapsedSamples = this.totalSamplesRead - anchor.totalSamplesAtPush;
                return anchor.contentTimeSecondsAtPush + elapsedSamples / sampleRate;
            }
        }
        return null;
    }

    process(inputs, outputs) {
        const output = outputs[0];
        const frameCount = output[0].length;
        const buffered = this.totalSamplesWritten - this.totalSamplesRead;
        const available = Math.max(0, Math.min(frameCount, buffered));

        for (let c = 0; c < output.length; c++) {
            const src = this.channels[Math.min(c, this.channels.length - 1)];
            const dst = output[c];
            for (let i = 0; i < available; i++) {
                dst[i] = this.muted ? 0 : src[(this.totalSamplesRead + i) % this.capacitySamples];
            }
            // アンダーラン (バッファ枯渇) 分は無音を出力する
            for (let i = available; i < frameCount; i++) {
                dst[i] = 0;
            }
        }

        this.totalSamplesRead += available;

        // 約250msごとに実際の再生位置 (コンテンツ時刻) をメインスレッドへ報告する
        const now = currentTime;
        if (now - this.lastReportedAt >= 0.25) {
            this.lastReportedAt = now;
            const contentTimeSeconds = this.resolveContentTimeSeconds();
            if (contentTimeSeconds !== null) {
                this.port.postMessage({
                    type: 'anchor',
                    contentTimeSeconds,
                    bufferedSeconds: Math.max(0, buffered) / sampleRate,
                });
            }
        }

        return true;
    }
}

registerProcessor('pcm-ring-buffer-processor', PcmRingBufferProcessor);
