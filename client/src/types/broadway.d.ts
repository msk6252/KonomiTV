/**
 * Broadway.js (H.264 Baseline Profile 用 WebAssembly ソフトウェアデコーダ) の型定義
 *
 * npm パッケージとして配布されていないため、client/public/broadway/ に Decoder.js / Player.js / YUVCanvas.js / avc.wasm を
 * そのままコピー (vendoring) し、<script> タグで読み込んで window.Player としてグローバルに公開した状態で利用する。
 * 型定義は、KonomiTV が実際に使う Player.js の最小限の API サーフェスのみをカバーする (BroadwayLiveVideoSource.ts 参照)。
 *
 * ref: https://github.com/mbebenita/Broadway (BSD-3-Clause)
 */

interface BroadwayPlayerOptions {
    /** true の場合、デコード処理を別スレッド (Web Worker) にオフロードする */
    useWorker?: boolean;
    /** useWorker: true のときに読み込む Worker スクリプトのパス (省略時は "Decoder.js") */
    workerFile?: string;
    /** WebGL でレンダリングするか、WebGL が使えない場合に 2D Canvas の putImageData にフォールバックするか ("auto" で自動判定) */
    webgl?: boolean | 'auto';
    /** false の場合、デコード結果を canvas に描画しない (onPictureDecoded コールバックのみ利用する場合向け) */
    render?: boolean;
}

/** デコード結果のピクチャごとの付加情報 (使用しないフィールドは省略) */
interface BroadwayPictureInfo {
    width: number;
    height: number;
}

declare class BroadwayPlayer {
    constructor(options?: BroadwayPlayerOptions);

    /** Player.js が内部で生成した描画先の <canvas> 要素 (render: false の場合は存在しない) */
    readonly canvas: HTMLCanvasElement;

    /** WebGL レンダリングが実際に使われているかどうか (auto 判定の結果もここに反映される) */
    readonly webgl: boolean;

    /**
     * Annex B 形式 (開始コード付き NAL ユニット列) の H.264 ストリームをデコードする
     * 1回の呼び出しで渡せるデータ量は Broadway.js 内部バッファの上限 (1MiB) を超えないこと
     */
    decode(data: Uint8Array, info?: unknown): void;

    /** デコードが完了し新しいピクチャが得られるたびに呼ばれる (既定では何もしない、上書きして使う) */
    onPictureDecoded: (buffer: Uint8Array, width: number, height: number, infos: BroadwayPictureInfo[]) => void;
}

/** Emscripten が生成する Decoder.js が読み込み時に参照する Module オブジェクト (locateFile のみ使用する) */
interface EmscriptenModuleConfig {
    locateFile?: (path: string) => string;
}

interface Window {
    Player: typeof BroadwayPlayer;
    Module: EmscriptenModuleConfig;
}
