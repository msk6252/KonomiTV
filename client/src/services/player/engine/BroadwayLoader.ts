
/**
 * Broadway.js (client/public/broadway/ に vendoring した Decoder.js / YUVCanvas.js / Player.js) を
 * <script> タグの動的挿入でロードし、window.Player を使えるようにするローダー
 *
 * Broadway.js は npm パッケージとして配布されていない (vendoring 前提のライブラリ) ため、
 * Vite のモジュールバンドル経路には乗せず、ブラウザグローバル (UMD の「それ以外」分岐) として読み込む。
 * Vite のハッシュ付きアセットパイプラインに乗せないのは、Decoder.js 内部に "avc.wasm" という
 * 相対パスの文字列がハードコードされており、ハッシュ化されるとその場所を見失うため
 * (client/public/ はビルド時にハッシュ化されず、そのままのファイル名で配信される)
 */

const BROADWAY_BASE_PATH = '/broadway/';

let loadPromise: Promise<typeof BroadwayPlayer> | null = null;

/** <script> タグを動的に挿入してスクリプトを読み込む */
function loadScript(src: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`BroadwayLoader: failed to load script: ${src}`));
        document.head.appendChild(script);
    });
}

/**
 * Broadway.js の Player クラスをロードする (読み込み済みの場合は何もせず window.Player を返す)
 * 複数回呼び出しても <script> タグは一度だけ挿入される
 */
async function loadBroadwayPlayer(): Promise<typeof BroadwayPlayer> {
    if (loadPromise === null) {
        loadPromise = (async () => {
            // Decoder.js はメインスレッド上でも1個インスタンス化する必要がある (Player.js が Decoder.nowValue を参照するため)
            // メインスレッド上の Decoder.js は WASM バイナリ (avc.wasm) をドキュメントの URL を基準とした相対パスで
            // fetch() しようとするため、Module.locateFile を使って /broadway/ 配下に固定しておく
            // (Worker 側は自身のスクリプト URL (/broadway/Decoder.js) を基準に自動解決されるため、この指定は不要)
            window.Module = {
                locateFile: (path: string) => `${BROADWAY_BASE_PATH}${path}`,
            };
            // Player.js の UMD ブラウザグローバル分岐 (root.Player = factory(root.Decoder, root.YUVCanvas)) が
            // window.Decoder / window.YUVCanvas を要求するため、この順序で読み込む必要がある
            await loadScript(`${BROADWAY_BASE_PATH}Decoder.js`);
            await loadScript(`${BROADWAY_BASE_PATH}YUVCanvas.js`);
            await loadScript(`${BROADWAY_BASE_PATH}Player.js`);
            return window.Player;
        })();
    }
    return loadPromise;
}

export default loadBroadwayPlayer;
export { BROADWAY_BASE_PATH };
